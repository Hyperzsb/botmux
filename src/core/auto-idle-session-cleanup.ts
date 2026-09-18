import type { CloseSessionResult } from './worker-pool.js';
import type { DaemonSession } from './types.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';

export const AUTO_IDLE_SESSION_CLEANUP_SCAN_INTERVAL_MS = 60_000;
export const AUTO_IDLE_SESSION_CLEANUP_MUTATION_TIMEOUT_MS = 1_000;

export interface AutoIdleSessionCleanupSafety {
  isTransferring(ds: DaemonSession): boolean;
  isLifecycleInFlight(ds: DaemonSession): boolean;
}

export interface AutoIdleSessionCleanupOptions {
  now?: () => number;
  mutationAcquireTimeoutMs?: number;
}

export interface AutoIdleSessionCleanupResult {
  enabled: boolean;
  olderThanHours?: number;
  matched: number;
  closed: number;
  residual: number;
  failed: number;
  skipped: number;
  gateTimeouts: number;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function autoIdleSessionLastActivityAtMs(ds: DaemonSession): number | undefined {
  const candidates = [
    parseTime(ds.lastMessageAt),
    parseTime(ds.session.lastMessageAt),
    parseTime(ds.session.createdAt),
    parseTime(ds.spawnedAt),
  ].filter((value): value is number => value !== undefined);
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function hasDeferredInput(ds: DaemonSession): boolean {
  const pendingRepoInput = ds.pendingRepo === true && (
    (ds.pendingPrompt?.trim().length ?? 0) > 0
    || (ds.pendingFollowUps?.length ?? 0) > 0
    || (ds.pendingAttachments?.length ?? 0) > 0
    || (ds.pendingCodexAppText?.trim().length ?? 0) > 0
  );
  return pendingRepoInput
    || (ds.pendingRawInput?.trim().length ?? 0) > 0
    || (ds.pendingFollowUpInput?.cliInput?.trim().length ?? 0) > 0
    || (ds.pendingQueuedActivationFollowUps?.length ?? 0) > 0
    || (ds.queuedActivationTailAdmissionsOutstanding ?? 0) > 0
    || (ds.pendingWaitPromises?.size ?? 0) > 0
    || [...(ds.asyncTriggerResults?.values() ?? [])].some(result => result.status === 'pending')
    || (ds.idempotentAsyncTurns?.size ?? 0) > 0;
}

function recoveryOwnsWork(ds: DaemonSession): boolean {
  const status = ds.session.ordinaryTurnRecovery?.status;
  return status === 'running' || status === 'backoff' || status === 'dispatching';
}

/**
 * Return why a session is unsafe/ineligible for automatic idle cleanup. The
 * predicate is deliberately stricter than explicit close: automatic policy
 * must never abandon a user turn, an interaction, or a lifecycle operation.
 */
export function autoIdleSessionCleanupBlockReason(
  ds: DaemonSession,
  olderThanHours: number | undefined,
  now: number,
  safety: AutoIdleSessionCleanupSafety,
): string | undefined {
  if (!positiveInteger(olderThanHours)) return 'disabled';
  if (ds.session.status !== 'active') return 'not_active';
  if (ds.session.locked) return 'locked';
  if (ds.session.queued) return 'queued';
  if (ds.pendingRepo || ds.pendingRepoCommitInFlight || ds.worktreeCreating) return 'repository_setup';
  if (ds.initialStartPending || ds.initialStartClaimToken || ds.quarantinedActivationTailPromotion) return 'initial_start';
  if (hasProtectedSessionMutationOwnership(ds)) return 'protected_mutation';
  if (hasDeferredInput(ds)) return 'deferred_input';
  if (ds.tuiPromptCardId || ds.tuiPromptProcessing || ds.tuiPromptOptions) return 'tui_prompt';
  if (ds.agentAttention) return 'agent_attention';
  if (ds.usageLimit) return 'usage_limited';
  if (ds.remoteCloseState || ds.remoteShutdownState || ds.session.mojoCloseJournal) return 'remote_retirement';
  if (ds.pendingSuspendReason) return 'pending_suspend';
  if (recoveryOwnsWork(ds)) return 'turn_recovery';
  if (safety.isTransferring(ds)) return 'transferring';
  if (safety.isLifecycleInFlight(ds)) return 'lifecycle';

  // A resident worker is eligible only after its executor explicitly reports
  // idle. A workerless active row is dormant and can be safely closed.
  if (ds.worker && !ds.worker.killed && ds.lastScreenStatus !== 'idle') return 'not_idle';

  const lastActivityAt = autoIdleSessionLastActivityAtMs(ds);
  if (lastActivityAt === undefined) return 'missing_activity';
  const cutoff = now - olderThanHours * 60 * 60 * 1000;
  if (lastActivityAt >= cutoff) return 'not_expired';
  return undefined;
}

function stillRegistered(activeSessions: Map<string, DaemonSession>, expected: DaemonSession): boolean {
  for (const current of activeSessions.values()) {
    if (current === expected) return true;
  }
  return false;
}

/**
 * Close expired sessions one at a time behind the bot turn-mutation gate. The
 * candidate is revalidated inside each gate, so activity/config changes that
 * occur after the initial snapshot win over cleanup. Aliases of the same
 * DaemonSession are deduplicated by object identity.
 */
export async function cleanupAutoIdleSessionsAfterTurnDrain(
  larkAppId: string,
  activeSessions: Map<string, DaemonSession>,
  getIdleHours: () => number | undefined,
  closeSession: (sessionId: string, context: string) => Promise<CloseSessionResult>,
  safety: AutoIdleSessionCleanupSafety,
  opts: AutoIdleSessionCleanupOptions = {},
): Promise<AutoIdleSessionCleanupResult> {
  const initialHours = getIdleHours();
  const result: AutoIdleSessionCleanupResult = {
    enabled: positiveInteger(initialHours),
    ...(positiveInteger(initialHours) ? { olderThanHours: initialHours } : {}),
    matched: 0,
    closed: 0,
    residual: 0,
    failed: 0,
    skipped: 0,
    gateTimeouts: 0,
  };
  if (!positiveInteger(initialHours)) return result;

  const now = opts.now ?? Date.now;
  const candidates = [...new Set(activeSessions.values())]
    .filter(ds => autoIdleSessionCleanupBlockReason(ds, initialHours, now(), safety) === undefined)
    .sort((a, b) => (autoIdleSessionLastActivityAtMs(a) ?? 0) - (autoIdleSessionLastActivityAtMs(b) ?? 0));
  result.matched = candidates.length;

  for (const candidate of candidates) {
    const mutation = await tryWithBotTurnMutation(
      larkAppId,
      opts.mutationAcquireTimeoutMs ?? AUTO_IDLE_SESSION_CLEANUP_MUTATION_TIMEOUT_MS,
      async () => {
        const currentHours = getIdleHours();
        if (!stillRegistered(activeSessions, candidate)) return 'skipped' as const;
        if (autoIdleSessionCleanupBlockReason(candidate, currentHours, now(), safety) !== undefined) {
          return 'skipped' as const;
        }
        return closeSession(candidate.session.sessionId, 'automatic idle session cleanup');
      },
    );
    if (!mutation.acquired) {
      result.skipped++;
      result.gateTimeouts++;
      continue;
    }
    if (mutation.value === 'skipped') {
      result.skipped++;
      continue;
    }
    if (!mutation.value.ok) {
      result.failed++;
      continue;
    }
    result.closed++;
    if (mutation.value.outcome === 'closed_with_residual') result.residual++;
  }
  return result;
}
