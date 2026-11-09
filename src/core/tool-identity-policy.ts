/**
 * Pure per-tool tool-identity selection.
 *
 * This encodes the policy contract of
 * docs/plans/2026-11-06-tool-identity-policy-refactor.md (§3) as two pure
 * functions with no I/O and no live bot state:
 *
 * - {@link selectTurnExecutionUser}: the cross-tool precedence deciding an
 *   AUTOMATIC turn's execution principal (task/connector selection → the
 *   automatic-only bot default → verified provenance), with fail-closed
 *   semantics for configured-but-unusable selections.
 * - {@link selectToolCredential}: the per-tool frozen decision for one turn
 *   — host credentials, a managed user, the bound app, a delegated grant, or
 *   an explicit denial.
 *
 * Every fact is an input. Admission can therefore freeze the returned
 * decision for the exact turn (plan §5.2) and tests exercise the same
 * production logic the daemon runs. The selector never touches the network,
 * the registry, or a credential store: an unavailable identity service can
 * only ever produce a `denied` decision, never a different account — and the
 * central off/unassigned case is `host`, decided without consulting any
 * identity service at all.
 *
 * Terminology (plan §3.1): host mode is a SUCCESSFUL policy decision whose
 * credential owner may be unknown to Botmux. It is never labelled
 * `anonymous` or `missing_user`, and never fabricated into a human caller.
 */
import {
  isInvalidAutomationIdentity,
  type AutomationIdentitySetting,
  type AutomationUser,
} from '../services/automation-identity-config.js';
import {
  isInvalidToolIdentity,
  unenforceableManagedToolNormalized,
  type NormalizedToolIdentityPolicy,
} from '../services/tool-identity-config.js';
import type { TriggerUserAuthCredentialSource, TriggerUserAuthTool } from '../services/trigger-user-auth.js';

/** Entry type that produced the turn. Provenance semantics differ per entry
 *  (plan §7); the selector keeps them in one place. */
export type ToolIdentityEntry = 'human_chat' | 'schedule' | 'group_entry' | 'webhook';

/** Why a configured or requested identity could not be used. A failure never
 *  falls through to another candidate: explicit selections fail closed. */
export type ToolIdentityFailure =
  /** The selected/configured user is malformed or scoped to another app. */
  | 'invalid_identity'
  /** The user lost (or was never granted) permission on the target chat. */
  | 'access_denied'
  /** A tool in the winning scope is not enforceable on this bot/backend. */
  | 'unsupported_capability'
  /** The backend cannot host a managed per-user session at all. */
  | 'managed_session_unsupported'
  /** A per-turn-on turn has no verified human principal. Never falls back
   *  to host credentials (plan §3.2 rule 5). */
  | 'missing_provenance'
  /** A configured assignment is retained-but-broken (plan §4.2). */
  | 'config_invalid';

/** A principal a tool may execute as. Publication-grade: the human-sender
 *  path carries only an app-scoped open_id (the union id is resolved by the
 *  credential transport when its source needs one). */
export interface ToolExecutionPrincipal {
  larkAppId?: string;
  openId: string;
  unionId?: string;
  name?: string;
}

/** The frozen per-tool decision (plan §5.1). Host mode is its own mode —
 *  never a managed decision with `user: undefined`. */
export type ToolCredentialDecision =
  | { mode: 'host'; source: 'native_default' }
  | {
      mode: 'managed_user';
      source: 'sender' | 'task' | 'connector' | 'bot_default' | 'automatic_default' | 'provenance';
      user: ToolExecutionPrincipal;
      credentialSource: TriggerUserAuthCredentialSource;
    }
  | { mode: 'bound_app'; appId: string; user?: ToolExecutionPrincipal }
  | { mode: 'delegated'; grantRef: string; permitted: boolean; tools: readonly TriggerUserAuthTool[]; credentialSource: TriggerUserAuthCredentialSource }
  | { mode: 'denied'; reason: ToolIdentityFailure; source: string };

