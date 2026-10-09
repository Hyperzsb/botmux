import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTraexStartupProbeForTest, createTraexAdapter } from '../src/adapters/cli/traex.js';
import { runStartupProbe } from '../src/utils/startup-probe.js';

describe('TRAEX startup probe classification', () => {
  it('accepts only a completed real model turn with the expected canary', () => {
    expect(classifyTraexStartupProbeForTest({
      status: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"probe"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
        '{"type":"turn.completed"}',
      ].join('\n'),
      stderr: '',
    })).toEqual({ state: 'ready', reason: 'model_turn_completed' });
  });

  it('rejects a cached model catalogue and an incomplete canary turn', () => {
    expect(classifyTraexStartupProbeForTest({
      status: 0,
      stdout: '[{"name":"gpt-5.6-sol"}]',
      stderr: '',
    })).toEqual({ state: 'retryable', reason: 'incomplete_model_turn' });
    expect(classifyTraexStartupProbeForTest({
      status: 0,
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
      stderr: '',
    })).toEqual({ state: 'retryable', reason: 'incomplete_model_turn' });
  });

  it('rejects malformed, tool-using, failed, out-of-order, or non-exact canary output', () => {
    for (const stdout of [
      [
        '{"type":"turn.started"}',
        'not-json',
        '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
        '{"type":"turn.completed"}',
      ].join('\n'),
      [
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"command_execution","text":"BOTMUX_AUTH_OK"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
        '{"type":"turn.completed"}',
      ].join('\n'),
      [
        '{"type":"turn.started"}',
        '{"type":"turn.failed","error":{"message":"login failed"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
        '{"type":"turn.completed"}',
      ].join('\n'),
      [
        '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
        '{"type":"turn.started"}',
        '{"type":"turn.completed"}',
      ].join('\n'),
      [
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"prefix BOTMUX_AUTH_OK suffix"}}',
        '{"type":"turn.completed"}',
      ].join('\n'),
    ]) {
      expect(classifyTraexStartupProbeForTest({ status: 0, stdout, stderr: '' }).state).not.toBe('ready');
    }
  });

  it('treats transport failures as retryable', () => {
    expect(classifyTraexStartupProbeForTest({
      status: null,
      stdout: '',
      stderr: 'SSL connection timeout',
      errorCode: 'ETIMEDOUT',
    })).toEqual({ state: 'retryable', reason: 'network_or_timeout' });
  });

  it('treats auth rejection as fatal', () => {
    expect(classifyTraexStartupProbeForTest({
      status: 403,
      stdout: '',
      stderr: 'Forbidden',
    })).toEqual({ state: 'fatal', reason: 'auth_or_entitlement_rejected' });
    expect(classifyTraexStartupProbeForTest({
      status: 1,
      stdout: '',
      stderr: 'failed to exchange CloudIDE token: 403 Forbidden',
    })).toEqual({ state: 'fatal', reason: 'auth_or_entitlement_rejected' });
  });

  it('retries service-account activation and CloudIDE exchange failures', () => {
    for (const stderr of [
      'Please use /login to sign in first.',
      'Trae authentication did not become active after Codebase Git login',
      'failed to exchange CloudIDE token',
    ]) {
      expect(classifyTraexStartupProbeForTest({
        status: 1,
        stdout: '',
        stderr,
      })).toEqual({ state: 'retryable', reason: 'service_auth_not_active' });
    }
  });

  it('builds an ephemeral real-turn probe for the selected model', () => {
    const spec = createTraexAdapter('/bin/traex').startupProbe!;
    expect(typeof spec.args).toBe('function');
    const args = typeof spec.args === 'function'
      ? spec.args({ model: 'GPT-5.6-Luna', reasoningEffort: 'xhigh' })
      : spec.args;
    expect(args).toEqual(expect.arrayContaining([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--model',
      'GPT-5.6-Luna',
      '-c',
      'model_reasoning_effort="xhigh"',
    ]));
    expect(args).not.toContain('models');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toEqual(expect.arrayContaining([
      '--sandbox', 'read-only', '--disallowed-tool', 'Bash',
    ]));
    expect(args.join(' ')).toContain('BOTMUX_AUTH_OK');
    expect(spec.maxAttempts).toBe(3);
  });

  it('keeps TraeX ToolHome injection and lazily gates persistent reattach', () => {
    const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const toolHomeBlock = worker.slice(
      worker.indexOf('// ── Per-user CLI-tool auth isolation'),
      worker.indexOf('// TRAE\'s TUI can render its composer'),
    );
    expect(toolHomeBlock).not.toContain("cliAdapter.id !== 'traex'");
    expect(toolHomeBlock).toContain('childEnv.HOME = toolHome');
    expect(toolHomeBlock).toContain('childEnv.BOTMUX_TOOL_HOME = toolHome');

    const probeBlock = worker.slice(
      worker.indexOf('// TRAE\'s TUI can render its composer'),
      worker.indexOf('const hermesUsesBotmuxSessionProfile'),
    );
    expect(probeBlock).not.toContain('&& !willReattachPersistent');
    expect(probeBlock).toContain('persistent reattach armed for lazy runtime refresh + model-turn verification');
    expect(probeBlock).toContain('hasTraeServiceAuth(probeEnv)');
    expect(probeBlock).toContain("startupHealthGate.markAuthFailure('fatal')");
    expect(worker).toContain("if (startupHealthGate.state === 'pending') {");
    expect(worker).toContain('void runPlannedStartupHealthProbe({');
    expect(worker).toContain("startupHealthGate.state === 'pending'");
    expect(worker).toContain('&& hasPendingInputForFlush()');
    expect(worker).toContain('refreshing persistent TRAE pane before model-turn verification');
    expect(worker).toContain("preservePending: true");
  });

  it('starts a fresh TUI before the bounded canary without weakening the gate', () => {
    const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const probeBlock = worker.slice(
      worker.indexOf('// TRAE\'s TUI can render its composer'),
      worker.indexOf('const hermesUsesBotmuxSessionProfile'),
    );
    expect(probeBlock).toContain('fresh startup armed for post-prompt model-turn verification');
    expect(probeBlock).not.toContain('await runPlannedStartupHealthProbe();');
    expect(worker).toContain('startupHealthGate.markUiReady();');
    expect(worker).toContain('startupHealthGate.isUiReady || startupHealthProbePlan?.refreshPersistentPaneBeforeProbe');
    expect(worker).toContain("markAuthFailure(probe.state === 'fatal' ? 'fatal' : 'exhausted')");
    expect(worker).not.toContain('scheduleStartupHealthProbeRetry');
  });

  it('passes the selected runtime context to a dynamic probe argv builder', async () => {
    let observedContext: { model?: string; reasoningEffort?: string } | undefined;
    const output = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"BOTMUX_AUTH_OK"}}',
      '{"type":"turn.completed"}',
      '',
    ].join('\n');
    const result = await runStartupProbe({
      bin: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      context: { model: 'GPT-5.6-Luna', reasoningEffort: 'xhigh' },
      spec: {
        args: (context) => {
          observedContext = context;
          return ['-e', `process.stdout.write(${JSON.stringify(output)})`];
        },
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
        maxAttempts: 1,
        backoffMs: [],
        classify: classifyTraexStartupProbeForTest,
      },
    });
    expect(result).toMatchObject({ state: 'ready', attempts: 1, reason: 'model_turn_completed' });
    expect(observedContext).toEqual({ model: 'GPT-5.6-Luna', reasoningEffort: 'xhigh' });
  });

  it('cancels an in-flight probe generation without retrying', async () => {
    const abortController = new AbortController();
    const startedAt = Date.now();
    const resultPromise = runStartupProbe({
      bin: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      signal: abortController.signal,
      spec: {
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 30_000,
        maxBuffer: 1024 * 1024,
        maxAttempts: 3,
        backoffMs: [2_000],
        classify: classifyTraexStartupProbeForTest,
      },
    });
    setTimeout(() => abortController.abort(), 50);
    await expect(resultPromise).resolves.toMatchObject({ state: 'cancelled', reason: 'probe_cancelled', attempts: 1 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('maps numeric execFile error.code to the classifier exit status', async () => {
    let observedStatus: number | null | undefined;
    const result = await runStartupProbe({
      bin: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      spec: {
        args: ['-e', 'process.exit(7)'],
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
        maxAttempts: 1,
        backoffMs: [],
        classify: (input) => {
          observedStatus = input.status;
          return { state: 'fatal', reason: 'observed' };
        },
      },
    });
    expect(observedStatus).toBe(7);
    expect(result).toMatchObject({ state: 'fatal', attempts: 1 });
  });
});
