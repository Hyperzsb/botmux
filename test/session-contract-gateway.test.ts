import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController, controllerForSession } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { PersistentTurnResultStore } from '../src/services/persistent-turn-result-store.js';
import { outputSnapshot, UniversalOutputHandoff, type OutputSnapshot } from '../src/services/universal-output-handoff.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';
import { confirmedRuntimeIdentityChanged, reusableRuntimeIdentity, sameWorker, sameRuntime } from '../src/services/session-contract.js';
import { RestartCoordinator } from '../src/core/restart-coordinator.js';
import { registerSessionContractPrimary } from '../src/core/session-contract-primary.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'contract-gateway-')); directories.push(data);
  fixtureConfig.dataDir = data;
  const appId = 'cli_gateway_test'; const ref = { appId, sessionId: 'session-test' };
  const store = new SessionContractStore(data, appId); handles.push(store);
  const ds = { larkAppId: appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store); const worker = controller.bindWorker(1).worker;
  const runtime = controller.reserveBinding('binding-old', worker);
  controller.bindRuntime('binding-old', worker, { backend: 'tmux', physicalId: '111:start1', nativeSessionId: 'native1', proof: 'process_start' });
  const context = (sequence: number, scope: any = { runtime }) => ({ version: 2 as const, session: ref, producer: worker, eventId: `${worker.workerId}:${sequence}`, sequence, scope });
  return { data, appId, ref, store, ds, controller, worker, runtime, context };
}
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