/** Where an automatic turn's execution principal came from. Kept distinct
 *  from the event actor and from task/session control ownership. The
 *  persisted labels match the pre-refactor freeze records; `automatic_default`
 *  is reserved for the broader fixed-bot assignment introduced by the Phase 4
 *  migration (plan §4.1: do not silently broaden `automationIdentity`). */
export type TurnExecutionUserSource =
  | 'task' | 'connector' | 'bot_default' | 'automatic_default' | 'provenance' | 'none';

/** The turn-level selection consumed by admission and frozen per turn. */
export interface TurnExecutionUserSelection {
  user?: ToolExecutionPrincipal;
  source: TurnExecutionUserSource;
  /** Effective frozen tool scope for the turn. */
  tools: readonly TriggerUserAuthTool[];
  failure?: ToolIdentityFailure;
}

export interface TurnExecutionUserInput {
  larkAppId: string;
  policy: NormalizedToolIdentityPolicy;
  /** Explicit task/connector Run as selection. It owns the answer even when
   *  a lower-priority default is broken, and is validated against the
   *  per-turn-derived scope, never the default's narrower list (plan §3.3). */
  explicit?: ToolExecutionPrincipal | null;
  explicitSource?: 'task' | 'connector';
  /** Host-verified provenance: a schedule creator or verified group-entry
   *  operator. Provenance is not a sender and never substitutes for one; the
   *  unified contract (§3.3 class 5) admits it only while the per-turn
   *  policy is ON for the evaluated tool scope. */
  provenance?: ToolExecutionPrincipal | null;
  /** Live operate-permission check for a candidate. Pure default: allowed.
   *  Production callers MUST supply the real check (plan §3.2 rule 7). */
  canUse?: (user: ToolExecutionPrincipal) => boolean;
}

/** Legacy failure label set (kept byte-compatible for frozen turn records). */
export type LegacyAutomationIdentityFailure = 'invalid_identity' | 'access_denied' | 'unsupported_capability';
export function toLegacyFailure(failure: ToolIdentityFailure): LegacyAutomationIdentityFailure {
  switch (failure) {
    case 'access_denied': return 'access_denied';
    case 'unsupported_capability':
    case 'managed_session_unsupported': return 'unsupported_capability';
    // `missing_provenance` is new in the unified contract; legacy records
    // never carried it, and the closest fail-closed label is invalid_identity.
    case 'missing_provenance':
    case 'invalid_identity':
    case 'config_invalid': return 'invalid_identity';
  }
}

function userIdentifierInvalid(user: ToolExecutionPrincipal, larkAppId: string): boolean {
  return (!!user.larkAppId && user.larkAppId !== larkAppId)
    || !user.openId?.startsWith('ou_')
    || (!user.unionId ? false : !user.unionId.startsWith('on_'));
}

/**
 * Cross-tool precedence for an automatic turn's principal (plan §3.3 class 3,
 * with class 5 behind the migration flag). The first CONFIGURED candidate
 * owns the answer; an invalid winner is an error, never a lower-priority
 * user or host mode (plan §3.2 rules 1–2).
 */
