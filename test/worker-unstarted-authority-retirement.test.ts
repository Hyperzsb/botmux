import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { pendingInputAllowsTypeAhead, pendingInputMayFlush } from '../src/utils/pending-input-queue.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const caller = {
  requestUserOpenId: 'owner',
  requestLarkAppId: 'app',
  senderType: 'user' as const,
};

function retirementScope(opts: {
  turnId?: string;
  dispatchAttempt?: number;
  started?: boolean;
} = {}) {
  const turnId = opts.turnId ?? 'turn-a';
  const dispatchAttempt = opts.dispatchAttempt ?? 4;
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId, dispatchAttempt, caller });
  if (opts.started) authority.markStarted({ turnId, dispatchAttempt, caller });
  const scope: Record<string, any> = {
    sessionId: 'sid',
    activeTurnAuthority: authority,
    sandboxRelayCapability: { token: 'old-token', turnId, dispatchAttempt },
    sandboxPolicyCapability: 'policy-token',
    currentVcMeetingImTurnOrigin: undefined,
    readIsolationOriginChannelId: undefined,
    unlinkManagedOriginCapabilityFiles: vi.fn(),
    send: vi.fn(),
    log: vi.fn(),
    queueMicrotask: vi.fn(),
  };
  scope.completeManagedTurnOriginRevocation = loadWorkerFunction(
    'completeManagedTurnOriginRevocation',
    scope,
  );
  scope.releaseActiveTurnAuthority = vi.fn(loadWorkerFunction(
    'releaseActiveTurnAuthority',
    scope,
  ));
  scope.releaseUnstartedAuthorityForRemovedInput = loadWorkerFunction(
    'releaseUnstartedAuthorityForRemovedInput',
    scope,
  );
  return scope;
}

function expectOriginRevoked(scope: Record<string, any>, turnId: string, dispatchAttempt: number): void {
  expect(scope.activeTurnAuthority.snapshot()).toBeUndefined();
  expect(scope.sandboxRelayCapability).toBeNull();
  expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'managed_turn_origin_revoked',
    sessionId: 'sid',
    capability: 'old-token',
    turnId,
    dispatchAttempt,
  }));
  expect(scope.unlinkManagedOriginCapabilityFiles).toHaveBeenCalledOnce();

  process.env.SESSION_DATA_DIR = '/tmp';
  expect(loadWorkerFunction('authorizeManagedSend', scope)({ capability: 'old-token' })).toEqual({
    ok: false,
    error: 'origin_mismatch: relay capability is stale or missing',
  });
}

function rejectedFlushHarness() {
  const scope = retirementScope();
  const item = {
    content: 'opening prompt',
    turnId: 'turn-a',
    dispatchAttempt: 4,
    trustedCaller: caller,
  };
  Object.assign(scope, {
    isPromptReady: false,
    isFlushing: false,
    durableTurnInFlight: false,
    preserveActiveTurnAuthorityForReady: false,
    initialInputOwnershipPending: false,
    spawnArgvNeedsWorkingSeed: false,
    spawnArgvInitialPromptBusy: false,
    lastInitConfig: { cliId: 'claude-code' },
    effectiveBackendType: 'tmux',
    backend: {},
    cliAdapter: {},
    cliRestartInProgress: false,
    pendingMessages: [item],
    pendingRawInputs: [],
    pendingAdoptMessages: [],
    pendingSessionRename: null,
    pendingInjections: [],
    commandLineWritesPending: 0,
    injectionFlushing: false,
    bareShellLaunchBlocked: false,
    remoteRunnerRecoveredTurnInFlight: false,
    ambiguousSubmissionRecoveryHold: null,
    rpcLifecycleFailClosedOwners: new Set(),
    isSettlingFirstFlush: false,
    awaitingPostSessionStartPromptEvidence: false,
    bridgeJsonlPath: undefined,
    queuedTurnAdvanceConsumedForPrompt: undefined,
    queuedTypeAheadTurns: [],
    promptReadyEdges: 0,
    ptyOutputGeneration: { snapshot: () => 1 },
    decideQueuedReadyTransition,
    inflightInputs: { onTurnComplete: vi.fn() },
    backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    renderer: { snapshot: () => ({ content: '' }) },
    idleDetector: { isStartupPending: () => false, adoptPromptReady: vi.fn(), reset: vi.fn() },
    freshnessInputQueue: {
      onPromptReady: vi.fn(),
      takeNormal: vi.fn(() => scope.pendingMessages.shift()),
    },
    workerSessionEventScope: {
      canSubmit: vi.fn(() => false),
      enterTurn: vi.fn(),
    },
    hasCurrentSessionRuntime: () => true,
    nativeSessionForkPending: () => false,
    codexModelMigrationCheckNeeded: () => false,
    shouldHoldCodexRunnerInput: () => false,
    currentInputDeliveryQuarantine: () => false,
    hasPendingInputForFlush: () => scope.pendingMessages.length > 0,
    resetTraexAutoModelBeforePendingTurn: () => false,
    sessionRenameInFlight: () => false,
    shouldDeferUserFlush: () => false,
    hookReviewHoldsQueuedWrite: () => false,
    pendingInputMayFlush,
    pendingInputAllowsTypeAhead,
    probeStartupBlocker: () => false,
    readyGate: { shouldHold: () => false },
    codexBridgeFallbackActive: () => false,
    runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }),
    directRpcTurnBlocksTypeAhead: () => false,
    crossPrincipalIsolationOn: () => false,
    promotePendingHumanInterruption: () => false,
    CodexAppFlushPromptReplay: class { consumeAfterFlush() { return false; } },
    bareShellChecked: true,
    firstWriteMayProceed: () => true,
    hasRunStartupCommands: true,
    traexAutoModelRuntimeEligible: () => false,
    beginCliWriteCycle: vi.fn(() => { scope.isPromptReady = false; }),
    isCodexAppCliId: () => false,
    hasStructuredLifecycleBlock: () => false,
    releaseInterruptedStructuredBridgeOnFirstPrompt: () => {},
    bridgeQueue: { cliQueueDrained: () => {} },
    currentCodexObservedPid: () => {},
    holdForNativeSessionFork: () => false,
    publishScreenStatus: vi.fn(),
    classifyUsageLimitWithNativeEvidence: () => ({}),
    projectedRuntimeScreenStatus: () => 'idle',
    backgroundWaitPayload: () => ({}),
  });
  for (const name of [
    'traexFirstPromptViewportRejects',
    'currentPostTerminalInputFence',
    'spawnArgvTurnStartGateHolds',
    'syncQueuedTurnsFromMarkerDisk',
    'shouldFlushInjectionsFirst',
  ]) scope[name] = () => false;
  for (const name of [
    'stopStructuredStartGraceRecheck',
    'stopBusyPatternIdleProbe',
    'judgeClaudeBridgeTurn',
    'settleSessionRenameOnPrompt',
    'releaseRawInputRestartGate',
    'maybeEmitWorkflowTranscriptOutput',
    'refreshBackgroundWait',
    'settleRestartAttemptOnReady',
    'advanceQueuedTypeAheadTurn',
  ]) scope[name] = vi.fn();
  scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
  scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', scope);
  scope.flushPending = loadWorkerFunction('flushPending', scope);
  scope.markPromptReady = loadWorkerFunction('markPromptReady', scope);
  return scope;
}

afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
});

describe('queue removal retires only an exact unstarted authority', () => {
  it('revokes the preserved opening origin when reconciliation rejects it before the CLI write', async () => {
    const scope = rejectedFlushHarness();

    scope.markPromptReady();

    await vi.waitFor(() => {
      expect(scope.send).toHaveBeenCalledWith({
        type: 'turn_input_rejected',
        turnId: 'turn-a',
        dispatchAttempt: 4,
        reason: 'execution_reconciliation_required',
      });
    });
    expect(scope.releaseActiveTurnAuthority).toHaveBeenCalledWith(
      'queued input rejected before CLI write',
      { turnId: 'turn-a', dispatchAttempt: 4 },
    );
    expect(scope.pendingMessages).toEqual([]);
    expect(scope.workerSessionEventScope.enterTurn).not.toHaveBeenCalled();
    expectOriginRevoked(scope, 'turn-a', 4);
  });

  it('revokes an expired durable reservation before acknowledging queued removal', async () => {
    const scope = retirementScope();
    const unrelated = { content: 'next', turnId: 'turn-b', dispatchAttempt: 1 };
    Object.assign(scope, {
      lastInitConfig: { cliId: 'claude-code' },
      isCodexAppCliId: () => false,
      pendingMessages: [
        { content: 'scheduled work', turnId: 'turn-a', dispatchAttempt: 4 },
        unrelated,
      ],
      durableTurnInFlight: false,
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      backend: {},
      ambiguousSubmissionRecoveryHold: null,
      inflightInputs: { onTurnComplete: vi.fn() },
      restartCliProcess: vi.fn(),
    });
    scope.retireCodexAppDispatchForDurableReplay = loadWorkerFunction(
      'retireCodexAppDispatchForDurableReplay',
      scope,
    );
    const handle = loadWorkerMessageHandler('expire_durable_turn', scope);

    await handle({ type: 'expire_durable_turn', turnId: 'turn-a', dispatchAttempt: 4 });

    expect(scope.pendingMessages).toEqual([unrelated]);
    expectOriginRevoked(scope, 'turn-a', 4);
    const messages = scope.send.mock.calls.map(([message]: any[]) => message);
    expect(messages.findIndex((message: any) => message.type === 'managed_turn_origin_revoked'))
      .toBeLessThan(messages.findIndex((message: any) => message.type === 'durable_expiry_ready'));
    expect(messages).toContainEqual({
      type: 'durable_expiry_ready',
      sessionId: 'sid',
      turnId: 'turn-a',
      dispatchAttempt: 4,
      disposition: 'queued_removed',
    });
    expect(scope.restartCliProcess).not.toHaveBeenCalled();
  });

  it('does not revoke a started turn or a different dispatch attempt', () => {
    const started = retirementScope({ started: true });
    expect(started.releaseUnstartedAuthorityForRemovedInput('test', {
      turnId: 'turn-a', dispatchAttempt: 4,
    })).toBe(false);
    expect(started.activeTurnAuthority.snapshot()).toMatchObject({ started: true });
    expect(started.sandboxRelayCapability).toMatchObject({ token: 'old-token' });

    const newerAttempt = retirementScope({ dispatchAttempt: 5 });
    expect(newerAttempt.releaseUnstartedAuthorityForRemovedInput('test', {
      turnId: 'turn-a', dispatchAttempt: 4,
    })).toBe(false);
    expect(newerAttempt.activeTurnAuthority.snapshot()).toMatchObject({
      turnId: 'turn-a', dispatchAttempt: 5, started: false,
    });
    expect(newerAttempt.sandboxRelayCapability).toMatchObject({ token: 'old-token' });
  });
});