describe('contract gateway and real worker boundaries', () => {
  it('does not upgrade an old runtime scope through a newer pending binding', () => {
    const s = fixture(); const execution = s.controller.admitInput('known-turn'); s.controller.reserveBinding('new-pending', s.worker);
    const before = s.store.read(s.ref)!.revision;
    const message = { type: 'managed_turn_origin', turnId: 'known-turn', sessionContract: { ...s.context(1, { runtime: s.runtime, execution }), bindingId: 'new-pending' } };
    expect(s.controller.ingest(message, s.worker)).toMatchObject({ kind: 'reject', reason: 'runtime_binding_scope_mismatch' });
    expect(s.store.deferredEvents(s.ref, 'new-pending')).toEqual([]); expect(s.store.read(s.ref)!.revision).toBe(before);
  });
  it.each([false, true])('restores the surviving runtime when overlapping starts abort in either order (newestFirst=%s)', newestFirst => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const old = scope.beginRuntime(); scope.assign(old.bindingId, s.runtime);
    const a = scope.beginRuntime(); const b = scope.beginRuntime();
    for (const binding of newestFirst ? [b, a] : [a, b]) scope.restoreAfterAbortedStart(binding);
    expect(scope.currentBinding()).toBe(old);
    expect(admitSessionCommand('restart', { version: 2, runtime: s.runtime, operationId: 'restart' }, scope.currentBinding()?.runtime, 'restart').allowed).toBe(true);
  });
  it.each(['transaction_failure', 'lost_ack'] as const)('retries no-spawn evidence until the host confirms durable abandonment (%s)', condition => {
    vi.useFakeTimers(); const s = fixture(); const workerScope = new WorkerSessionEventScope(s.ref, s.worker);
    const old = workerScope.beginRuntime(); workerScope.assign(old.bindingId, s.runtime);
    const aborted = workerScope.beginRuntime(); s.controller.reserveBinding(aborted.bindingId, s.worker);
    workerScope.restoreAfterAbortedStart(aborted);
    const env: any = { workerSessionEventScope: workerScope };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
    let dropAck = condition === 'lost_ack';
    const worker = { send: vi.fn((message: any) => { if (dropAck) { dropAck = false; return; } void receive(message); }) }; s.ds.worker = worker as any;
    const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope);
    const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    if (condition === 'transaction_failure') db.exec("CREATE TRIGGER fail_abort BEFORE INSERT ON events WHEN NEW.type='runtime_lost' BEGIN SELECT RAISE(ABORT,'abort_failed'); END");
    const pending: Promise<void>[] = []; const report = vi.fn(() => { pending.push(host(metadata({ type: 'runtime_binding_aborted', bindingId: aborted.bindingId }))); });
    workerScope.reportAbortedStart(aborted, report);
    return (async () => {
      await Promise.all(pending);
      if (condition === 'transaction_failure') {
        expect(s.store.binding(s.ref, aborted.bindingId)?.phase).toBe('starting');
        expect(s.controller.bindingMayStart(aborted.bindingId)).toBe(false);
        expect(worker.send).not.toHaveBeenCalled();
        db.exec('DROP TRIGGER fail_abort');
        s.ds = { ...s.ds, session: structuredClone(s.ds.session) }; s.store.close();
        const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
        hostScope.sessionController = new SessionController(s.ds, reopened); hostScope.ds = s.ds;
      }
      await vi.advanceTimersByTimeAsync(1_001); await Promise.all(pending);
      expect(report).toHaveBeenCalledTimes(2);
      expect(hostScope.sessionController.store.binding(s.ref, aborted.bindingId)?.phase).toBe('stopped');
      expect(hostScope.sessionController.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
      const sent = report.mock.calls.length; await vi.advanceTimersByTimeAsync(5_000); expect(report).toHaveBeenCalledTimes(sent);
      await host(workerScope.run(old, () => metadata({ type: 'claude_exit', code: 1 })));
      expect(hostScope.handleLegacyWorkerMessage).toHaveBeenCalledOnce();
    })();
  });
  it.each(['managed_turn_origin', 'managed_turn_origin_revoked'])('rejects an unadmitted %s before persisting a deferred event', type => {
    const s = fixture(); s.controller.reserveBinding('unbound-start', s.worker);
    const execution = { executionId: 'not-admitted', turnId: 'unknown-turn', dispatchAttempt: 1 };
    const before = s.store.read(s.ref)!.revision;
    const admission = s.controller.ingest({ type, turnId: execution.turnId, dispatchAttempt: 1,
      sessionContract: { ...s.context(1, { execution }), bindingId: 'unbound-start' } }, s.worker);
    expect(admission.kind).toBe('reject');
    expect(s.store.deferredEvents(s.ref, 'unbound-start')).toEqual([]);
    expect(s.store.executions(s.ref)).toEqual([]); expect(s.store.read(s.ref)!.revision).toBe(before);
  });
  it('removes a rejected deferred authority record left by an earlier boot', async () => {
    const s = fixture(); s.controller.reserveBinding('old-poison', s.worker);
    const context = { ...s.context(1, { execution: { executionId: 'not-admitted', turnId: 'unknown-turn' } }), bindingId: 'old-poison' };
    s.store.deferEvent(s.ref, 'old-poison', context.eventId, context.sequence, { type: 'managed_turn_origin_revoked', turnId: 'unknown-turn', sessionContract: context });
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope); scope.handleWorkerMessage = handler;
    await handler({ type: 'runtime_binding', bindingId: 'old-poison', identity: { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' },
      sessionContract: { ...s.context(2, {}), bindingId: 'old-poison' } });
    expect(s.store.deferredEvents(s.ref, 'old-poison')).toEqual([]); expect(s.store.executions(s.ref)).toEqual([]);
    expect(scope.handleLegacyWorkerMessage).not.toHaveBeenCalled();
  });
  it('does not let a rejected message discard another deferred event with the same id', async () => {
    const s = fixture(); const execution = s.controller.admitInput('known-turn'); s.controller.reserveBinding('legitimate-pending', s.worker);
    const context = { ...s.context(1, { execution }), bindingId: 'legitimate-pending' };
    const message = { type: 'managed_turn_origin', turnId: 'known-turn', sessionContract: context };
    expect(s.controller.ingest(message, s.worker).kind).toBe('defer');
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope);
    await handler({ ...message, sessionContract: { ...context, producer: { workerId: 'unproven-worker', generation: 1 } } });
    expect(s.store.deferredEvents(s.ref, 'legitimate-pending')).toEqual([message]);
  });
  it('replays an opening spawn identity decision after runtime binding without requiring execution acceptance', async () => {
    const s = fixture(); const execution = s.controller.admitInput('opening-turn');
    const workerScope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = workerScope.beginRuntime(); workerScope.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: workerScope });
    const wire = (message: any) => workerScope.run(binding, () => metadata(message), execution);
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const legacy = vi.fn();
    const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      sameWorker, sameRuntime, logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope);
    hostScope.handleWorkerMessage = host;

    await host(wire({ type: 'runtime_binding_started', bindingId: binding.bindingId }));
    const decision = wire({ type: 'session_identity_decision', sessionId: s.ref.sessionId,
      model: 'proven', sandboxEngaged: false, loopbackShared: true, turnId: 'opening-turn' });
    expect(decision.sessionContract.scope.execution).toBeUndefined();
    await host(decision);
    expect(s.store.deferredEvents(s.ref, binding.bindingId)).toEqual([decision]);
    expect(legacy).not.toHaveBeenCalled();

    await host(wire({ type: 'runtime_binding', bindingId: binding.bindingId,
      identity: { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' } }));
    expect(legacy).toHaveBeenCalledWith(decision);
    expect(s.store.deferredEvents(s.ref, binding.bindingId)).toEqual([]);
  });
  it.each(['refused', 'timeout'] as const)('settles a %s spawn reservation and restores the surviving binding before a genuine crash', async condition => {
    vi.useFakeTimers(); const s = fixture();
    const workerScope = new WorkerSessionEventScope(s.ref, s.worker); const previous = workerScope.beginRuntime(); workerScope.assign(previous.bindingId, s.runtime);
    const reservations = new Map(); const pending: Promise<void>[] = [];
    const env: any = { workerSessionEventScope: workerScope, pendingRuntimeReservations: reservations,
      activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
      spawnCliBody: vi.fn(), publishRuntimeContract: vi.fn(), CliSpawnSupersededError: class extends Error {} };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    s.controller.ingest(workerScope.run(previous, () => metadata({ type: 'ready' })), s.worker);
    s.controller.ingest(workerScope.run(previous, () => metadata({ type: 'prompt_ready' })), s.worker);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let flushes = 0;
    vi.spyOn(s.controller, 'flushPrimary').mockImplementation(() => flushes++ === 0 ? gate : Promise.resolve());
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
    const worker = { send: vi.fn((message: any) => { void receive(message); }) }; s.ds.worker = worker as any;
    const legacy = vi.fn(); const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
    env.send = (message: any) => { pending.push(host(metadata(message))); };
    const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
    const started = spawn({ prompt: '' }); const rejected = expect(started).rejects.toBeInstanceOf(Error);
    const abandoned = workerScope.currentBinding()!;
    if (condition === 'refused') { s.controller.beginControl('close', 'close-during-start'); release(); }
    else { await vi.advanceTimersByTimeAsync(15_001); release(); }
    await rejected; await Promise.all(pending); await Promise.all(pending);
    if (condition === 'refused') s.controller.controlResult('close-during-start', 'rejected');
    expect(env.spawnCliBody).not.toHaveBeenCalled(); expect(workerScope.currentBinding()).toBe(previous);
    expect(worker.send.mock.calls.some(([message]) => message.type === 'runtime_contract_reserved' && message.mayStart)).toBe(false);
    expect(s.store.binding(s.ref, abandoned.bindingId)?.phase).toBe('stopped');
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(() => s.controller.bindRuntime(abandoned.bindingId, s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' })).toThrow('runtime_reservation_abandoned');
    await host(workerScope.run(previous, () => metadata({ type: 'claude_exit', code: 1 })));
    expect(legacy).toHaveBeenCalledOnce();
  });
  it('allows restart retry after persistence of the start claim fails before any physical effect', () => {
    const s = fixture(); let ds = { ...s.ds, session: structuredClone(s.ds.session), worker: null } as DaemonSession;
    let controller = s.controller; const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    db.exec("CREATE TRIGGER fail_start_claim BEFORE INSERT ON events WHEN NEW.type='control_started' BEGIN SELECT RAISE(ABORT,'start_claim_failed'); END");
    const scope: any = { RestartCoordinator, findActiveBySessionId: () => ds, controllerForSession: () => controller,
      isSessionTransferring: () => false, sessionContractPrimary: () => false,
      destroyLivePaneBeforeRestart: vi.fn(), forkWorker: vi.fn(), logger: { warn: vi.fn() }, tag: () => 'test' };
    scope.restartCoordinator = loadWorkerPoolClosure('restartCoordinator', scope);
    const restart = loadWorkerPoolFunction<(ds: DaemonSession, observer: any) => any>('requestSessionRestart', scope);
    try {
      const first = restart(ds, { source: 'slash', notify: vi.fn() });
      expect(scope.forkWorker).not.toHaveBeenCalled();
      expect(controller.operation(first.attemptId)?.phase).toBe('failed_before_effect');
      expect(controller.allowsInput()).toBe(true);
      db.exec('DROP TRIGGER fail_start_claim'); s.store.close();
      const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened); controller = new SessionController(ds, reopened);
      const next = restart(ds, { source: 'slash', notify: vi.fn() });
      expect(next.joined).toBe(false); expect(next.attemptId).not.toBe(first.attemptId);
      expect(scope.forkWorker).toHaveBeenCalledOnce();
    } finally { scope.restartCoordinator.reset(); }
  });
  it.each([false, true])('reverifies the original uncertain suspend, including after reopen (primary=%s)', async primary => {
    const s = fixture(); let controller = s.controller;
    const worker = { killed: false, send: vi.fn(), kill: vi.fn() }; s.ds.worker = worker as any;
    s.ds.initConfig = { backendType: 'tmux' } as any;
    const verifier = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const scope: any = { controllerForSession: () => controller, sessionContractPrimary: () => primary,
      primarySuspendInFlight: new WeakMap(), primarySuspendApplying: new WeakSet(), sameRuntime,
      hasProtectedSessionMutationOwnership: () => false, isSessionTransferring: () => false,
      isSuspendableBackendType: () => true, suspendBackingVerifier: verifier,
      trackLifecycleRetirement: vi.fn(), clearLifecycleRetirement: vi.fn(), armWorkerKillBackstop: vi.fn(),
      invalidateStuckWarning: vi.fn(), invalidateTuiPrompt: vi.fn(), clearIdleAutoCompactStretch: vi.fn(),
      clearPendingSuspendClaim: vi.fn(),
      takeSessionPreviewTarget: () => undefined, sessionStore: { updateSessionPid: vi.fn(), updateSession: vi.fn() },
      dashboardEventBus: { publish: vi.fn() }, restartCoordinator: { cancelSession: vi.fn() }, logger: { warn: vi.fn(), info: vi.fn() }, tag: () => 'test' };
    scope.suspendWorker = loadWorkerPoolFunction('suspendWorker', scope);
    const suspend = loadWorkerPoolFunction<(ds: DaemonSession) => Promise<boolean>>('suspendWorkerAsync', scope);
    expect(await suspend(s.ds)).toBe(false);
    const operation = controller.operation()!;
    expect(operation).toMatchObject({ kind: 'suspend', phase: 'uncertain' });
    expect(controller.allowsInput()).toBe(false); expect(worker.send).not.toHaveBeenCalled();
    s.ds = { ...s.ds, session: structuredClone(s.ds.session) };
    s.store.close(); const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    controller = new SessionController(s.ds, reopened);
    expect(await suspend(s.ds)).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(controller.operation(operation.operationId)?.phase).toBe('confirmed');
    expect(reopened.read(s.ref)?.lifecycle).toBe('suspended');
    expect(reopened.read(s.ref)?.activeOperationId).toBeUndefined();
    expect(worker.send).toHaveBeenCalledTimes(1); expect(s.ds.worker).toBeNull();
    expect(controller.prepareResume()).toBeDefined();
  });
  it.each(['suspend', 'cancel'] as const)('recovers persisted uncertain %s through restart without granting late callbacks authority', kind => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn');
    s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl(kind, 'old-control', kind === 'cancel' ? execution : undefined);
    s.controller.controlStarted('old-control'); s.controller.controlResult('old-control', 'uncertain');
    s.ds = { ...s.ds, session: structuredClone(s.ds.session) };
    s.store.close(); const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    const controller = new SessionController(s.ds, reopened);
    const restart = controller.beginControl('restart', 'recovery-restart');
    expect(restart.joined).toBe(false); expect(restart.operation.previousLifecycle).toBe('active');
    controller.controlStarted('recovery-restart');
    expect(controller.allowsInput()).toBe(false);
    expect(reopened.operation(s.ref, 'old-control')).toMatchObject({ phase: 'uncertain', error: 'superseded_by_restart' });
    controller.controlResult('old-control', 'confirmed');
    expect(reopened.read(s.ref)).toMatchObject({ lifecycle: 'active', activeOperationId: 'recovery-restart' });
    expect(controller.allowsInput()).toBe(false);
    const next = controller.reserveBinding('recovery-runtime', s.worker);
    controller.bindRuntime('recovery-runtime', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' }, 'recovery-restart');
    controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2, { runtime: next }) }, s.worker);
    controller.ingest({ type: 'restart_result', attemptId: 'recovery-restart', status: 'succeeded', sessionContract: s.context(3, { runtime: next, operationId: 'recovery-restart' }) }, s.worker);
    expect(controller.allowsInput()).toBe(true); expect(s.ds.cliReady).toBe(true);
    controller.ingest({ type: 'turn_terminal', turnId: 'old-turn', status: 'completed', sessionContract: s.context(4, { runtime: s.runtime, execution }) }, s.worker);
    expect(controller.currentRuntime()).toEqual(next); expect(s.ds.cliReady).toBe(true);
    expect(reopened.execution(s.ref, execution.executionId)?.phase).toBe('succeeded');
  });
  it.each(['suspend', 'cancel'] as const)('does not restart over an applying %s or lift its fence on ordinary readiness', kind => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl(kind, 'active-control', kind === 'cancel' ? execution : undefined); s.controller.controlStarted('active-control');
    expect(() => s.controller.beginControl('restart')).toThrow('control_operation_in_progress');
    s.controller.controlResult('active-control', 'uncertain');
    s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2) }, s.worker);
    expect(s.controller.allowsInput()).toBe(false); expect(s.controller.operation()?.operationId).toBe('active-control');
  });
  it.each(['suspend', 'cancel'] as const)('starts physical recovery for persisted uncertain %s through the actual restart route', kind => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl(kind, 'uncertain-control', kind === 'cancel' ? execution : undefined);
    s.controller.controlStarted('uncertain-control'); s.controller.controlResult('uncertain-control', 'uncertain');
    const ds = { ...s.ds, session: structuredClone(s.ds.session), worker: null } as DaemonSession;
    s.store.close(); const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    const controller = new SessionController(ds, reopened);
    const scope: any = { RestartCoordinator, findActiveBySessionId: () => ds, controllerForSession: () => controller,
      isSessionTransferring: () => false, sessionContractPrimary: () => false,
      destroyLivePaneBeforeRestart: vi.fn(), forkWorker: vi.fn(), logger: { warn: vi.fn() }, tag: () => 'test' };
    scope.restartCoordinator = loadWorkerPoolClosure('restartCoordinator', scope);
    const restart = loadWorkerPoolFunction<(ds: DaemonSession, observer: any) => any>('requestSessionRestart', scope);
    try {
      const request = restart(ds, { source: 'slash', notify: vi.fn() });
      expect(request).toMatchObject({ joined: false }); expect(request.startFailure).toBeUndefined();
      expect(scope.destroyLivePaneBeforeRestart).toHaveBeenCalledWith(ds);
      expect(scope.forkWorker).toHaveBeenCalledWith(ds, '', expect.objectContaining({ restartAttemptId: request.attemptId }));
      expect(controller.operation()).toMatchObject({ operationId: request.attemptId, kind: 'restart', phase: 'applying' });
      expect(controller.allowsInput()).toBe(false);
    } finally { scope.restartCoordinator.reset(); }
  });
  it('records predecessor loss as history in the reserve-only window and still handles the later current crash', async () => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2) }, s.worker);
    const next = s.controller.reserveBinding('pending-next', s.worker);
    const legacy = vi.fn(); const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope);
    expect(s.controller.gateway.admit('claude_exit', s.context(3), s.worker).kind).toBe('historical');
    await handler({ type: 'claude_exit', code: 0, sessionContract: s.context(3) });
    expect(legacy).not.toHaveBeenCalled();
    expect(s.store.runtime(s.ref, s.runtime.runtimeId)?.phase).toBe('stopped');
    expect(s.store.execution(s.ref, execution.executionId)?.phase).toBe('reconciling');
    expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
    s.controller.bindRuntime('pending-next', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(4, { runtime: next }) }, s.worker);
    expect(s.ds.cliReady).toBe(true);
    await handler({ type: 'claude_exit', code: 1, sessionContract: s.context(5, { runtime: next }) });
    expect(legacy).toHaveBeenCalledOnce();
    expect(s.ds.cliReady).toBe(false);
  });
  it('does not mistake allocator high water or an orphaned reused reservation for an outstanding replacement', () => {
    const s = fixture(); const old = s.store.runtime(s.ref)!;
    const next = s.controller.reserveBinding('reuse-same-process', s.worker);
    const reused = s.controller.bindRuntime('reuse-same-process', s.worker, old.identity!);
    expect(reused.ref).toEqual(s.runtime); expect(next.epoch).toBeGreaterThan(s.runtime.epoch);
    expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
    expect(s.store.runtime(s.ref, next.runtimeId)?.identity).toBeUndefined();
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: s.context(1) }, s.worker).kind).toBe('current');
    expect(s.store.runtime(s.ref)?.phase).toBe('stopped');
  });
  it('ignores reservations left by an older worker when classifying the current physical exit', () => {
    const s = fixture(); const identity = s.store.runtime(s.ref)!.identity!;
    s.controller.reserveBinding('abandoned-reservation', s.worker);
    const worker = s.controller.bindWorker(2).worker;
    s.controller.reserveBinding('reattach', worker); s.controller.bindRuntime('reattach', worker, identity);
    const context = { ...s.context(1), producer: worker, eventId: `${worker.workerId}:1` };
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: context }, worker).kind).toBe('current');
  });
  it.each([false, true])('handles a physical exit across semantic bindings without overriding a pending replacement (pending=%s)', pending => {
    const s = fixture();
    const semantic = s.controller.reserveBinding('same-physical-new-conversation', s.worker);
    s.controller.bindRuntime('same-physical-new-conversation', s.worker, { ...s.store.runtime(s.ref)!.identity!, nativeSessionId: 'native2' });
    const next = pending ? s.controller.reserveBinding('pending-replacement', s.worker) : undefined;
    const admission = s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: s.context(1) }, s.worker);
    expect(admission.kind).toBe(pending ? 'historical' : 'current');
    expect(s.store.runtime(s.ref, semantic.runtimeId)?.phase).toBe('stopped');
    if (next) expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
  });
  it.each(['recover', 'stopped', 'retiring', 'different_pid', 'different_sid', 'middle_attempt', 'confirmed_binding', 'foreign_binding', 'history_gap', 'historical_switch', 'candidate_switch'] as const)(
    'repairs only a proven uninterrupted unresolved runtime through a bare observation: %s', condition => {
    const s = fixture(); const old = s.store.runtime(s.ref)!;
    const execution = s.controller.admitInput('old-active'); s.store.bindQueuedExecution(s.ref, execution, old.ref);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: old.ref, status: 'reconciling', evidence: 'observer_loss' });
    if (condition !== 'retiring') s.store.apply(s.ref, { type: 'runtime_lost', runtime: old.ref, confirmed: condition === 'stopped' });
    if (condition === 'candidate_switch') {
      const current = s.store.runtime(s.ref)!;
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: { ...current, identity: { ...current.identity!, nativeSessionId: 'native-other' } } });
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: current });
    }
    let worker = s.controller.bindWorker(2).worker;
    if (condition === 'different_sid') {
      s.controller.reserveBinding('known-transition', worker);
      s.controller.bindRuntime('known-transition', worker, { ...old.identity!, nativeSessionId: 'native-other' });
    }
    const middle = s.controller.reserveBinding('middle-bare', worker);
    s.controller.bindRuntime('middle-bare', worker, { backend: 'tmux', physicalId: condition === 'different_pid' ? '222:start2' : '111:start1', proof: 'process_start' });
    if (condition === 'historical_switch') {
      const current = s.store.runtime(s.ref)!;
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: { ...current, identity: { ...current.identity!, nativeSessionId: 'native-other' } } });
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: current });
    }
    if (condition === 'history_gap') {
      const checkpoint = s.store.snapshot(s.ref);
      checkpoint.tables.events = checkpoint.tables.events.filter(row => row.type !== 'runtime_reserved'
        || JSON.parse(row.value as string).runtime.ref.runtimeId !== middle.runtimeId);
      s.store.restore(checkpoint);
    }
    if (condition === 'middle_attempt') {
      const active = s.controller.admitInput('middle-active'); s.store.bindQueuedExecution(s.ref, active, middle);
    }
    if (condition === 'foreign_binding') worker = s.controller.bindWorker(3).worker;
    const bindingId = ['confirmed_binding', 'foreign_binding'].includes(condition) ? 'middle-bare' : 'new-proof';
    if (!['confirmed_binding', 'foreign_binding'].includes(condition)) s.controller.reserveBinding(bindingId, worker);
    if (condition === 'middle_attempt' || condition === 'foreign_binding') {
      expect(() => s.controller.bindRuntime(bindingId, worker, old.identity!)).toThrow(condition === 'middle_attempt' ? 'runtime_recovery_has_active_execution' : 'runtime_binding_producer_mismatch');
      expect(s.store.runtime(s.ref)?.ref).toEqual(middle);
      expect(s.store.binding(s.ref, 'middle-bare')?.ref).toEqual(middle);
      return;
    }
    const result = s.controller.bindRuntime(bindingId, worker, old.identity!);
    if (condition === 'recover') expect(result.ref).toEqual(old.ref);
    else expect(result.ref).not.toEqual(old.ref);
    if (condition === 'confirmed_binding') expect(result.ref).toEqual(middle);
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'reconciling', runtime: old.ref });
    expect(s.store.binding(s.ref, 'middle-bare')?.ref).toEqual(middle);
    if (condition === 'recover') expect(s.store.read(s.ref)?.runtimeEpoch).toBe(3);
  });
  it('uses fresh unambiguous PID-owned native identity on a busy reattach before granting the binding', () => {
    const s = fixture(); const old = s.store.runtime(s.ref)!;
    const replacementWorker = s.controller.bindWorker(2).worker;
    const scope = new WorkerSessionEventScope(s.ref, replacementWorker); const binding = scope.beginRuntime();
    const env: any = { backend: { cliPid: 111 }, codexRpcEngine: undefined, effectiveBackendType: 'tmux',
      lastInitConfig: { cliId: 'traex', cliSessionId: 'untrusted-config-id' },
      readProcessStartIdentity: () => 'start1', findTraexRolloutSetByPid: () => new Set(['native1']),
      findTraexRolloutByPid: () => ({ path: '/owned', cliSessionId: 'native1' }) };
    const identity = loadWorkerFunction<(binding: any) => any>('runtimeIdentityForContract', env);
    s.controller.reserveBinding(binding.bindingId, replacementWorker);
    const restored = s.controller.bindRuntime(binding.bindingId, replacementWorker, identity(binding));
    expect(restored.ref).toEqual(old.ref); expect(restored.identity?.nativeSessionId).toBe('native1');
    env.findTraexRolloutSetByPid = () => new Set(['native1', 'native2']);
    expect(identity(scope.beginRuntime()).nativeSessionId).toBeUndefined();
    env.findTraexRolloutSetByPid = () => new Set(['native2']);
    env.findTraexRolloutByPid = () => ({ path: '/new-owned', cliSessionId: 'native2' });
    const rotated = scope.beginRuntime(); s.controller.reserveBinding(rotated.bindingId, replacementWorker);
    expect(s.controller.bindRuntime(rotated.bindingId, replacementWorker, identity(rotated)).ref).not.toEqual(old.ref);
    env.findTraexRolloutByPid = () => { env.backend = { cliPid: 222 }; return { path: '/new-owned', cliSessionId: 'native2' }; };
    expect(identity(scope.beginRuntime()).proof).toBe('opaque');
    env.backend = { cliPid: 111 }; env.workerSessionEventScope = scope;
    env.findTraexRolloutByPid = () => { scope.beginRuntime(); return { path: '/new-owned', cliSessionId: 'native2' }; };
    expect(identity(scope.beginRuntime()).proof).toBe('opaque');
    env.findTraexRolloutByPid = () => ({ path: '/new-owned', cliSessionId: 'native2' });
    env.readProcessStartIdentity = vi.fn().mockReturnValueOnce('start1').mockReturnValueOnce('start2');
    expect(identity(scope.beginRuntime()).proof).toBe('opaque');
  });
  it.each([
    {
      name: 'starts a new binding when the observed CLI PID replaces the confirmed launcher PID',
      previous: { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' as const },
      observed: { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' as const },
      replaces: true,
      activeOperationId: 'completed-restart',
      liveOperationId: undefined,
    },
    {
      name: 'enriches the confirmed binding when only its first native session id arrives',
      previous: { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' as const },
      observed: { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' as const },
      replaces: false,
      activeOperationId: 'completed-restart',
      liveOperationId: undefined,
    },
    {
      name: 'carries the restart id only while that restart is still live',
      previous: { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' as const },
      observed: { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' as const },
      replaces: true,
      activeOperationId: 'live-restart',
      liveOperationId: 'live-restart',
    },
  ])('$name', ({ previous, observed, replaces, activeOperationId, liveOperationId }) => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const active = scope.beginRuntime(activeOperationId, 'physical-lineage');
    scope.assign(active.bindingId, s.runtime); active.identity = previous;
    const sent: any[] = [];
    const observedRuntimeBindingHandshakes = new Map();
    const observe = loadWorkerFunction<(nativeSessionId: string) => void>('observeContractNativeSession', {
      workerSessionEventScope: scope,
      activeRestartAttemptId: liveOperationId,
      observedRuntimeBindingHandshakes,
      backend: undefined,
      cliSpawnGeneration: 1,
      closeRequested: false,
      runtimeIdentityForContract: () => observed,
      confirmedRuntimeIdentityChanged,
      reusableRuntimeIdentity,
      send: (message: any) => sent.push(message),
    });
    scope.run(active, () => observe('native1'));
    const current = scope.currentBinding()!;
    expect(current === active).toBe(!replaces);
    expect(current.identity).toEqual({ ...observed, nativeSessionId: 'native1' });
    expect(active.identity).toEqual(replaces ? previous : { ...observed, nativeSessionId: 'native1' });
    expect(current.operationId).toBe(replaces ? liveOperationId : activeOperationId);
    const operation = liveOperationId ? { operationId: liveOperationId } : {};
    expect(sent).toEqual(replaces ? [
      { type: 'runtime_binding_started', bindingId: current.bindingId, ...operation },
      { type: 'runtime_binding', bindingId: current.bindingId, identity: current.identity, ...operation },
    ] : [
      { type: 'runtime_binding', bindingId: active.bindingId, identity: active.identity, ...operation },
    ]);
    const pending = [...observedRuntimeBindingHandshakes.values()][0];
    if (pending?.timer) clearTimeout(pending.timer);
    observedRuntimeBindingHandshakes.clear();
  });
  it('retries an observed binding until a lost refusal is replayed, then admits a clean successor', async () => {
    vi.useFakeTimers(); const s = fixture();
    const execution = s.controller.admitInput('cancelled-turn');
    const cancel = s.controller.beginControl('cancel', 'cancel-active', execution).operation;
    s.controller.controlStarted(cancel.operationId);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const previous = scope.beginRuntime(undefined, 'physical-lineage');
    scope.assign(previous.bindingId, s.runtime);
    previous.bindingId = 'binding-old';
    previous.identity = { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' };
    const observedRuntimeBindingHandshakes = new Map();
    const env: any = {
      workerSessionEventScope: scope,
      observedRuntimeBindingHandshakes,
      activeRestartAttemptId: undefined,
      backend: undefined,
      cliSpawnGeneration: 1,
      runtimeIdentityForContract: () => ({ backend: 'tmux', physicalId: '222:start2', proof: 'process_start' }),
      confirmedRuntimeIdentityChanged, reusableRuntimeIdentity,
      pendingRuntimeReservations: new Map(),
      closeRequested: false,
      stopBridgeWatcher: vi.fn(), stopScreenshotLoop: vi.fn(), killCli: vi.fn(),
    };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
    let dropRefusal = true; const receipts: Promise<void>[] = []; const replies: any[] = [];
    const worker: any = { send: vi.fn((message: any) => {
      replies.push(message);
      if (!(message.type === 'runtime_binding_refused' && dropRefusal)) receipts.push(receive(message));
    }) };
    s.ds.worker = worker;
    const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      sameWorker, sameRuntime, logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope);
    hostScope.handleWorkerMessage = host;
    let deliveries = Promise.resolve();
    env.send = (message: any) => {
      const wire = scope.run(scope.currentBinding()!, () => metadata(message));
      deliveries = deliveries.then(() => host(wire));
    };
    const drain = async (): Promise<void> => {
      await deliveries;
      for (let index = 0; index < receipts.length; index++) await receipts[index];
    };
    const observe = loadWorkerFunction<(nativeSessionId: string) => void>('observeContractNativeSession', env);
    scope.run(previous, () => observe('native-real'));
    const refused = scope.currentBinding()!;
    await drain();
    expect(s.store.binding(s.ref, refused.bindingId)).toMatchObject({ phase: 'stopped', reason: 'runtime_binding_refused' });
    expect(scope.currentBinding()).toBe(refused);
    expect([...observedRuntimeBindingHandshakes.values()][0]?.binding).toBe(refused);
    expect(replies.filter(message => message.type === 'runtime_binding_refused')).toHaveLength(1);

    dropRefusal = false;
    await vi.advanceTimersByTimeAsync(1_001); await drain();
    expect(replies.filter(message => message.type === 'runtime_binding_refused')).toHaveLength(2);
    expect(scope.currentBinding()).toBe(previous);
    expect(observedRuntimeBindingHandshakes.size).toBe(1);
    expect([...observedRuntimeBindingHandshakes.values()][0]?.binding).toBeUndefined();

    s.controller.controlResult(cancel.operationId, 'rejected');
    await vi.advanceTimersByTimeAsync(1_001); await drain();
    const successor = scope.currentBinding()!;
    expect(successor).not.toBe(previous);
    expect(successor.runtime).toEqual(s.store.runtime(s.ref)?.ref);
    expect(observedRuntimeBindingHandshakes.size).toBe(0);
    expect(env.killCli).not.toHaveBeenCalled();
  });
  it('retires an operation-drifted observation and retries it on a clean binding', async () => {
    vi.useFakeTimers(); const s = fixture();
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const previous = scope.beginRuntime('restart-live', 'physical-lineage');
    scope.assign(previous.bindingId, s.runtime);
    previous.identity = { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' };
    const observedRuntimeBindingHandshakes = new Map(); const sent: any[] = [];
    const env: any = {
      workerSessionEventScope: scope, observedRuntimeBindingHandshakes,
      activeRestartAttemptId: 'restart-live', backend: undefined, cliSpawnGeneration: 1,
      closeRequested: false,
      runtimeIdentityForContract: () => ({ backend: 'tmux', physicalId: '222:start2', proof: 'process_start' }),
      confirmedRuntimeIdentityChanged, reusableRuntimeIdentity,
      send: (message: any) => sent.push(message),
    };
    const observe = loadWorkerFunction<(nativeSessionId: string) => void>('observeContractNativeSession', env);
    scope.run(previous, () => observe('native-real'));
    const stale = scope.currentBinding()!;
    expect(sent.slice(-2).map(message => message.operationId)).toEqual(['restart-live', 'restart-live']);

    env.activeRestartAttemptId = undefined;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'runtime_binding_aborted', bindingId: stale.bindingId }));
    expect(scope.currentBinding()).toBe(previous);
    const probe = sent.find(message => message.type === 'runtime_binding_probe');
    expect(probe).toEqual(expect.objectContaining({ probeId: expect.any(String) }));
    const settleProbe = loadWorkerFunction<(probeId: string, mayStart: boolean) => boolean>(
      'settleObservedRuntimeBindingProbe', env);
    expect(settleProbe(probe.probeId, true)).toBe(true);
    const successor = scope.currentBinding()!;
    expect(successor).not.toBe(stale);
    expect(sent.slice(-2)).toEqual([
      { type: 'runtime_binding_started', bindingId: successor.bindingId },
      { type: 'runtime_binding', bindingId: successor.bindingId, identity: successor.identity },
    ]);
    expect(env.killCli).toBeUndefined();
  });
  it('allows a primary checkpoint retry after the previous queued write failed', async () => {
    const s = fixture(); let writes = 0;
    let canonical: any = { value: { type: 'botmux.session.primary', session: structuredClone(s.ds.session) } };
    const fence = vi.fn();
    const unregister = registerSessionContractPrimary(s.appId, {
      ownerId: 'primary-retry-test',
      writeExactFromCurrent: vi.fn(async (_key: string, build: (current: any) => any) => {
        writes++;
        if (writes === 1) throw new Error('primary_write_failed_once');
        canonical = { ...canonical, value: build(canonical) };
        return { kind: 'written', lease: {}, record: canonical, coalescedCount: 0 } as any;
      }),
    } as any, fence);
    try {
      await expect(s.controller.flushPrimary()).rejects.toThrow('primary_write_failed_once');
      await expect(s.controller.flushPrimary()).resolves.toBeUndefined();
      expect(writes).toBe(2);
      expect(fence).toHaveBeenCalledTimes(1);
      expect(canonical.value.session.sessionRuntimeContract.session.revision)
        .toBe(s.store.read(s.ref)?.revision);
    } finally { unregister(); }
  });
  it('stops an aborted-start reporter when its delayed assignment arrives', async () => {
    vi.useFakeTimers(); const s = fixture();
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const previous = scope.beginRuntime(undefined, 'physical-lineage');
    scope.assign(previous.bindingId, s.runtime);
    const delayed = scope.beginRuntime('restart-drift', 'physical-lineage');
    scope.restoreAfterAbortedStart(delayed, previous);
    let reports = 0;
    scope.reportAbortedStart(delayed, () => { reports++; });
    expect(reports).toBe(1);
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', {
      workerSessionEventScope: scope,
      observedRuntimeBindingHandshakes: new Map(),
      activeRestartAttemptId: undefined,
      closeRequested: false,
      stopBridgeWatcher: vi.fn(), stopScreenshotLoop: vi.fn(), killCli: vi.fn(),
    });
    await receive({ type: 'runtime_contract_assigned', bindingId: delayed.bindingId,
      runtime: s.runtime, mayExecute: true });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(reports).toBe(1);
    expect(delayed.runtime).toEqual(s.runtime);
  });
  it('replaces a retiring stale assignment before the only ready edge can inherit it', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const previous = scope.beginRuntime(undefined, 'physical-lineage');
    scope.assign(previous.bindingId, s.runtime);
    previous.identity = { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' };
    const stale = scope.beginRuntime('settled-restart', 'physical-lineage');
    stale.identity = { backend: 'tmux', physicalId: '222:start2', nativeSessionId: 'native-real', proof: 'process_start' };
    const observedRuntimeBindingHandshakes = new Map([['physical-lineage', {
      scope, physicalId: 'physical-lineage', backend: undefined, spawnGeneration: 1,
      identity: stale.identity, binding: stale, operationId: 'settled-restart',
    }]]);
    const sent: any[] = []; const killCli = vi.fn();
    const ready = vi.fn();
    expect(scope.deferReady(stale, ready)).toBe(true);
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', {
      workerSessionEventScope: scope, observedRuntimeBindingHandshakes,
      activeRestartAttemptId: undefined, backend: undefined, cliSpawnGeneration: 1,
      closeRequested: false, runtimeIdentityForContract: () => stale.identity,
      send: (message: any) => sent.push(message), stopBridgeWatcher: vi.fn(),
      stopScreenshotLoop: vi.fn(), killCli,
    });
    await receive({ type: 'runtime_contract_assigned', bindingId: stale.bindingId,
      runtime: s.runtime, mayExecute: false });
    const successor = scope.currentBinding()!;
    expect(successor).not.toBe(stale);
    expect(successor.operationId).toBeUndefined();
    expect(successor.identity).toEqual(stale.identity);
    expect(sent.slice(-2)).toEqual([
      { type: 'runtime_binding_started', bindingId: successor.bindingId },
      { type: 'runtime_binding', bindingId: successor.bindingId, identity: successor.identity },
    ]);
    expect(killCli).not.toHaveBeenCalled();
    await receive({ type: 'runtime_contract_assigned', bindingId: successor.bindingId,
      runtime: s.runtime, mayExecute: true });
    expect(ready).toHaveBeenCalledOnce();
    expect(scope.flushReady(successor.bindingId)).toBe(false);
    const pending = [...observedRuntimeBindingHandshakes.values()][0];
    if (pending?.timer) clearTimeout(pending.timer);
  });
  it('never revives a rejected ready edge from a late positive assignment', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(undefined, 'physical-lineage');
    const callback = vi.fn();
    const env: any = { workerSessionEventScope: scope, fenceContractBackendWrites: vi.fn(),
      runtimeIdentityForContract: (candidate: any) => candidate.identity,
      confirmedRuntimeIdentityChanged, publishRuntimeContract: vi.fn() };
    env.bindSessionRuntimeCallback = loadWorkerFunction('bindSessionRuntimeCallback', env);
    const bindReady = loadWorkerFunction<(callback: () => void) => () => void>('bindSessionRuntimeReadyCallback', env);
    const ready = scope.run(binding, () => bindReady(callback));
    ready();
    expect(callback).not.toHaveBeenCalled();
    const killCli = vi.fn();
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', {
      workerSessionEventScope: scope, observedRuntimeBindingHandshakes: new Map(),
      activeRestartAttemptId: undefined, closeRequested: false,
      stopBridgeWatcher: vi.fn(), stopScreenshotLoop: vi.fn(), killCli,
    });

    await receive({ type: 'runtime_contract_assigned', bindingId: binding.bindingId,
      runtime: s.runtime, mayExecute: false });
    expect(callback).not.toHaveBeenCalled();
    expect(scope.isReadyDenied(binding.bindingId)).toBe(true);
    expect(killCli).toHaveBeenCalledOnce();

    ready();
    await receive({ type: 'runtime_contract_assigned', bindingId: binding.bindingId,
      runtime: s.runtime, mayExecute: false });
    await receive({ type: 'runtime_contract_assigned', bindingId: binding.bindingId,
      runtime: s.runtime, mayExecute: true });
    expect(callback).not.toHaveBeenCalled();
    expect(scope.flushReady(binding.bindingId)).toBe(false);
    expect(killCli).toHaveBeenCalledTimes(2);
  });
  it('keeps retry probes read-only until the active control settles', async () => {
    const s = fixture(); const execution = s.controller.admitInput('probe-control-turn');
    const control = s.controller.beginControl('cancel', 'probe-control', execution).operation;
    s.controller.controlStarted(control.operationId);
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', {
      sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      sameWorker, sameRuntime, logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test',
      handleLegacyWorkerMessage: vi.fn(),
    });
    const before = s.store.snapshot(s.ref);
    for (let index = 1; index <= 6; index++) {
      await host({ type: 'runtime_binding_probe', probeId: `probe-${index}`,
        sessionContract: { ...s.context(index), bindingId: 'binding-old' } });
    }
    const after = s.store.snapshot(s.ref);
    expect(after.session.revision).toBe(before.session.revision);
    expect(after.tables.runtime_bindings).toEqual(before.tables.runtime_bindings);
    expect(after.tables.events).toEqual(before.tables.events);
    expect(worker.send).toHaveBeenCalledTimes(6);
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'runtime_binding_probe_result', probeId: 'probe-6', mayStart: false,
    });
    s.controller.controlResult(control.operationId, 'rejected');
    await host({ type: 'runtime_binding_probe', probeId: 'probe-settled',
      sessionContract: { ...s.context(7), bindingId: 'binding-old' } });
    expect(worker.send).toHaveBeenLastCalledWith({
      type: 'runtime_binding_probe_result', probeId: 'probe-settled', mayStart: true,
    });
  });
  it('keeps delayed predecessor exits out of legacy consumers while preserving scoped runtime evidence', () => {
    const s = fixture(); const original = { write: vi.fn() }; const replacement = { write: vi.fn() };
    const callback = vi.fn(); const wire: any[] = [];
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    const env: any = { backend: original, workerSessionEventScope: undefined, intentionalRestartBackend: original,
      fenceContractBackendWrites: vi.fn(), send: (message: any) => wire.push(message) };
    env.bindSessionRuntimeCallback = loadWorkerFunction('bindSessionRuntimeCallback', env);
    const bindExit = loadWorkerFunction<(callback: (...args: any[]) => void) => (...args: any[]) => void>('bindSessionBackendExit', env);
    const legacyExit = bindExit(callback); env.backend = replacement; legacyExit(0, null);
    expect(wire).toHaveLength(0); expect(callback).not.toHaveBeenCalled();
    expect(env.intentionalRestartBackend).toBeNull();
    env.backend = original; env.workerSessionEventScope = scope;
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    env.send = (message: any) => wire.push(metadata(message));
    const scopedExit = scope.run(binding, () => bindExit(callback));
    const nextBinding = scope.beginRuntime();
    const next = s.controller.reserveBinding(nextBinding.bindingId, s.worker); scope.assign(nextBinding.bindingId, next);
    s.controller.bindRuntime(nextBinding.bindingId, s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    env.backend = replacement; scopedExit(0, null);
    expect(wire).toHaveLength(1); expect(wire[0].sessionContract.scope.runtime).toEqual(s.runtime);
    expect(s.controller.ingest(wire[0], s.worker).kind).toBe('historical');
    expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
    expect(callback).not.toHaveBeenCalled();
  });
  it('rejects an invalid old event before it can bind a queued attempt', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA');
    const next = s.controller.reserveBinding('binding-next', s.worker);
    s.controller.bindRuntime('binding-next', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    expect(s.controller.ingest({ type: 'turn_execution_started', turnId: 'turnA', sessionContract: s.context(1, { runtime: s.runtime, execution }) }, s.worker).kind).toBe('reject');
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
    expect(s.controller.ingest({ type: 'turn_execution_started', turnId: 'turnA', sessionContract: s.context(2, { runtime: next, execution }) }, s.worker).kind).toBe('current');
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toEqual(next);
  });
  it('does not let an older screen observation revoke newer prompt readiness', () => {
    const s = fixture(); s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(3) }, s.worker);
    expect(s.ds.cliReady).toBe(true);
    expect(s.controller.ingest({ type: 'screen_update', status: 'working', sessionContract: s.context(2) }, s.worker).kind).toBe('reject');
    expect(s.ds.cliReady).toBe(true);
  });
  it('hands a backend ready edge and its opening submission to a same-lineage runtime replacement', () => {
    const s = fixture(); const execution = s.controller.admitInput('opening-turn', 1);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const launcher = scope.beginRuntime(undefined, 'cli-lineage');
    scope.assign(launcher.bindingId, s.runtime); scope.rememberExecution(execution, launcher);
    launcher.identity = { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' };
    const env: any = { workerSessionEventScope: scope, fenceContractBackendWrites: vi.fn(),
      runtimeIdentityForContract: (binding: any) => binding.identity,
      confirmedRuntimeIdentityChanged, publishRuntimeContract: vi.fn() };
    env.bindSessionRuntimeCallback = loadWorkerFunction('bindSessionRuntimeCallback', env);
    const bindReady = loadWorkerFunction<(callback: () => void) => () => void>('bindSessionRuntimeReadyCallback', env);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const wire: any[] = [];
    const ready = scope.run(launcher, () => bindReady(() => {
      scope.recordSubmission('opening-turn', 1);
      wire.push(metadata({ type: 'prompt_ready' }));
      wire.push(metadata({ type: 'turn_execution_started', turnId: 'opening-turn', dispatchAttempt: 1, startedAtMs: 1 }));
    }), execution);

    const replacement = scope.beginRuntime(undefined, launcher.physicalId);
    const runtime = s.controller.reserveBinding(replacement.bindingId, s.worker);
    s.controller.bindRuntime(replacement.bindingId, s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    scope.assign(replacement.bindingId, runtime);
    replacement.identity = { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' };
    ready();

    expect(wire).toHaveLength(2);
    expect(wire[0].sessionContract.scope.runtime).toEqual(runtime);
    expect(wire[1].sessionContract.scope).toMatchObject({ runtime, execution });
    expect(s.controller.ingest(wire[0], s.worker).kind).toBe('current');
    expect(s.controller.ingest(wire[1], s.worker).kind).toBe('current');
    expect(s.store.runtime(s.ref, runtime.runtimeId)).toMatchObject({ phase: 'ready', promptReady: true });
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ runtime, phase: 'submitting' });

    scope.beginRuntime(undefined, 'different-cli-lineage');
    ready();
    expect(wire).toHaveLength(2);
  });
  it('refines a concrete launcher runtime before publishing its one-shot ready edge', () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const launcher = scope.beginRuntime(undefined, 'cli-lineage'); scope.assign(launcher.bindingId, s.runtime);
    launcher.identity = { backend: 'tmux', physicalId: '111:start1', proof: 'process_start' };
    const runtime = { runtimeId: 'real-runtime', epoch: 2 }; let replacement: ReturnType<typeof scope.beginRuntime> | undefined;
    const env: any = { workerSessionEventScope: scope, fenceContractBackendWrites: vi.fn(), confirmedRuntimeIdentityChanged,
      runtimeIdentityForContract: () => ({ backend: 'tmux', physicalId: '222:start2', proof: 'process_start' }),
      publishRuntimeContract: vi.fn(() => {
        replacement = scope.beginRuntime(undefined, launcher.physicalId);
        scope.assign(replacement.bindingId, runtime);
        replacement.identity = { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' };
      }) };
    env.bindSessionRuntimeCallback = loadWorkerFunction('bindSessionRuntimeCallback', env);
    const bindReady = loadWorkerFunction<(callback: () => void) => () => void>('bindSessionRuntimeReadyCallback', env);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    let wire: any;
    const ready = scope.run(launcher, () => bindReady(() => { wire = metadata({ type: 'prompt_ready' }); }));
    ready();
    expect(env.publishRuntimeContract).toHaveBeenCalledWith(launcher);
    expect(scope.currentBinding()).toBe(replacement);
    expect(wire.sessionContract).toMatchObject({ bindingId: replacement!.bindingId, scope: { runtime } });
  });
  it('does not carry a settled restart operation into ready-time identity refinement', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const launcher = scope.beginRuntime('settled-restart', 'cli-lineage');
    launcher.identity = { backend: 'remote-runner', physicalId: 'launcher:111', proof: 'process_start' };
    const identity = { backend: 'remote-runner', physicalId: 'provider:real-session',
      nativeSessionId: 'real-thread', nativeGeneration: '1', proof: 'native_generation' } as const;
    const sent: any[] = [];
    const publish = loadWorkerFunction<(binding: any) => Promise<void>>('publishRuntimeContract', {
      workerSessionEventScope: scope, activeRestartAttemptId: undefined,
      runtimeIdentityForContract: () => identity, confirmedRuntimeIdentityChanged,
      send: (message: any) => sent.push(message),
    });

    await scope.run(launcher, () => publish(launcher));
    const replacement = scope.currentBinding()!;
    expect(replacement).not.toBe(launcher);
    expect(replacement.operationId).toBeUndefined();
    expect(sent).toEqual([
      { type: 'runtime_binding_started', bindingId: replacement.bindingId },
      { type: 'runtime_binding', bindingId: replacement.bindingId, identity },
    ]);
  });
  it('holds a ready edge through refusal and delivers it once to an assigned same-lineage successor', async () => {
    vi.useFakeTimers();
    const s = fixture(); const execution = s.controller.admitInput('opening-turn', 1);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const launcher = scope.beginRuntime(undefined, 'cli-lineage');
    scope.assign(launcher.bindingId, s.runtime); scope.rememberExecution(execution, launcher);
    scope.noteAdmission({ ref: execution, phase: 'queued' });
    const refused = scope.beginRuntime(undefined, launcher.physicalId);
    refused.proposedRuntime = s.controller.reserveBinding(refused.bindingId, s.worker);
    scope.rememberExecution(execution, refused);
    refused.identity = { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' };
    const env: any = { workerSessionEventScope: scope, fenceContractBackendWrites: vi.fn(),
      runtimeIdentityForContract: (binding: any) => binding.identity,
      confirmedRuntimeIdentityChanged, publishRuntimeContract: vi.fn() };
    env.bindSessionRuntimeCallback = loadWorkerFunction('bindSessionRuntimeCallback', env);
    const bindReady = loadWorkerFunction<(callback: () => void) => () => void>('bindSessionRuntimeReadyCallback', env);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const wire: any[] = []; const callback = vi.fn(() => {
      scope.recordSubmission('opening-turn', 1);
      wire.push(metadata({ type: 'prompt_ready' }));
      wire.push(metadata({ type: 'turn_execution_started', turnId: 'opening-turn', dispatchAttempt: 1, startedAtMs: Date.now() }));
    });
    const ready = scope.run(refused, () => bindReady(callback), execution);

    ready();
    expect(callback).not.toHaveBeenCalled(); expect(wire).toEqual([]);
    expect(scope.canSubmit('opening-turn', 1)).toBe(true);
    s.controller.beginControl('cancel', 'cancel-during-ready', execution);
    s.controller.controlStarted('cancel-during-ready');
    scope.refuseBinding(refused.bindingId);
    s.controller.abandonBinding(refused.bindingId, s.worker, 'refusal', 'runtime_binding_refused');
    s.controller.controlResult('cancel-during-ready', 'rejected');
    const successor = scope.beginRuntime(undefined, launcher.physicalId);
    const runtime = s.controller.reserveBinding(successor.bindingId, s.worker);
    s.controller.bindRuntime(successor.bindingId, s.worker, successor.identity = {
      backend: 'tmux', physicalId: '222:start2', proof: 'process_start',
    });
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', {
      workerSessionEventScope: scope, observedRuntimeBindingHandshakes: new Map(),
      activeRestartAttemptId: undefined, closeRequested: false,
      stopBridgeWatcher: vi.fn(), stopScreenshotLoop: vi.fn(), killCli: vi.fn(),
    });
    await receive({ type: 'runtime_contract_assigned', bindingId: successor.bindingId,
      runtime, mayExecute: true, admissionStates: [{ ref: execution, phase: 'queued' }], executions: [execution] });
    await vi.runAllTimersAsync();

    expect(callback).toHaveBeenCalledOnce(); expect(wire).toHaveLength(2);
    expect(wire[0].sessionContract).toMatchObject({ bindingId: successor.bindingId, scope: { runtime } });
    expect(wire[1].sessionContract.scope).toMatchObject({ runtime, execution });
    expect(s.controller.ingest(wire[0], s.worker).kind).toBe('current');
    expect(s.controller.ingest(wire[1], s.worker).kind).toBe('current');
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ runtime, phase: 'submitting' });
    expect(scope.canSubmit('opening-turn', 1)).toBe(false);
    expect(scope.flushReady(successor.bindingId)).toBe(false);
    expect(callback).toHaveBeenCalledOnce();
  });
  it('requires the admitted full attempt even for a worker-scoped queued ACK', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA', 1);
    const ack = { type: 'turn_input_committed', turnId: 'turnA', dispatchAttempt: 1, sessionContract: s.context(1, { execution: { ...execution, executionId: 'never-admitted' } }) };
    expect(s.controller.ingest(ack, s.worker).kind).toBe('reject');
    expect(s.controller.ingest({ ...ack, sessionContract: s.context(2, { execution }) }, s.worker).kind).toBe('worker');
  });
  it('restores managed turn authority before a queued attempt has execution evidence', async () => {
    const s = fixture(); const execution = s.controller.admitInput('restored-turn', 1);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    scope.noteAdmission({ ref: execution, phase: 'queued' });
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const worker: any = { send: vi.fn() }; s.ds.worker = worker;
    const handlerScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      logger: { debug: vi.fn(), warn: vi.fn() }, t: 'test', botCfg: {}, sessionCliId: () => 'claude-code',
      currentGatewayCallerOpenId: () => 'ou_requester', currentTurnProcessIdentities: () => ['111:start1'],
      noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn() };
    const legacy = vi.fn(loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', handlerScope));
    handlerScope.handleLegacyWorkerMessage = legacy;
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    const publish = scope.run(binding, () => metadata({ type: 'managed_turn_origin', sessionId: s.ref.sessionId,
      turnId: 'restored-turn', dispatchAttempt: 1, capability: 'restored-capability' }));
    await handler(publish);
    expect(legacy).toHaveBeenCalledWith(publish);
    expect(s.ds.managedTurnOrigin).toMatchObject({ capability: 'restored-capability', turnId: 'restored-turn', dispatchAttempt: 1 });
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
    const revoke = scope.run(binding, () => metadata({ type: 'managed_turn_origin_revoked', sessionId: s.ref.sessionId,
      turnId: 'restored-turn', dispatchAttempt: 1, capability: 'restored-capability' }));
    await handler(revoke);
    expect(legacy).toHaveBeenCalledWith(revoke);
    expect(s.ds.managedTurnOrigin).toBeUndefined();
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('rejects queued turn authority from unproven attempts and superseded runtimes or workers', () => {
    const s = fixture(); const execution = s.controller.admitInput('queued-turn', 1);
    let sequence = 0;
    const event = (type: string, runtime = s.runtime, admitted = execution) => ({ type, turnId: 'queued-turn', dispatchAttempt: 1,
      sessionContract: s.context(++sequence, { runtime, execution: admitted }) });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type, s.runtime, { ...execution, executionId: 'unadmitted' }), s.worker).kind).toBe('reject');
      expect(s.controller.ingest({ ...event(type), dispatchAttempt: 2 }, s.worker).kind).toBe('reject');
    }
    const next = s.controller.reserveBinding('authority-next', s.worker);
    s.controller.bindRuntime('authority-next', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type), s.worker).kind).toBe('reject');
      expect(s.controller.ingest(event(type, next), s.worker).kind).toBe('current');
    }
    s.controller.bindWorker(2);
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type, next), s.worker).kind).toBe('reject');
    }
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('does not grant managed authority to an unbound attempt that is reconciling or terminal', () => {
    const s = fixture(); const execution = s.controller.admitInput('lost-turn', 1);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'reconciling', evidence: 'observer_loss' });
    let sequence = 0;
    const event = (type: string) => ({ type, turnId: 'lost-turn', dispatchAttempt: 1,
      sessionContract: s.context(++sequence, { runtime: s.runtime, execution }) });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type), s.worker).kind).toBe('reject');
    }
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'succeeded', evidence: 'native_terminal' });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type), s.worker).kind).toBe('reject');
    }
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'succeeded' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('rejects managed authority without an ExecutionRef before creating an unknown attempt', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const worker: any = { send: vi.fn() }; s.ds.worker = worker;
    const legacy = vi.fn();
    const handlerScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      logger: { debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    const revision = s.store.read(s.ref)?.revision;
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      const wire = scope.run(binding, () => metadata({ type, sessionId: s.ref.sessionId, turnId: 'never-admitted', capability: 'unknown-capability' }));
      expect(wire.sessionContract.scope.execution).toBeUndefined();
      await handler(wire);
    }
    expect(legacy).not.toHaveBeenCalled();
    expect(s.ds.managedTurnOrigin).toBeUndefined();
    expect(s.store.executions(s.ref)).toHaveLength(0);
    expect(s.store.read(s.ref)?.revision).toBe(revision);
  });
  it('publishes process attestation while the opening attempt is still unbound', async () => {
    const s = fixture(); const execution = s.controller.admitInput('opening-turn', 1);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    scope.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const wire = scope.run(binding, () => metadata({ type: 'local_process_attestation', backendType: 'tmux',
      credentialIsolated: false, cliPid: 111, cliProcStart: 'start1' }), execution);
    const worker: any = { send: vi.fn() }; s.ds.worker = worker; s.ds.workerGeneration = 1;
    const handlerScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      logger: { debug: vi.fn() }, t: 'test', botCfg: {}, sessionCliId: () => 'claude-code' };
    handlerScope.handleLegacyWorkerMessage = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', handlerScope);
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    await handler(wire);
    expect(s.ds.localProcessAttestation).toMatchObject({ cliPid: 111, cliProcStart: 'start1', workerGeneration: 1 });
    expect(wire.sessionContract.scope).toEqual({ runtime: s.runtime });
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('keeps a frozen callback origin through the actual metadata wrapper', async () => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const old = scope.beginRuntime('restart-old'); scope.assign(old.bindingId, s.runtime);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const sent: any[] = [];
    scope.run(old, () => { setTimeout(scope.bind(() => sent.push(metadata({ type: 'restart_result', attemptId: 'restart-new', status: 'succeeded' }))), 10); }, undefined, 'restart-old');
    scope.beginRuntime('restart-new'); await vi.advanceTimersByTimeAsync(11);
    expect(sent[0].sessionContract.scope).toMatchObject({ runtime: s.runtime, operationId: 'restart-old' });
    expect(s.controller.ingest(sent[0], s.worker).kind).toBe('reject');
  });
  it('uses the current cancel operation on a runtime born under a previous restart', () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime('completed-restart'); scope.assign(binding.bindingId, s.runtime);
    const execution = s.controller.admitInput('turnA', 1); scope.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const reply = scope.run(binding, () => metadata({ type: 'turn_interrupt_result', turnId: 'turnA', requestId: 'cancel-current', delivered: true }), execution, 'cancel-current');
    expect(reply.sessionContract.scope.operationId).toBe('cancel-current');
    expect(reply.sessionContract.scope.execution).toEqual(execution);
  });
  it('does not issue a start permit when the worker changes during the reservation await', async () => {
    const s = fixture(); const send = vi.fn(); const worker: any = { send }; s.ds.worker = worker;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope); scope.handleWorkerMessage = handler;
    const pending = handler({ type: 'runtime_binding_started', bindingId: 'binding-start', sessionContract: { ...s.context(1, {}), bindingId: 'binding-start' } });
    s.controller.bindWorker(2); s.ds.worker = { send: vi.fn() } as any; await pending;
    expect(send.mock.calls.some(([message]) => message.type === 'runtime_contract_reserved' && message.mayStart)).toBe(false);
  });
  it('reconciles a timed-out cancellation from native completion and leaves output intact', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA', 1); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl('cancel', 'cancel1', execution); s.controller.controlStarted('cancel1'); s.controller.controlResult('cancel1', 'uncertain');
    s.controller.ingest({ type: 'turn_terminal', turnId: 'turnA', dispatchAttempt: 1, status: 'completed', sessionContract: s.context(1, { runtime: s.runtime, execution }) }, s.worker);
    expect(s.controller.allowsInput()).toBe(true); expect(s.store.execution(s.ref, execution.executionId)?.phase).toBe('succeeded');
  });
  it('preserves suspend intent after a rejected close and never reuses an allocated epoch on restore', () => {
    const s = fixture(); s.controller.beginControl('suspend', 'suspend1'); s.controller.controlResult('suspend1', 'confirmed');
    s.controller.beginControl('close', 'close1'); s.controller.controlResult('close1', 'rejected');
    expect(s.store.read(s.ref)?.lifecycle).toBe('suspended');
    const snapshot = s.store.snapshot(s.ref); const unused = s.store.reserveRuntime(s.ref, s.worker);
    s.store.restore(snapshot); expect(s.store.reserveRuntime(s.ref, s.worker).epoch).toBeGreaterThan(unused.epoch);
  });
  it('does not let an already confirmed binding change physical identity', () => {
    const s = fixture(); expect(() => s.controller.bindRuntime('binding-old', s.worker, { backend: 'tmux', physicalId: 'other-process', nativeSessionId: 'other-native', proof: 'process_start' })).toThrow('runtime_identity_changed');
    expect(s.store.runtime(s.ref)?.identity?.physicalId).toBe('111:start1');
  });
  it('rejects a conflicting output sidecar before any output or attempt write', () => {
    const s = fixture(); const a = s.controller.admitInput('turnA'); const b = s.controller.admitInput('turnB');
    const before = s.store.execution(s.ref, a.executionId)!;
    const admission = s.controller.ingest({ type: 'final_output', turnId: 'turnA', content: 'body from B',
      sessionContract: s.context(1, { runtime: s.runtime, execution: a }),
      sessionOutputOrigin: s.context(2, { runtime: s.runtime, execution: b }) }, s.worker);
    expect(admission.kind).toBe('reject'); expect(s.store.execution(s.ref, a.executionId)).toEqual(before);
  });
  it('does not treat different native generations as one physical executor', () => {
    const s = fixture(); const old = s.controller.reserveBinding('remote-old', s.worker);
    s.controller.bindRuntime('remote-old', s.worker, { backend: 'remote-runner', physicalId: 'remote1', proof: 'native_generation', nativeGeneration: '1', nativeSessionId: 'thread1' });
    const next = s.controller.reserveBinding('remote-next', s.worker);
    s.controller.bindRuntime('remote-next', s.worker, { backend: 'remote-runner', physicalId: 'remote1', proof: 'native_generation', nativeGeneration: '2', nativeSessionId: 'thread2' });
    s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2, { runtime: next }) }, s.worker);
    s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: s.context(3, { runtime: old }) }, s.worker);
    expect(s.store.runtime(s.ref)?.phase).toBe('ready'); expect(s.ds.cliReady).toBe(true);
    expect(s.controller.nativeSignal('remote-old', 'thread2')).toBeUndefined();
  });
  it('restores the real reservation-only wire scope without binding or resubmitting its original attempt', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnQ');
    const original = new WorkerSessionEventScope(s.ref, s.worker); const binding = original.beginRuntime();
    s.controller.reserveBinding(binding.bindingId, s.worker); original.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: original });
    const wire = original.run(binding, () => metadata({ type: 'final_output', sessionId: s.ref.sessionId, turnId: 'turnQ', content: 'saved answer', lastUuid: 'nativeQ' }), execution);
    expect(wire.sessionContract.scope.runtime).toBeUndefined();
    const stored = outputSnapshot(s.appId, wire); const nextWorker = s.controller.bindWorker(2).worker;
    const carrier = new WorkerSessionEventScope(s.ref, nextWorker); const sent: any[] = [];
    const recovery = new UniversalOutputHandoff({ appId: s.appId, sessionId: s.ref.sessionId, token: 'new', persist: vi.fn(), remove: vi.fn(), restore: () => [stored], send: value => sent.push(value), context: value => carrier.replayEnvelope(value), error: error => { throw error; } });
    recovery.start(); recovery.stop(); const origin = s.controller.outputOrigin(sent[0].sessionOutputOrigin)!;
    expect(s.controller.ingest(sent[0], nextWorker, origin).kind).toBe('historical');
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued', output: { content: 'saved answer' } });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined(); expect(s.store.executions(s.ref)).toHaveLength(1);
  });
  it('uses each native turn origin on a long-lived subscription and freezes work after event admission', async () => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const first = scope.beginRuntime(); scope.assign(first.bindingId, s.runtime);
    const a = s.controller.admitInput('turnA'); scope.rememberExecution(a, first);
    const received: any[] = [];
    const callback = scope.run(first, () => scope.bindExecutionEvent((turnId: string) => {
      setTimeout(scope.bind(() => received.push(scope.envelope())), 10);
    }, args => ({ turnId: args[0] })), a);
    const next = scope.beginRuntime(undefined, first.physicalId); scope.assign(next.bindingId, { runtimeId: 'semantic2', epoch: 2 });
    const b = s.controller.admitInput('turnB'); scope.rememberExecution(b, next);
    callback('turnB'); scope.beginRuntime(undefined, first.physicalId); await vi.advanceTimersByTimeAsync(11);
    expect(received[0].scope.runtime).toEqual(next.runtime); expect(received[0].scope.execution).toEqual(b);
  });
  it('keeps old timer observations separate from timers created by the new live data scope', async () => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const first = scope.beginRuntime(); scope.assign(first.bindingId, s.runtime); const received: any[] = [];
    const callback = scope.run(first, () => scope.bindObservation(() => received.push(scope.envelope())));
    scope.run(first, () => setTimeout(scope.bind(callback), 10));
    const next = scope.beginRuntime(undefined, first.physicalId); scope.assign(next.bindingId, { runtimeId: 'semantic2', epoch: 2 });
    scope.run(next, () => setTimeout(scope.bind(callback), 10)); await vi.advanceTimersByTimeAsync(11);
    expect(received.map(value => value.scope.runtime)).toEqual([first.runtime, next.runtime]);
  });
  it('prevents a literal submission from becoming a second submission after runtime replacement', () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker); const first = scope.beginRuntime(); scope.assign(first.bindingId, s.runtime);
    const execution = s.controller.admitInput('turnA'); scope.rememberExecution(execution, first); expect(scope.canSubmit('turnA')).toBe(true);
    const mark = loadWorkerFunction<(turnId: string) => void>('markTurnExecutionStart', { workerSessionEventScope: scope,
      turnExecutionClock: { start: vi.fn() }, inputDeliveryEvidence: { start: vi.fn() }, cliSpawnGeneration: 1, send: vi.fn() });
    scope.run(first, () => mark('turnA'), execution); const next = scope.beginRuntime(); scope.assign(next.bindingId, { runtimeId: 'replacement', epoch: 2 });
    expect(scope.canSubmit('turnA')).toBe(false);
    const restored = new WorkerSessionEventScope(s.ref, s.worker); restored.noteAdmission({ ref: execution, runtime: s.runtime, phase: 'reconciling' });
    expect(restored.canSubmit('turnA')).toBe(false);
  });
  it('does not treat an ambiguous compact lookup as a fresh submission', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const a = s.controller.admitInput('turnA', 1); const b = s.controller.admitInput('turnA', 2);
    scope.noteAdmission({ ref: a, runtime: s.runtime, phase: 'succeeded' }); scope.noteAdmission({ ref: b, runtime: s.runtime, phase: 'reconciling' });
    expect(scope.canSubmit('turnA')).toBe(false); expect(scope.canSubmit('turnA', undefined, b)).toBe(false);
    const starts: string[] = []; const reservations = new Map();
    const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', { workerSessionEventScope: scope, pendingRuntimeReservations: reservations,
      activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: true,
      send: (message: any) => { if (message.type === 'runtime_binding_started') reservations.get(message.bindingId)(true); },
      spawnCliBody: async (cfg: any) => { starts.push(cfg.prompt); }, publishRuntimeContract: async () => {}, CliSpawnSupersededError: Error });
    await spawn({ turnId: 'turnA', prompt: 'must not replay', sessionCommand: { version: 2, execution: b } });
    expect(starts).toEqual(['']);
  });
  it('commits lifecycle, revision and dedup together or rolls the entire write back', () => {
    const s = fixture(); const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    db.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY,status TEXT,row TEXT); CREATE TRIGGER fail_projection BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'projection_failed'); END;");
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(s.ref.sessionId, 'active', JSON.stringify(s.ds.session));
    const before = s.store.read(s.ref)!; const operation = { operationId: 'close-atomic', kind: 'close' as const, phase: 'planned' as const, targetRuntime: s.runtime, expectedRevision: before.revision };
    expect(() => s.store.apply(s.ref, { type: 'control_requested', operation }, 'close-event')).toThrow('projection_failed');
    expect(s.store.read(s.ref)).toEqual(before); expect(s.store.operation(s.ref, operation.operationId)).toBeUndefined();
    db.exec('DROP TRIGGER fail_projection'); expect(s.store.apply(s.ref, { type: 'control_requested', operation }, 'close-event').decision).toBe('applied');
    const row = JSON.parse((db.prepare('SELECT row FROM sessions').get() as any).row);
    expect(row.sessionContractRevision).toBe(s.store.read(s.ref)?.revision); expect(row.sessionLifecycle).toBe('closing');
  });
  it('keeps output hashes and the original attempt while a new producer replays', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    const origin = s.context(1, { runtime: s.runtime, execution }); const plain = { type: 'final_output' as const, sessionId: s.ref.sessionId, turnId: 'turnA', content: 'answer', lastUuid: 'native-final' };
    const stored: OutputSnapshot = outputSnapshot(s.appId, { ...plain, sessionContract: origin });
    expect(stored.fingerprint).toBe(outputSnapshot(s.appId, plain).fingerprint); expect(stored.id).toBe(outputSnapshot(s.appId, plain).id);
    const carrier = new WorkerSessionEventScope(s.ref, { workerId: 'new-worker', generation: 2 }); const sent: any[] = [];
    const handoff = new UniversalOutputHandoff({ appId: s.appId, sessionId: s.ref.sessionId, token: 'token2', persist: vi.fn(), remove: vi.fn(), restore: () => [stored], send: output => sent.push(output), context: value => carrier.replayEnvelope(value), error: error => { throw error; } });
    handoff.start(); handoff.stop();
    expect(sent[0].sessionOutputOrigin.scope.execution).toEqual(execution); expect(sent[0].sessionContract.producer).toEqual(carrier.worker);
    expect(s.controller.gateway.admit('final_output', sent[0].sessionContract, carrier.worker, s.controller.outputOrigin(sent[0].sessionOutputOrigin)).kind).toBe('historical');
  });
  it('rebuilds a versioned result from persistent facts and retains the earlier snapshot', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'reconciling', evidence: 'observer_loss' });
    s.store.apply(s.ref, { type: 'execution_output', execution, output: { availability: 'available', content: 'partial', completeness: 'partial' } });
    const ref = { botId: s.appId, sessionId: s.ref.sessionId, turnId: 'turnA' };
    const first = new PersistentTurnResultStore(s.data).readContract(ref)!;
    const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    reopened.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'failed', evidence: 'native_terminal', errorCode: 'provider_failed' });
    const next = new PersistentTurnResultStore(s.data).readContract(ref)!;
    expect(next.execution).toMatchObject({ phase: 'failed', output: { content: 'partial', completeness: 'partial' } });
    expect(next.resultRevision).toBeGreaterThan(first.resultRevision); expect(first.execution.phase).toBe('reconciling');
    expect(new PersistentTurnResultStore(s.data).read(ref)).toMatchObject({ status: 'ready', result: { execution: { status: 'failed' }, output: { status: 'available', content: 'partial' } } });
  });
  it('advances result revision when the delivery journal changes without changing execution truth', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'succeeded', evidence: 'native_terminal' });
    const journal = new OutputDeliveryJournal(s.data, s.appId); handles.push(journal);
    const output = { type: 'final_output' as const, sessionId: s.ref.sessionId, turnId: 'turnA', content: 'answer', lastUuid: 'final1', sessionContract: s.context(1, { runtime: s.runtime, execution }) };
    const snapshot = outputSnapshot(s.appId, output); const record = journal.accept(snapshot, { kind: 'managed' });
    const reader = new PersistentTurnResultStore(s.data); const ref = { botId: s.appId, sessionId: s.ref.sessionId, turnId: 'turnA' };
    const first = reader.readContract(ref)!; expect(journal.claim(record.id, 'owner')).toBe(true);
    const next = reader.readContract(ref)!;
    expect(first.outputs[0].state).toBe('pending'); expect(next.outputs[0].state).toBe('processing');
    expect(next.execution.phase).toBe('succeeded'); expect(next.resultRevision).toBeGreaterThan(first.resultRevision);
  });
  it.each(['restart', 'interrupt_turn', 'suspend', 'close_commit', 'raw_input', 'term_action', 'inject_command', 'session_ready', 'turn_idle'])('requires a frozen RuntimeRef for %s', type => {
    const s = fixture(); expect(admitSessionCommand(type, { version: 2, operationId: 'op' }, s.runtime, 'op').allowed).toBe(false);
  });
  it('keeps contract enforcement active even with a legacy environment switch', () => {
    vi.stubEnv('BOTMUX_SESSION_CONTRACT_V2', '0'); const s = fixture();
    const controller = controllerForSession(s.ds, true)!;
    expect(controller).toBeDefined(); expect(controller.ingest({ type: 'ready' }, s.worker).kind).toBe('reject');
  });
});