export function selectTurnExecutionUser(input: TurnExecutionUserInput): TurnExecutionUserSelection {
  const { policy } = input;
  const canUse = input.canUse ?? (() => true);
  const explicitTools: TriggerUserAuthTool[] = policy.perTurnTools.length
    ? [...policy.perTurnTools]
    : ['lark-cli'];
  const defaultTools: TriggerUserAuthTool[] = policy.automationDefault
  && !isInvalidAutomationIdentity(policy.automationDefault)
  && policy.automationDefault.tools?.length
    ? [...policy.automationDefault.tools]
    : [...explicitTools];

  const candidate = (
    user: ToolExecutionPrincipal,
    source: TurnExecutionUserSource,
    tools: readonly TriggerUserAuthTool[],
  ): TurnExecutionUserSelection => {
    if (userIdentifierInvalid(user, input.larkAppId)) {
      return { source, tools, failure: 'invalid_identity' };
    }
    if (!policy.managedSession) return { source, tools, failure: 'managed_session_unsupported' };
    if (unenforceableManagedToolNormalized(policy, tools)) {
      return { source, tools, failure: 'unsupported_capability' };
    }
    if (!canUse(user)) return { source, tools, failure: 'access_denied' };
    return { user, source, tools };
  };

  // 1. Explicit task/connector selection always owns the answer — even when
  //    the bot default is invalid or revoked. It must not be blocked by a
  //    lower-priority configuration the run never asked for.
  if (input.explicit) return candidate(input.explicit, input.explicitSource ?? 'task', explicitTools);

  // 2. A rejected configured default is a distinct state: fail closed rather
  //    than degrade to provenance/operator fallback as if it were unset.
  const configured = policy.automationDefault;
  if (configured && isInvalidAutomationIdentity(configured)) {
    return { source: 'bot_default', tools: defaultTools, failure: 'invalid_identity' };
  }
  // 3. The valid automatic-only bot default.
  if (configured) {
    return candidate((configured as Exclude<AutomationIdentitySetting, { invalid: string }>).user,
      'bot_default', defaultTools);
  }
  // 3b. The fixed bot user assignment is the LOWER-priority automatic default
  //     (plan §3.3 class 3: task/connector override → automatic-only default
  //     → fixed bot user). A configured-but-broken one fails closed.
  const fixed = policy.fixedBotUser;
  if (fixed && isInvalidToolIdentity(fixed)) {
    return { source: 'automatic_default', tools: defaultTools, failure: 'config_invalid' };
  }
  if (fixed && fixed.tools?.length) {
    return candidate(fixed.user, 'automatic_default', [...fixed.tools]);
  }
  // 4. Verified provenance, admitted only while the per-turn policy is ON
  //    (plan §3.3 class 5). With per-turn off and no assignment the turn is
  //    host: a legacy task whose owner open id is all it has dispatches
  //    natively and never acquires managed human authority from that.
  const provenanceEligible = policy.perTurnTools.length > 0;
  if (input.provenance && provenanceEligible) {
    return candidate(input.provenance, 'provenance', explicitTools);
  }
  // 5. An automatic turn with the per-turn policy ON and no applicable
  //    assignment is a managed-user denial — never host mode (plan §3.2
  //    rule 5: missing provenance does not fall back to host credentials).
  if (provenanceEligible) {
    return { source: 'none', tools: explicitTools, failure: 'missing_provenance' };
  }
  return { source: 'none', tools: defaultTools };
}

export interface ToolCredentialInput {
  larkAppId: string;
  tool: TriggerUserAuthTool;
  /** Recorded on the decision for audit; does not change per-tool semantics
   *  beyond what the authority/fact inputs already express. */
  entry?: ToolIdentityEntry;
  /** Authority class admission established for the whole turn. */
  authority: 'delegated' | 'human' | 'automatic';
  policy: NormalizedToolIdentityPolicy;
  /** The turn's frozen automatic selection, when admission made one. */
  turn?: {
    user?: ToolExecutionPrincipal;
    source?: TurnExecutionUserSource;
    tools?: readonly TriggerUserAuthTool[];
    failure?: ToolIdentityFailure;
  } | null;
  /** Verified human sender for this turn (open_id; the credential transport
   *  resolves whatever else its source needs). */
  senderOpenId?: string;
  /** Verified delegated grant for this turn. Grant scope exclusion is a
   *  denial — never host fallback (plan §3.2 rule 4). */
  delegatedGrant?: { grantRef: string; permitted: boolean; tools: readonly TriggerUserAuthTool[] } | null;
  /** Whether the managed binding transport is actually installed for this
   *  session. A capability fact supplied by the caller — this selector never
   *  derives it from the per-turn policy (plan §3.4: the implicit unset
   *  relationship must disappear). */
  bindingInstalled?: boolean;
}

