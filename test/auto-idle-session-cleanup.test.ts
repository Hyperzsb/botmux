import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoIdleSessionCleanupBlockReason,
  autoIdleSessionLastActivityAtMs,
  cleanupAutoIdleSessionsAfterTurnDrain,
} from '../src/core/auto-idle-session-cleanup.js';
import {
  __testOnly_resetBotTurnMutationGates,
  withBotTurnAdmission,
} from '../src/core/bot-turn-mutation-gate.js';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const safety = {
  isTransferring: (session: any) => session.transferring === true,
  isLifecycleInFlight: (session: any) => session.lifecycleInFlight === true,
};

function session(id: string, patch: Record<string, unknown> = {}) {
  const lastMessageAt = NOW - 25 * HOUR;
  const base = {
    session: {
      sessionId: id,
      status: 'active',
      createdAt: new Date(lastMessageAt - HOUR).toISOString(),
      lastMessageAt: new Date(lastMessageAt).toISOString(),
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app',
    chatId: `chat-${id}`,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: lastMessageAt - HOUR,
    cliVersion: '',
    lastMessageAt,
    hasHistory: true,
  } as any;
  return Object.assign(base, patch);
}

function closed() {
  return Promise.resolve({
    ok: true as const,
    outcome: 'closed' as const,
    alreadyClosed: false,
    known: true,
  });
}

describe('automatic per-bot idle session cleanup', () => {
  beforeEach(() => __testOnly_resetBotTurnMutationGates());

  it('uses the freshest of runtime, persisted, creation, and spawn timestamps', () => {
    const value = session('freshest', {
      lastMessageAt: NOW - 4 * HOUR,
      spawnedAt: NOW - 8 * HOUR,
    });
    value.session.lastMessageAt = new Date(NOW - 2 * HOUR).toISOString();
    value.session.createdAt = new Date(NOW - 6 * HOUR).toISOString();
    expect(autoIdleSessionLastActivityAtMs(value)).toBe(NOW - 2 * HOUR);
  });

  it('accepts old dormant or explicitly idle sessions and uses a strict cutoff', () => {
    const dormant = session('dormant');
    const resident = session('resident', {
      worker: { killed: false },
      lastScreenStatus: 'idle',
    });
    const working = session('working', {
      worker: { killed: false },
      lastScreenStatus: 'working',
    });
    const exact = session('exact', { lastMessageAt: NOW - 24 * HOUR });
    exact.session.lastMessageAt = new Date(NOW - 24 * HOUR).toISOString();

    expect(autoIdleSessionCleanupBlockReason(dormant, 24, NOW, safety)).toBeUndefined();
    expect(autoIdleSessionCleanupBlockReason(resident, 24, NOW, safety)).toBeUndefined();
    expect(autoIdleSessionCleanupBlockReason(working, 24, NOW, safety)).toBe('not_idle');
    expect(autoIdleSessionCleanupBlockReason(exact, 24, NOW, safety)).toBe('not_expired');
  });

  it.each([
    ['locked', (value: any) => { value.session.locked = true; }],
    ['queued', (value: any) => { value.session.queued = true; }],
    ['repository_setup', (value: any) => { value.pendingRepo = true; }],
    ['initial_start', (value: any) => { value.initialStartPending = true; }],
    ['protected_mutation', (value: any) => { value.session.queuedActivationPending = true; }],
    ['deferred_input', (value: any) => { value.pendingRawInput = '/goal'; }],
    ['tui_prompt', (value: any) => { value.tuiPromptCardId = 'card'; }],
    ['agent_attention', (value: any) => { value.agentAttention = { kind: 'blocked', reason: 'auth', at: NOW }; }],
    ['usage_limited', (value: any) => { value.usageLimit = { type: 'usage_limit' }; }],
    ['remote_retirement', (value: any) => { value.remoteCloseState = { phase: 'preparing', requestId: 'r' }; }],
    ['turn_recovery', (value: any) => { value.session.ordinaryTurnRecovery = { status: 'backoff' }; }],
    ['transferring', (value: any) => { value.transferring = true; }],
    ['lifecycle', (value: any) => { value.lifecycleInFlight = true; }],
  ])('skips %s sessions', (reason, mutate) => {
    const value = session(String(reason));
    mutate(value);
    expect(autoIdleSessionCleanupBlockReason(value, 24, NOW, safety)).toBe(reason);
  });

  it('does nothing when disabled and closes deduplicated candidates oldest first', async () => {
    const old = session('old', { lastMessageAt: NOW - 48 * HOUR });
    old.session.lastMessageAt = new Date(NOW - 48 * HOUR).toISOString();
    const newer = session('newer');
    const active = new Map<string, any>([
      ['old-primary', old],
      ['old-alias', old],
      ['newer', newer],
    ]);
    const close = vi.fn(async () => closed());

    expect(await cleanupAutoIdleSessionsAfterTurnDrain(
      'app', active, () => undefined, close as any, safety, { now: () => NOW },
    )).toMatchObject({ enabled: false, matched: 0, closed: 0 });

    const result = await cleanupAutoIdleSessionsAfterTurnDrain(
      'app', active, () => 24, close as any, safety, { now: () => NOW },
    );
    expect(close.mock.calls.map(call => call[0])).toEqual(['old', 'newer']);
    expect(close.mock.calls.every(call => call[1] === 'automatic idle session cleanup')).toBe(true);
    expect(result).toMatchObject({ enabled: true, olderThanHours: 24, matched: 2, closed: 2, failed: 0 });
  });

  it('revalidates activity and config after an admitted turn drains', async () => {
    const value = session('race');
    const active = new Map<string, any>([['race', value]]);
    const close = vi.fn(async () => closed());
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const admissionStarted = new Promise<void>(resolve => { started = resolve; });
    let hours: number | undefined = 24;

    const admission = withBotTurnAdmission('app', async () => {
      started();
      await held;
      value.lastMessageAt = NOW;
      value.session.lastMessageAt = new Date(NOW).toISOString();
      hours = undefined;
    });
    await admissionStarted;
    const cleanup = cleanupAutoIdleSessionsAfterTurnDrain(
      'app', active, () => hours, close as any, safety,
      { now: () => NOW, mutationAcquireTimeoutMs: 1_000 },
    );
    release();
    await admission;

    expect(await cleanup).toMatchObject({ matched: 1, closed: 0, skipped: 1 });
    expect(close).not.toHaveBeenCalled();
  });

  it('counts refused and residual closes separately', async () => {
    const active = new Map<string, any>([
      ['failed', session('failed', { lastMessageAt: NOW - 48 * HOUR })],
      ['residual', session('residual', { lastMessageAt: NOW - 36 * HOUR })],
    ]);
    for (const value of active.values()) {
      value.session.lastMessageAt = new Date(value.lastMessageAt).toISOString();
    }
    const result = await cleanupAutoIdleSessionsAfterTurnDrain(
      'app',
      active,
      () => 24,
      async id => id === 'failed'
        ? { ok: false, alreadyClosed: false, error: 'cancel_failed', taskId: 'remote-1' } as any
        : {
            ok: true,
            outcome: 'closed_with_residual',
            residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-2' },
            alreadyClosed: false,
            known: true,
          },
      safety,
      { now: () => NOW },
    );
    expect(result).toMatchObject({ matched: 2, closed: 1, residual: 1, failed: 1 });
  });
});
