import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delay } from './timing.js';

const execFileAsync = promisify(execFile);

export type StartupProbeClassification = {
  state: 'ready' | 'retryable' | 'fatal';
  reason: string;
};

export type StartupProbeInput = {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
};

export type StartupProbeSpec = {
  args: readonly string[];
  timeoutMs: number;
  maxBuffer: number;
  maxAttempts: number;
  backoffMs: readonly number[];
  classify(input: StartupProbeInput): StartupProbeClassification;
};

export type StartupProbeResult = Omit<StartupProbeClassification, 'state'> & {
  state: StartupProbeClassification['state'] | 'exhausted';
  attempts: number;
  elapsedMs: number;
};

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
  log?: (message: string) => void;
}): Promise<StartupProbeResult> {
  const startedAt = Date.now();
  let last: StartupProbeClassification = { state: 'retryable', reason: 'probe_not_run' };

  for (let attempt = 1; attempt <= input.spec.maxAttempts; attempt += 1) {
    let result: StartupProbeClassification;
    try {
      const output = await execFileAsync(input.bin, [...input.spec.args], {
        cwd: input.cwd,
        env: input.env,
        encoding: 'utf8',
        timeout: input.spec.timeoutMs,
        maxBuffer: input.spec.maxBuffer,
        windowsHide: true,
      });
      result = input.spec.classify({
        status: 0,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    } catch (error: any) {
      result = input.spec.classify({
        status: typeof error?.status === 'number' ? error.status : null,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : '',
        errorCode: typeof error?.code === 'string' ? error.code : undefined,
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
    if (backoff > 0) await delay(backoff);
  }

  return {
    ...last,
    state: 'exhausted',
    attempts: input.spec.maxAttempts,
    elapsedMs: Date.now() - startedAt,
  };
}