/**
 * The per-tool decision for one turn (plan §3.2 matrix).
 *
 * Evaluation order mirrors the enforcement order: an installed binding
 * transport owns `lark-cli` (its managed route also serves delegated humans);
 * a frozen scope that excludes the tool leaves it on its independent native
 * baseline (rule 4); a delegated grant is retained as-is; the turn's frozen
 * principal wins inside its scope; and only then does the per-tool baseline
 * (per-turn sender policy) apply. Off/unassigned with no applicable selection
 * is host credentials — decided without contacting any identity service.
 */
export function selectToolCredential(input: ToolCredentialInput): ToolCredentialDecision {
  const { tool, policy } = input;

  // An installed binding transport resolves `lark-cli` itself (bot/user roles
  // at call time; its managed route also serves delegated humans). The
  // per-turn publication must not also fire for it.
  if (tool === 'lark-cli' && input.bindingInstalled) {
    return {
      mode: 'bound_app',
      appId: policy.larkAppId,
      ...(input.turn?.user ? { user: input.turn.user } : {}),
    };
  }

  const governed = policy.perTurnTools.includes(tool);
  if (input.authority === 'delegated' && governed) {
    const grant = input.delegatedGrant;
    // A governed tool excluded from the grant is delegated-denied (grant
    // exclusion means denial, never host — plan §3.2 rule 4). An UNGOVERNED
    // tool is not claimed by the delegation at all: it keeps its independent
    // baseline, exactly as the per-tool evaluation requires.
    if (!grant) return { mode: 'denied', reason: 'missing_provenance', source: 'delegated' };
    return {
      mode: 'delegated',
      grantRef: grant.grantRef,
      permitted: grant.permitted && grant.tools.includes(tool),
      tools: [...grant.tools],
      credentialSource: policy.perTurnCredentialSource,
    };
  }

  // Exclusion skips this ordinary assignment only. Delegated grant scope is
  // handled above and remains a denial; independent sender/fixed policies
  // still apply below.
  const assignmentApplies = !input.turn?.tools || input.turn.tools.includes(tool);
  if (assignmentApplies && input.turn?.failure) {
    return { mode: 'denied', reason: input.turn.failure, source: input.turn.source ?? 'automatic_default' };
  }
  if (assignmentApplies && input.turn?.user) {
    const source = input.turn.source;
    return {
      mode: 'managed_user',
      // A turn carrying a user never has source `none`; fall back to the
      // broader-assignment label for records frozen before sources were set.
      source: source && source !== 'none' ? source : 'automatic_default',
      user: input.turn.user,
      credentialSource: source === 'automatic_default' && policy.fixedBotUser
        && !isInvalidToolIdentity(policy.fixedBotUser)
        ? policy.fixedBotUser.credentialSource : policy.perTurnCredentialSource,
    };
  }

  // Per-tool baseline (no frozen automatic selection for this turn).
  const perTurn = policy.perTurnTools.includes(tool);
  if (perTurn) {
    if (!input.senderOpenId?.startsWith('ou_')) {
      return { mode: 'denied', reason: 'missing_provenance', source: 'sender' };
    }
    return { mode: 'managed_user', source: 'sender', user: { openId: input.senderOpenId }, credentialSource: policy.perTurnCredentialSource };
  }
  // Off | Configured: the fixed bot user assignment governs this tool on
  // ordinary turns (plan §3.2 matrix). A configured-but-broken assignment
  // that would WIN is an error — never a silent native fallback (§3.2 rule 1).
  const fixed = policy.fixedBotUser;
  if (fixed) {
    if (isInvalidToolIdentity(fixed)) {
      return { mode: 'denied', reason: 'config_invalid', source: 'automatic_default' };
    }
    if (fixed.user && fixed.tools?.includes(tool)) {
      return { mode: 'managed_user', source: 'automatic_default', user: fixed.user, credentialSource: fixed.credentialSource };
    }
  }
  return { mode: 'host', source: 'native_default' };
}

/** Re-exported so policy consumers need one import path for the contract. */
export type { AutomationUser };
