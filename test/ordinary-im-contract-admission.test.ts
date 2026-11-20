import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const { getBotMock } = vi.hoisted(() => ({
  getBotMock: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getMessageChatId: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import { controllerForSession } from '../src/core/session-controller.js';
import {
  __testOnly_setupWorkerHandlers,
  ensureReadonlyTaskContinuationAttached,
  initWorkerPool,
  promoteQueuedActivationTail,
  sendWorkerInput,
  sendWorkerSessionInput,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { disposeReadonlyTaskContinuation } from '../src/services/readonly-task-continuation.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import * as sessionStore from '../src/services/session-store.js';

const APP_ID = 'cli_ordinary_im_contract_test';
let dataDir: string;
let previousDataDir: string;
const openStores: Array<{ close(): void }> = [];

function createActiveFixture() {
  sessionStore.init(APP_ID);
  const session = sessionStore.createSession('oc_group', 'om_root', 'scheduled follow-up', 'group');
  session.larkAppId = APP_ID;
  session.scope = 'thread';
  session.cliId = 'traex';
  session.backendType = 'tmux';
  session.workerGeneration = 1;
  session.replyTargets = {
    om_followup_1: {
      replyToMessageId: 'om_followup_1',
      senderOpenId: 'ou_user_1',
      updatedAt: new Date().toISOString(),
    },
  };
  sessionStore.updateSession(session);

  const sent: Array<{ message: any; hasCallback: boolean }> = [];
  const worker = new EventEmitter() as any;
  worker.pid = process.pid;
  worker.killed = false;
  worker.connected = true;
  worker.exitCode = null;
  worker.signalCode = null;
  worker.kill = vi.fn();
  worker.send = vi.fn((message: any, cb?: (err: Error | null) => void) => {
    sent.push({ message, hasCallback: typeof cb === 'function' });
    if (typeof cb === 'function') queueMicrotask(() => cb(null));
    return true;
  });

  const ds = {
    larkAppId: APP_ID,
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    worker,
    workerGeneration: 1,
    cliReadyGeneration: 0,
    session,
    initConfig: { backendType: 'tmux', cliId: 'traex' },
    // Simulate revoked policy-only stub left after Turn 1 (scheduled run) completed.
    managedTurnOrigin: {
      capability: 'stale-revoked-stub-capability',
      policyCapability: 'policy-cap-1',
    },
  } as unknown as DaemonSession;

  const controller = controllerForSession(ds, true)!;
  expect(controller).toBeDefined();
  openStores.push(controller.store);
  const bootstrap = controller.bindWorker(1);
  ds.initConfig = { ...ds.initConfig, sessionContract: bootstrap } as any;
  const runtime = controller.reserveBinding('binding-initial', bootstrap.worker);
  controller.bindRuntime('binding-initial', bootstrap.worker, {
    backend: 'tmux',
    physicalId: `${process.pid}:start1`,
    proof: 'process_start',
  });

  const workerScope = new WorkerSessionEventScope(bootstrap.session, bootstrap.worker);
  const binding = workerScope.beginRuntime();
  workerScope.assign(binding.bindingId, runtime);

  const registry = new Map([[activeSessionKey(ds), ds]]);
  setActiveSessionsRegistry(registry);
  __testOnly_setupWorkerHandlers(ds, worker, { ready: false, failureNotified: false }, 1);

  const emitScoped = (msg: Record<string, unknown>, execution?: { executionId: string; turnId: string; dispatchAttempt?: number }) => {
    const context = workerScope.envelope({
      bindingId: binding.bindingId,
      runtime,
      ...(execution ? { execution } : {}),
    });
    worker.emit('message', { ...msg, sessionContract: context });
  };

  emitScoped({ type: 'ready' });
  emitScoped({ type: 'prompt_ready' });

  return { session, ds, worker, sent, controller, workerScope, binding, runtime, emitScoped };
}

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-ordinary-im-contract-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  getBotMock.mockReturnValue({
    resolvedAllowedUsers: [],
    config: { cliId: 'traex' },
  });
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveSessionsRegistry(new Map());
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  config.session.dataDir = previousDataDir;
  sessionStore.init('test-app');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ordinary IM follow-up contract admission', () => {
  it('admits the execution, stamps sessionCommand/turnCallerOpenId, and accepts managed_turn_origin before turn_execution_started', async () => {
    const f = createActiveFixture();
    await new Promise(resolve => setTimeout(resolve, 20));

    const ok = sendWorkerInput(f.ds, 'Resume the Changelog updates', 'om_followup_1', {
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
    });
    expect(ok).toBe(true);

    // Must have taken the tracked ordinary-IM path (worker.send with callback)
    // AND stamped both sessionCommand.execution and turnCallerOpenId.
    const outbound = f.sent.find(entry => entry.message?.type === 'message');
    expect(outbound).toBeDefined();
    expect(outbound!.hasCallback).toBe(true);
    expect(outbound!.message.turnId).toBe('om_followup_1');
    expect(outbound!.message.turnCallerOpenId).toBe('ou_user_1');
    expect(outbound!.message.sessionCommand).toMatchObject({
      version: 2,
      execution: {
        turnId: 'om_followup_1',
      },
    });
    const execution = outbound!.message.sessionCommand.execution;
    expect(f.controller.store.executions(f.controller.ref, 'om_followup_1')).toHaveLength(1);

    // Worker remembers the admitted execution from sessionCommand and emits
    // managed_turn_origin BEFORE turn_execution_started (exact flushPending order).
    f.workerScope.rememberExecution(execution, f.binding);
    f.emitScoped({ type: 'turn_input_received', turnId: 'om_followup_1' }, execution);
    f.emitScoped({ type: 'turn_input_committed', turnId: 'om_followup_1' }, execution);
    f.emitScoped({
      type: 'managed_turn_origin',
      sessionId: f.session.sessionId,
      capability: 'live-cap-followup-1',
      policyCapability: 'policy-cap-1',
      turnId: 'om_followup_1',
      identityTurnId: 'om_followup_1',
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
    }, execution);
    f.emitScoped({ type: 'turn_execution_started', turnId: 'om_followup_1', startedAtMs: Date.now() }, execution);

    await vi.waitFor(() => {
      expect(f.ds.managedTurnOrigin).toMatchObject({
        capability: 'live-cap-followup-1',
        turnId: 'om_followup_1',
        identityTurnId: 'om_followup_1',
        callerOpenId: 'ou_user_1',
      });
    });
  });

  it('refuses tracked ordinary IM input when the session contract is closing', () => {
    const f = createActiveFixture();
    f.controller.beginControl('close');

    const ok = sendWorkerInput(f.ds, 'Late follow-up', 'om_followup_1');
    expect(ok).toBe(false);
    expect(f.sent.some(entry => entry.message?.type === 'message')).toBe(false);
    expect(f.controller.store.executions(f.controller.ref, 'om_followup_1')).toHaveLength(0);
  });

  it('admits a follow-up ordinary IM turn after an in-worker restart to a new runtime epoch', async () => {
    const f = createActiveFixture();
    await new Promise(resolve => setTimeout(resolve, 20));

    // Simulate an in-worker /restart binding a new runtime epoch on the same worker.
    const { operation } = f.controller.beginControl('restart');
    f.controller.controlStarted(operation.operationId);
    const nextBinding = f.workerScope.beginRuntime(operation.operationId);
    const nextRuntime = f.controller.reserveBinding(nextBinding.bindingId, f.workerScope.worker);
    f.controller.bindRuntime(nextBinding.bindingId, f.workerScope.worker, {
      backend: 'tmux',
      physicalId: `${process.pid}:start2`,
      proof: 'process_start',
    }, operation.operationId);
    f.workerScope.assign(nextBinding.bindingId, nextRuntime);
    f.worker.emit('message', {
      type: 'prompt_ready',
      sessionContract: f.workerScope.envelope({ bindingId: nextBinding.bindingId, runtime: nextRuntime }),
    });
    f.worker.emit('message', {
      type: 'restart_result',
      attemptId: operation.operationId,
      status: 'succeeded',
      category: 'prompt_ready',
      sessionContract: f.workerScope.envelope({ bindingId: nextBinding.bindingId, runtime: nextRuntime, operationId: operation.operationId }),
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    const ok = sendWorkerInput(f.ds, 'Resume after restart', 'om_followup_1', {
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
    });
    expect(ok).toBe(true);

    const outbound = f.sent.find(entry => entry.message?.type === 'message');
    expect(outbound?.hasCallback).toBe(true);
    const execution = outbound?.message?.sessionCommand?.execution;
    expect(execution).toMatchObject({ turnId: 'om_followup_1' });

    f.workerScope.rememberExecution(execution, nextBinding);
    f.worker.emit('message', {
      type: 'managed_turn_origin',
      sessionId: f.session.sessionId,
      capability: 'live-cap-post-restart',
      policyCapability: 'policy-cap-1',
      turnId: 'om_followup_1',
      identityTurnId: 'om_followup_1',
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
      sessionContract: f.workerScope.envelope({ bindingId: nextBinding.bindingId, runtime: nextRuntime, execution }),
    });
    f.worker.emit('message', {
      type: 'turn_execution_started',
      turnId: 'om_followup_1',
      startedAtMs: Date.now(),
      sessionContract: f.workerScope.envelope({ bindingId: nextBinding.bindingId, runtime: nextRuntime, execution }),
    });

    await vi.waitFor(() => {
      expect(f.ds.managedTurnOrigin).toMatchObject({
        capability: 'live-cap-post-restart',
        turnId: 'om_followup_1',
        identityTurnId: 'om_followup_1',
        callerOpenId: 'ou_user_1',
      });
    });
  });

  it('admits queued activation tail promotion and accepts managed_turn_origin before turn_execution_started', async () => {
    const f = createActiveFixture();
    await new Promise(resolve => setTimeout(resolve, 20));

    f.session.queuedActivationTail = [
      {
        id: 'tail-1',
        order: 1,
        turnId: 'om_queued_1',
        userPrompt: 'Run queued follow-up',
        cliInput: {
          content: 'Run queued follow-up',
          trustedCaller: {
            requestLarkAppId: APP_ID,
            requestUserOpenId: 'ou_user_1',
            senderType: 'user',
          },
        },
        createdAt: new Date().toISOString(),
      },
    ];
    sessionStore.updateSession(f.session);

    expect(promoteQueuedActivationTail(f.ds)).toBe(true);

    const outbound = f.sent.find(entry => entry.message?.type === 'message');
    expect(outbound).toBeDefined();
    expect(outbound!.message.turnId).toBe('om_queued_1');
    expect(outbound!.message.turnCallerOpenId).toBe('ou_user_1');
    expect(outbound!.message.sessionCommand).toMatchObject({
      version: 2,
      execution: { turnId: 'om_queued_1' },
    });
    const execution = outbound!.message.sessionCommand.execution;
    expect(f.controller.store.executions(f.controller.ref, 'om_queued_1')).toHaveLength(1);

    f.workerScope.rememberExecution(execution, f.binding);
    f.emitScoped({
      type: 'managed_turn_origin',
      sessionId: f.session.sessionId,
      capability: 'live-cap-queued-1',
      policyCapability: 'policy-cap-1',
      turnId: 'om_queued_1',
      identityTurnId: 'om_queued_1',
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
    }, execution);
    f.emitScoped({ type: 'turn_execution_started', turnId: 'om_queued_1', startedAtMs: Date.now() }, execution);

    await vi.waitFor(() => {
      expect(f.ds.managedTurnOrigin).toMatchObject({
        capability: 'live-cap-queued-1',
        turnId: 'om_queued_1',
        identityTurnId: 'om_queued_1',
        callerOpenId: 'ou_user_1',
      });
    });
  });

  it('refuses queued activation tail promotion when the session contract is closing', () => {
    const f = createActiveFixture();
    f.session.queuedActivationTail = [
      {
        id: 'tail-closing',
        order: 1,
        turnId: 'om_queued_closing',
        userPrompt: 'Late queued follow-up',
        cliInput: { content: 'Late queued follow-up' },
        createdAt: new Date().toISOString(),
      },
    ];
    sessionStore.updateSession(f.session);
    f.controller.beginControl('close');

    expect(promoteQueuedActivationTail(f.ds)).toBe(false);
    expect(f.sent.some(entry => entry.message?.type === 'message')).toBe(false);
    expect(f.session.queuedActivationTail).toHaveLength(1);
    expect(f.controller.store.executions(f.controller.ref, 'om_queued_closing')).toHaveLength(0);
  });

  it('admits readonly task continuation dispatches with dispatchAttempt and accepts managed_turn_origin', async () => {
    const prevFlag = process.env.BOTMUX_TASK_CONTINUATION_ENABLED;
    process.env.BOTMUX_TASK_CONTINUATION_ENABLED = 'true';
    const f = createActiveFixture();
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      disposeReadonlyTaskContinuation(f.session);
      f.ds.taskContinuationRpcProof = { workerGeneration: 1, rpcGeneration: 1 };
      const now = Date.now();
      f.session.replyTargets = {
        ...f.session.replyTargets,
        om_cont_1: {
          replyToMessageId: 'om_cont_1',
          senderOpenId: 'ou_user_1',
          updatedAt: new Date(now).toISOString(),
        },
      };
      f.session.readonlyTaskContinuation = {
        leaseId: 'lease-contract-1',
        logicalTurnId: 'om_cont_1',
        currentTurnId: 'om_cont_1',
        currentDispatchAttempt: 1,
        currentWorkerGeneration: 1,
        authorizationMode: 'inherited',
        startMode: 'explicit',
        trustedCaller: {
          requestLarkAppId: APP_ID,
          requestUserOpenId: 'ou_user_1',
          senderType: 'user',
        },
        status: 'backoff',
        continuationsStarted: 0,
        maxContinuations: 3,
        createdAt: now - 5_000,
        updatedAt: now - 1_000,
        expiresAt: now + 60_000,
        nextAttemptAt: now - 1_000,
      };
      sessionStore.updateSession(f.session);

      expect(ensureReadonlyTaskContinuationAttached(f.ds)).toBe(true);

      await vi.waitFor(() => {
        expect(f.sent.some(entry => entry.message?.type === 'message')).toBe(true);
      });
      const outbound = f.sent.find(entry => entry.message?.type === 'message');
      const continuationTurnId = outbound!.message.turnId as string;
      expect(continuationTurnId).toMatch(/^bmx-continuation-/);
      expect(outbound!.message.dispatchAttempt).toBe(1);
      expect(outbound!.message.turnCallerOpenId).toBe('ou_user_1');
      expect(outbound!.message.sessionCommand).toMatchObject({
        version: 2,
        execution: { turnId: continuationTurnId, dispatchAttempt: 1 },
      });
      const execution = outbound!.message.sessionCommand.execution;
      expect(f.controller.store.executions(f.controller.ref, continuationTurnId, 1)).toHaveLength(1);

      f.workerScope.rememberExecution(execution, f.binding);
      f.emitScoped({
        type: 'managed_turn_origin',
        sessionId: f.session.sessionId,
        capability: 'live-cap-cont-1',
        policyCapability: 'policy-cap-1',
        turnId: continuationTurnId,
        identityTurnId: continuationTurnId,
        dispatchAttempt: 1,
        trustedCaller: {
          requestLarkAppId: APP_ID,
          requestUserOpenId: 'ou_user_1',
          senderType: 'user',
        },
      }, execution);
      f.emitScoped({
        type: 'turn_execution_started',
        turnId: continuationTurnId,
        dispatchAttempt: 1,
        startedAtMs: Date.now(),
      }, execution);

      await vi.waitFor(() => {
        expect(f.ds.managedTurnOrigin).toMatchObject({
          capability: 'live-cap-cont-1',
          turnId: continuationTurnId,
          dispatchAttempt: 1,
          callerOpenId: 'ou_user_1',
        });
      });
    } finally {
      disposeReadonlyTaskContinuation(f.session);
      if (prevFlag === undefined) delete process.env.BOTMUX_TASK_CONTINUATION_ENABLED;
      else process.env.BOTMUX_TASK_CONTINUATION_ENABLED = prevFlag;
    }
  });

  it('admits raw_input turnId and bundled followUpTurnId while preserving the live runtime target', async () => {
    const f = createActiveFixture();
    await new Promise(resolve => setTimeout(resolve, 20));
    f.session.replyTargets = {
      ...f.session.replyTargets,
      om_raw_1: {
        replyToMessageId: 'om_raw_1',
        senderOpenId: 'ou_user_1',
        updatedAt: new Date().toISOString(),
      },
    };
    sessionStore.updateSession(f.session);

    const ok = sendWorkerSessionInput(f.ds, {
      type: 'raw_input',
      content: '/review',
      turnId: 'om_raw_1',
      followUpContent: 'Inspect the diff',
      followUpTurnId: 'om_raw_followup_1',
    });
    expect(ok).toBe(true);

    const outbound = f.sent.find(entry => entry.message?.type === 'raw_input');
    expect(outbound).toBeDefined();
    expect(outbound!.message.turnCallerOpenId).toBe('ou_user_1');
    expect(admitSessionCommand('raw_input', outbound!.message.sessionCommand, f.runtime)).toEqual({ allowed: true });
    expect(outbound!.message.sessionCommand).toMatchObject({
      version: 2,
      runtime: f.runtime,
      execution: { turnId: 'om_raw_1' },
    });
    expect(outbound!.message.followUpExecution).toMatchObject({ turnId: 'om_raw_followup_1' });

    const rawExecution = outbound!.message.sessionCommand.execution;
    const followUpExecution = outbound!.message.followUpExecution;
    expect(f.controller.store.executions(f.controller.ref, 'om_raw_1')).toHaveLength(1);
    expect(f.controller.store.executions(f.controller.ref, 'om_raw_followup_1')).toHaveLength(1);

    f.workerScope.rememberExecution(rawExecution, f.binding);
    f.workerScope.rememberExecution(followUpExecution, f.binding);
    f.emitScoped({
      type: 'managed_turn_origin',
      sessionId: f.session.sessionId,
      capability: 'live-cap-raw-1',
      policyCapability: 'policy-cap-1',
      turnId: 'om_raw_1',
      identityTurnId: 'om_raw_1',
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
    }, rawExecution);
    f.emitScoped({ type: 'turn_execution_started', turnId: 'om_raw_1', startedAtMs: Date.now() }, rawExecution);

    await vi.waitFor(() => {
      expect(f.ds.managedTurnOrigin).toMatchObject({
        capability: 'live-cap-raw-1',
        turnId: 'om_raw_1',
        callerOpenId: 'ou_user_1',
      });
    });

    f.emitScoped({
      type: 'managed_turn_origin',
      sessionId: f.session.sessionId,
      capability: 'live-cap-raw-followup-1',
      policyCapability: 'policy-cap-1',
      turnId: 'om_raw_followup_1',
      identityTurnId: 'om_raw_followup_1',
      trustedCaller: {
        requestLarkAppId: APP_ID,
        requestUserOpenId: 'ou_user_1',
        senderType: 'user',
      },
    }, followUpExecution);
    f.emitScoped({ type: 'turn_execution_started', turnId: 'om_raw_followup_1', startedAtMs: Date.now() }, followUpExecution);

    await vi.waitFor(() => {
      expect(f.ds.managedTurnOrigin).toMatchObject({
        capability: 'live-cap-raw-followup-1',
        turnId: 'om_raw_followup_1',
        callerOpenId: 'ou_user_1',
      });
    });
  });
});
