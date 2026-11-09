/**
 * Versioned exact-turn tool identity decision record (plan §5.2, §8).
 *
 * The record freezes the ADMISSION DECISION for one logical identity turn —
 * the mode (host / managed user / bound app / delegated / denied), its audit
 * source, the effective tool scope, and app-scoped principal references.
 * It deliberately contains NO credential material: no tokens, refresh
 * credentials, environment dumps, or native login copies. Host mode records
 * the CHOICE of native execution, not a copy of the host login; native login
 * changes keep behaving as they do in a normal CLI process.
 *
 * The record coexists with the legacy persisted triple
 * (`automationUser` / `automationIdentitySource` / `automationIdentityTools`)
 * during migration: new turns always write the explicit record; readers go
 * through {@link toolIdentityDecisionFromReplyTarget}, which falls back to
 * the legacy fields for records persisted before the refactor (plan §8.2 /
 * §9: null alone is never guessed into native or denial — only records that
 * carry explicit frozen markers are treated as decisions).
 */
import type { ToolIdentityFailure, ToolExecutionPrincipal, TurnExecutionUserSource } from './tool-identity-policy.js';
import type { NormalizedToolIdentityPolicy } from '../services/tool-identity-config.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';

/** Authority class admission established for the whole turn. */
export type ToolIdentityAuthority = 'delegated' | 'human' | 'automatic';

export type ToolIdentityDecisionMode = 'host' | 'managed_user' | 'bound_app' | 'delegated' | 'denied';

export interface ToolIdentityDecisionRecord {
  v: 1;
  authority: ToolIdentityAuthority;
  mode: ToolIdentityDecisionMode;
  /** Where a managed principal came from. Absent for host/bound/delegated. */
  source?: TurnExecutionUserSource | 'sender';
  /** App-scoped principal reference (no credentials). */
  user?: ToolExecutionPrincipal;
  /** Effective frozen tool scope for the turn. */
  tools?: readonly TriggerUserAuthTool[];
  /** Why the turn is denied. A denied decision never carries a user. */
  failure?: ToolIdentityFailure;
  /** Admission (freeze) time. */
  frozenAt: string;
  /** Per-tool baselines at admission. Scope exclusion must not claim tools
   * enabled later, nor discard a policy already applicable at admission. */
  baseline?: Pick<NormalizedToolIdentityPolicy, 'perTurnTools' | 'perTurnCredentialSource' | 'fixedBotUser'>;
}

/** The reply-target fields a decision record is persisted alongside / read from. */
export interface ToolIdentityReplyTargetFields {
  toolIdentityDecision?: ToolIdentityDecisionRecord;
  updatedAt?: string;
  automationUser?: import('../services/automation-identity.js').AutomationUser | null;
  automationIdentitySource?: import('../services/automation-identity.js').AutomationIdentitySource;
  automationIdentityTools?: readonly TriggerUserAuthTool[];
}

/**
 * Build the record for an automatic-turn freeze. `source === 'none'` with no
 * user is a HOST decision (native execution chosen by policy); a non-none
 * source without a usable user is a DENIED decision (fail closed, never
 * native). This mapping is the single place that makes a persisted
 * `automationUser: null` distinguishable from "ambiguous old record".
 */
export function buildAutomaticTurnDecision(input: {
  user?: ToolExecutionPrincipal | null;
  source?: TurnExecutionUserSource;
  tools?: readonly TriggerUserAuthTool[];
  frozenAt?: Date;
  policy?: NormalizedToolIdentityPolicy;
}): ToolIdentityDecisionRecord {
  const mode: ToolIdentityDecisionMode = input.user
    ? 'managed_user'
    : (input.source ?? 'none') === 'none' ? 'host' : 'denied';
  return {
    v: 1,
    authority: 'automatic',
    mode,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.user ? { user: input.user } : {}),
    ...(input.tools?.length ? { tools: [...input.tools] } : {}),
    ...(mode === 'denied' ? { failure: 'invalid_identity' as const } : {}),
    frozenAt: (input.frozenAt ?? new Date()).toISOString(),
    ...(input.policy ? { baseline: structuredClone({
      perTurnTools: input.policy.perTurnTools,
      perTurnCredentialSource: input.policy.perTurnCredentialSource,
      fixedBotUser: input.policy.fixedBotUser,
    }) } : {}),
  };
}

/**
 * Read the frozen decision for a turn. New records win; legacy records are
 * normalized from the persisted triple — but ONLY triples carrying an
 * explicit freeze marker (source or tools): an `automationUser: null` alone
 * is ambiguous (plan §9) and yields undefined rather than a guessed mode.
 * A turn with no identity markers at all (an ordinary human turn's reply
 * target) also yields undefined.
 */
export function toolIdentityDecisionFromReplyTarget(
  entry: ToolIdentityReplyTargetFields | undefined | null,
): ToolIdentityDecisionRecord | undefined {
  if (!entry) return undefined;
  if (entry.toolIdentityDecision?.v === 1) return entry.toolIdentityDecision;
  if (entry.automationIdentitySource === undefined
    && entry.automationIdentityTools === undefined) {
    return undefined;
  }
  const source = entry.automationIdentitySource;
  const user = entry.automationUser ?? undefined;
  const mode: ToolIdentityDecisionMode = user
    ? 'managed_user'
    : (source ?? 'none') === 'none' ? 'host' : 'denied';
  return {
    v: 1,
    authority: 'automatic',
    mode,
    ...(source !== undefined ? { source } : {}),
    ...(user ? { user } : {}),
    ...(entry.automationIdentityTools?.length ? { tools: [...entry.automationIdentityTools] } : {}),
    ...(mode === 'denied' ? { failure: 'invalid_identity' as const } : {}),
    frozenAt: entry.updatedAt ?? new Date(0).toISOString(),
  };
}
