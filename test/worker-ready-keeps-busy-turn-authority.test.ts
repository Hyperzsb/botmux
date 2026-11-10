import { describe, expect, it, vi } from 'vitest';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * A prompt-ready edge that the worker itself turns back into `working` is not
 * the turn's terminal boundary (#1723): the turn is quiet only while its
 * background agents run, or the argv-baked first prompt is still executing.
 * Releasing the turn's authority there revokes the live origin the still
 * running work reports through, so its `botmux report` is refused as stale.
 */
function harness(opts: {
  backgroundAgents?: number;
  argvPromptBusy?: boolean;
  argvPromptNeedsWorkingSeed?: boolean;
  activeTurnStarted?: boolean;
  initialInputOwnershipPending?: boolean;
  pendingMessages?: unknown[];
  queuedTypeAheadTurns?: unknown[];
} = {}) {
  const caller = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'turn-a', caller });
  if (opts.activeTurnStarted !== false) authority.markStarted({ turnId: 'turn-a', caller });
  const scope: Record<string, any> = {
    sessionId: 'sid',
    isPromptReady: false, isFlushing: false, durableTurnInFlight: false,
    preserveActiveTurnAuthorityForReady: false,
    initialInputOwnershipPending: opts.initialInputOwnershipPending === true,
    lastInitConfig: { cliId: 'claude-code' }, effectiveBackendType: 'tmux',
    activeTurnAuthority: authority,
    sandboxRelayCapability: { token: 'old-token', turnId: 'turn-a' },
    sandboxPolicyCapability: 'policy-token',
    currentVcMeetingImTurnOrigin: undefined,
    readIsolationOriginChannelId: undefined,
    unlinkManagedOriginCapabilityFiles: vi.fn(),
    pendingMessages: opts.pendingMessages ?? [], pendingRawInputs: [], pendingAdoptMessages: [], pendingSessionRename: null,
    pendingInjections: [],
    queuedTurnAdvanceConsumedForPrompt: undefined,
    ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: opts.queuedTypeAheadTurns ?? [], promptReadyEdges: 0,
    decideQueuedReadyTransition,
    inflightInputs: { onTurnComplete: vi.fn() },
    backgroundTaskTracker: { pendingTurnAgents: () => opts.backgroundAgents ?? 0 },
    spawnArgvInitialPromptBusy: opts.argvPromptBusy === true,
    spawnArgvNeedsWorkingSeed: opts.argvPromptNeedsWorkingSeed === true,
    renderer: { snapshot: () => ({ content: '' }) },
    idleDetector: { isStartupPending: () => false, adoptPromptReady: vi.fn(), reset: vi.fn() },
    freshnessInputQueue: { onPromptReady: vi.fn() },
    isCodexAppCliId: () => false,
    hasStructuredLifecycleBlock: () => false,
    releaseInterruptedStructuredBridgeOnFirstPrompt: () => {},
    bridgeQueue: { cliQueueDrained: () => {} },
    currentCodexObservedPid: () => {},
    currentInputDeliveryQuarantine: () => false,
    holdForNativeSessionFork: () => false,
    probeStartupBlocker: () => false,
    readyGate: { shouldHold: () => false },
    publishScreenStatus: vi.fn(),
    classifyUsageLimitWithNativeEvidence: () => ({}),
    projectedRuntimeScreenStatus: () => 'idle',
    backgroundWaitPayload: () => ({}),
    flushPending: vi.fn(),
    log: vi.fn(),
  };
  for (const name of ['traexFirstPromptViewportRejects', 'currentPostTerminalInputFence',
    'spawnArgvTurnStartGateHolds', 'syncQueuedTurnsFromMarkerDisk', 'shouldFlushInjectionsFirst']) scope[name] = () => false;
  for (const name of ['stopStructuredStartGraceRecheck', 'stopBusyPatternIdleProbe',
    'judgeClaudeBridgeTurn', 'settleSessionRenameOnPrompt', 'releaseRawInputRestartGate',
    'maybeEmitWorkflowTranscriptOutput', 'send', 'refreshBackgroundWait', 'settleRestartAttemptOnReady',
    'advanceQueuedTypeAheadTurn']) scope[name] = vi.fn();
  scope.completeManagedTurnOriginRevocation = loadWorkerFunction(
    'completeManagedTurnOriginRevocation',
    scope,
  );
  scope.releaseActiveTurnAuthority = vi.fn(loadWorkerFunction(
    'releaseActiveTurnAuthority',
    scope,
  ));
  return scope;
}

describe('a prompt-ready edge that is not the turn boundary keeps the turn authority', () => {
  it('keeps a cold-start opening turn that is reserved but not submitted yet', () => {
    const h = harness({ activeTurnStarted: false, initialInputOwnershipPending: true });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()).toMatchObject({
      turnId: 'turn-a',
      started: false,
    });
  });

  it('keeps the opening turn after init queues it but before the literal CLI write', () => {
    const h = harness({
      activeTurnStarted: false,
      initialInputOwnershipPending: false,
      pendingMessages: [{ content: 'opening prompt', turnId: 'turn-a' }],
    });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()).toMatchObject({
      turnId: 'turn-a',
      started: false,
    });
  });

  it('releases a fast-completed argv opening turn even before late init marks it started', () => {
    const h = harness({
      activeTurnStarted: false,
      initialInputOwnershipPending: true,
      argvPromptNeedsWorkingSeed: true,
    });
    loadWorkerFunction('markPromptReady', h)();

    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.sandboxRelayCapability).toBeNull();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'managed_turn_origin_revoked',
      sessionId: 'sid',
      capability: 'old-token',
      turnId: 'turn-a',
    }));
    expect(h.unlinkManagedOriginCapabilityFiles).toHaveBeenCalledOnce();

    const oldDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = '/tmp';
    try {
      const authorizeManagedSend = loadWorkerFunction('authorizeManagedSend', h);
      expect(authorizeManagedSend({ capability: 'old-token' })).toEqual({
        ok: false,
        error: 'origin_mismatch: relay capability is stale or missing',
      });
    } finally {
      if (oldDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = oldDataDir;
    }
  });

  it('does not preserve an unstarted reservation for a different queued turn', () => {
    const h = harness({
      activeTurnStarted: false,
      initialInputOwnershipPending: false,
      pendingMessages: [{ content: 'different turn', turnId: 'turn-b' }],
    });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
  });

  it('keeps it while background agents of the turn are still running', () => {
    const h = harness({ backgroundAgents: 1 });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(false);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('working');
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');
  });

  it('keeps it while the argv-baked first prompt is still running', () => {
    const h = harness({ argvPromptBusy: true });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(false);
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');
  });

  it.each([
    ['a queued message', { pendingMessages: [{ content: 'next' }] }],
    ['a queued type-ahead turn', { queuedTypeAheadTurns: [{ turnId: 'turn-b' }] }],
  ])('still releases it when the ready hands the CLI to %s', (_label, queued) => {
    const h = harness({ backgroundAgents: 1, ...queued });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
  });

  it('still releases it at a real end-of-turn ready', () => {
    const h = harness();
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
  });
});
