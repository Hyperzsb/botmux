import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delay } from './timing.js';

const execFileAsync = promisify(execFile);

export type StartupProbeClassification = {
  state: 'ready' | 'retryable' | 'fatal';
  reason: string;
};

export type StartupProbeInput = {
  /** Process exit code. Node's execFile reports this as numeric error.code for
   *  ordinary non-zero exits; some wrappers expose error.status instead. */
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  killed?: boolean;
  signal?: string;
};

export type StartupProbeContext = {
  /** Effective model selected for the CLI generation being admitted. */
  model?: string;
  /** Effective reasoning effort selected for that model. */
  reasoningEffort?: string;
};

export type StartupProbeSpec = {
  args: readonly string[] | ((context: StartupProbeContext) => readonly string[]);
  timeoutMs: number;
  maxBuffer: number;
  maxAttempts: number;
  backoffMs: readonly number[];
  classify(input: StartupProbeInput): StartupProbeClassification;
};

export type StartupProbeResult = Omit<StartupProbeClassification, 'state'> & {
  state: StartupProbeClassification['state'] | 'exhausted' | 'cancelled';
  attempts: number;
  elapsedMs: number;
};

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!signal) {
    await delay(ms);
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute a short-lived CLI-owned health probe.  The probe receives the exact
 * child environment that the real CLI will receive, but its stdout/stderr are
 * never copied into user-visible logs because they may contain auth details.
 */
export async function runStartupProbe(input: {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spec: StartupProbeSpec;
  context?: StartupProbeContext;
  signal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<StartupProbeResult> {
  const startedAt = Date.now();
  let last: StartupProbeClassification = { state: 'retryable', reason: 'probe_not_run' };

  for (let attempt = 1; attempt <= input.spec.maxAttempts; attempt += 1) {
    if (input.signal?.aborted) {
      return { state: 'cancelled', reason: 'probe_cancelled', attempts: attempt - 1, elapsedMs: Date.now() - startedAt };
    }
    let result: StartupProbeClassification;
    try {
      const args = typeof input.spec.args === 'function'
        ? input.spec.args(input.context ?? {})
        : input.spec.args;
      const output = await execFileAsync(input.bin, [...args], {
        cwd: input.cwd,
        env: input.env,
        encoding: 'utf8',
        timeout: input.spec.timeoutMs,
        maxBuffer: input.spec.maxBuffer,
        windowsHide: true,
        killSignal: 'SIGKILL',
        signal: input.signal,
      });
      result = input.spec.classify({
        status: 0,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    } catch (error: any) {
      if (input.signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        return { state: 'cancelled', reason: 'probe_cancelled', attempts: attempt, elapsedMs: Date.now() - startedAt };
      }
      const rawCode = error?.code;
      result = input.spec.classify({
        status: typeof error?.status === 'number'
          ? error.status
          : typeof rawCode === 'number'
            ? rawCode
            : null,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : '',
        errorCode: typeof rawCode === 'string' ? rawCode : undefined,
        killed: error?.killed === true,
        signal: typeof error?.signal === 'string' ? error.signal : undefined,
      });
    }

    last = result;
    input.log?.(`[startup-probe] attempt=${attempt}/${input.spec.maxAttempts} state=${result.state} reason=${result.reason}`);
    if (result.state !== 'retryable' || attempt >= input.spec.maxAttempts) {
      return {
        ...result,
        state: result.state === 'retryable' ? 'exhausted' : result.state,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const backoff = input.spec.backoffMs[Math.min(attempt - 1, input.spec.backoffMs.length - 1)] ?? 0;
    if (backoff > 0 && !(await abortableDelay(backoff, input.signal))) {
      return { state: 'cancelled', reason: 'probe_cancelled', attempts: attempt, elapsedMs: Date.now() - startedAt };
    }
  }

  return {
    ...last,
    state: 'exhausted',
    attempts: input.spec.maxAttempts,
    elapsedMs: Date.now() - startedAt,
  };
}
