import { getBot } from '../bot-registry.js';
import { listObservedIdentities, type IdentityRecord } from '../im/lark/identity-cache.js';
import { resolveUnionIdFromOpenIdStrict } from '../im/lark/client.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import { readBotSessionsStrict } from './session-store.js';
import {
  automationIdentityTools,
  explicitAutomationIdentityTools,
  isInvalidAutomationIdentity,
  type AutomationIdentitySetting,
  type AutomationUser,
} from './automation-identity-config.js';
import {
  managedSessionCapable,
  isInvalidToolIdentity,
  normalizeToolIdentityPolicy,
  unenforceableManagedTool,
  assertToolIdentitySession,
  type NormalizedToolIdentityPolicy,
} from './tool-identity-config.js';
import { buildAutomaticTurnDecision } from '../core/tool-identity-decision.js';
import {
  selectTurnExecutionUser,
  toLegacyFailure,
  type ToolExecutionPrincipal,
  type TurnExecutionUserSource,
} from '../core/tool-identity-policy.js';
import {
  type TriggerUserAuthConfig,
  type TriggerUserAuthTool,
} from './trigger-user-auth.js';
import type { DaemonSession } from '../core/types.js';
import type { Session, TrustedCaller } from '../types.js';

export type { AutomationIdentityConfig, AutomationUser } from './automation-identity-config.js';

export interface AutomationUserOption {
  openId: string;
  unionId?: string;
  name?: string;
  email?: string;
}

/** Where an automatic turn's execution user came from. Kept distinct from the
 *  event actor and from task/session control ownership. */
export type AutomationIdentitySource = TurnExecutionUserSource;

/** Why a configured identity could not be used. A failure never falls through
 *  to another candidate: explicit selections must fail closed. */
export type AutomationIdentityFailure =
  | 'invalid_identity'
  | 'access_denied'
  | 'unsupported_capability';

export interface AutomationIdentityResolution {
  user?: AutomationUser;
  source: AutomationIdentitySource;
  tools: TriggerUserAuthTool[];
  failure?: AutomationIdentityFailure;
}

/** Mentions and contact lookups alone do not prove someone has used this bot. */
export function collectAutomationUsers(
  appId: string, identities: readonly IdentityRecord[], sessions: readonly Session[],
  configuredUsers: readonly AutomationUser[] = [],
): AutomationUserOption[] {
  const users = new Map<string, AutomationUserOption>();
  const humans = new Map(identities.filter(i => i.type === 'user').map(i => [i.openId, i]));
  const knownBots = new Set(identities.filter(i => i.type === 'bot' || i.type === 'app').map(i => i.openId));
  const add = (openId: string | undefined, unionId?: string, configuredName?: string) => {
    if (!openId || knownBots.has(openId) || !/^ou_[A-Za-z0-9_-]+$/.test(openId)) return;
    const identity = humans.get(openId);
    const previous = users.get(openId);
    users.set(openId, { openId,
      name: identity?.name ?? configuredName ?? previous?.name,
      email: identity?.email ?? previous?.email,
      unionId: unionId ?? identity?.unionId ?? previous?.unionId });
  };
  for (const i of humans.values()) if (i.interactedAt || i.source === 'sender' || i.source === 'message_api') add(i.openId, i.unionId);
  for (const s of sessions) {
    if (s.larkAppId !== appId) continue;
    // A stored owner is not automatically a human: a bot.added operator can
    // contaminate this field. Require positive evidence — a persisted
    // tenant-stable union id from an authenticated human path, or an observed
    // user record — and exclude ids independently known to be bots.
    const ownerIdentity = s.ownerOpenId ? humans.get(s.ownerOpenId) : undefined;
    const positiveHuman = !!s.ownerUnionId
      || !!(ownerIdentity && (ownerIdentity.interactedAt
        || ownerIdentity.source === 'sender' || ownerIdentity.source === 'message_api'));
    if (positiveHuman) add(s.ownerOpenId, s.ownerUnionId);
    for (const reply of Object.values(s.replyTargets ?? {})) {
      // Lifecycle openings (chat.bot_added) synthesize a sender/participant
      // record. Even isBot:false is an event-actor assertion, not a human
      // message, so it can never make someone a Run as candidate.
      if (reply.lifecycleSynthetic || !reply.senderOpenId) continue;
      if (!reply.participants?.some(p => p.openId === reply.senderOpenId && p.isBot === false)) continue;
      // Legacy synthetic records predate the marker. Require independent human
      // evidence (a platform-authenticated sender/contact record, or a session
      // owner carrying the tenant-stable union id) before trusting the
      // participant window.
      const senderIdentity = humans.get(reply.senderOpenId);
      const independentlyHuman = !!(senderIdentity && (senderIdentity.interactedAt
        || senderIdentity.source === 'sender' || senderIdentity.source === 'message_api'
        || senderIdentity.source === 'contact_api'));
      const ownerEvidence = s.ownerOpenId === reply.senderOpenId && !!s.ownerUnionId;
      if (independentlyHuman || ownerEvidence) {
        add(reply.senderOpenId, ownerEvidence ? s.ownerUnionId : undefined);
      }
    }
  }
  // A persisted assignment was verified when it was selected and is already
  // an active execution principal. Keep it recoverable after identity-cache
  // rotation or session cleanup; otherwise the Dashboard can display the
  // saved open_id but cannot resolve/save it again. Independently known bots
  // remain excluded by the same gate above.
  for (const user of configuredUsers) {
    if (user.larkAppId === appId && /^on_[A-Za-z0-9_-]+$/.test(user.unionId)) {
      add(user.openId, user.unionId, user.name);
    }
  }
  return [...users.values()].sort((a, b) => (a.name || a.openId).localeCompare(b.name || b.openId));
}

export function listAutomationUsers(appId: string): AutomationUserOption[] {
  // Validates bot existence before constructing any app-scoped file paths.
  const config = getBot(appId).config;
  const configuredUsers: AutomationUser[] = [];
  if (config.automationIdentityInvalid === undefined
    && config.automationIdentity && !isInvalidAutomationIdentity(config.automationIdentity)) {
    configuredUsers.push(config.automationIdentity.user);
  }
  if (config.toolIdentityInvalid === undefined
    && config.toolIdentity && !isInvalidToolIdentity(config.toolIdentity)) {
    configuredUsers.push(config.toolIdentity.user);
  }
  return collectAutomationUsers(
    appId,
    listObservedIdentities(appId),
    readBotSessionsStrict(appId),
    configuredUsers,
  );
}

/** Tools whose credentials this bot can actually enforce for an automation
 *  turn. Capability is per tool: `lark-cli` is provided by the managed app
 *  binding even when per-turn auth is off; ByteCloud tools need their own
 *  trigger-user wrapper. Delegates to the shared normalized helper so save-
 *  time validation and run-time resolution cannot disagree. */
function unableAutomationTool(
  config: {
    larkToolBinding?: boolean;
    triggerUserAuth?: TriggerUserAuthConfig;
    toolIdentity?: import('./tool-identity-config.js').ToolIdentitySetting;
    identityTools?: readonly TriggerUserAuthTool[];
  },
  tools: readonly TriggerUserAuthTool[],
): TriggerUserAuthTool | undefined {
  return unenforceableManagedTool(config, tools);
}

/** Require managed local wrappers for at least one effective automation tool.
 *  This deliberately does NOT require `triggerUserAuth.enabled`: the managed
 *  Lark application binding carries automation `--as user` on its own. */
export function assertAutomationUserPolicy(appId: string, tools?: readonly TriggerUserAuthTool[]): void {
  const bot = getBot(appId).config;
  if (!managedSessionCapable(bot)) {
    throw new Error('run_as_requires_managed_local_session');
  }
  const effectiveTools = tools !== undefined ? [...tools] : automationIdentityTools(bot);
  if (!effectiveTools.length) throw new Error('run_as_requires_automation_tool');
  const unable = unableAutomationTool(bot, effectiveTools);
  if (unable) throw new Error(`run_as_requires_managed_tool:${unable}`);
}

export async function resolveAutomationUser(
  appId: string,
  value: unknown,
  tools?: readonly TriggerUserAuthTool[],
): Promise<AutomationUser | undefined> {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('invalid_run_as_user');
  // An explicit task/connector Run as is governed by the bot's ordinary
  // per-turn policy, not by some unrelated bot-level default's tool list. A
  // stale default scope must not make an enforceable explicit selection
  // unsaveable; callers that save a default pass the newly requested scope.
  assertAutomationUserPolicy(appId, tools ?? explicitAutomationIdentityTools(getBot(appId).config));
  return resolveObservedExecutionUser(appId, value);
}

/** Fixed assignments install their own transport; sender mode need not be on. */
export async function resolveFixedToolUser(
  appId: string,
  value: unknown,
  tools: readonly TriggerUserAuthTool[],
): Promise<AutomationUser | undefined> {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('invalid_run_as_user');
  if (!tools.length) throw new Error('run_as_requires_automation_tool');
  const config = { ...getBot(appId).config, identityTools: [...tools] };
  assertToolIdentitySession(config, { session: {} }, tools);
  return resolveObservedExecutionUser(appId, value);
}

async function resolveObservedExecutionUser(appId: string, value: string): Promise<AutomationUser> {
  const user = listAutomationUsers(appId).find(u => u.openId === value);
  if (!user) throw new Error('run_as_user_not_observed');
  const lookup = user.unionId ? undefined : await resolveUnionIdFromOpenIdStrict(appId, user.openId);
  const unionId = user.unionId ?? (lookup?.status === 'resolved' ? lookup.unionId : undefined);
  if (!unionId?.startsWith('on_')) throw new Error('run_as_user_identity_unavailable');
  return { larkAppId: appId, openId: user.openId, unionId, ...(user.name ? { name: user.name } : {}) };
}

export function assertAutomationUserAllowed(user: AutomationUser, appId: string, chatId: string): void {
  if (user.larkAppId !== appId || !user.openId?.startsWith('ou_') || !user.unionId?.startsWith('on_')
    || !canOperate(appId, chatId, user.openId, user.unionId)) throw new Error('run_as_user_access_denied');
}

export function automationTrustedCaller(user: AutomationUser): TrustedCaller {
  return { requestLarkAppId: user.larkAppId, requestUserOpenId: user.openId,
    requestUserUnionId: user.unionId, senderType: 'user', source: 'automation' };
}

/**
 * Resolve the user an automatic turn should run as.
 *
 * This is the thin adapter around the pure selector
 * {@link selectTurnExecutionUser} (core/tool-identity-policy.ts): the
 * precedence and fail-closed semantics live there, encoded once for every
 * entry type. The adapter supplies the live access default and downgrades the
 * unified class-5 "per-turn on, no applicable assignment" outcome to a plain
 * no-assignment result — the schedule entry resolves its verified creator
 * DOWNSTREAM (the exact-turn publication path runs governed tools as that
 * verified principal), where a missing verification already lands on the
 * per-tool managed-user denial instead of host fallback (plan §3.3 class 5).
 *
 * `config` is passed explicitly so the same decision can be frozen at admission
 * and tested without live bot state.
 */
export function resolveAutomationIdentity(input: {
  appId: string;
  chatId: string;
  config: {
    larkToolBinding?: boolean;
    triggerUserAuth?: TriggerUserAuthConfig;
    automationIdentity?: AutomationIdentitySetting;
    /** Present when `bots.json` carried a rejected automationIdentity. */
    automationIdentityInvalid?: string;
    /** The fixed bot user assignment (plan §4.1) and its rejected-load state. */
    toolIdentity?: import('./tool-identity-config.js').ToolIdentitySetting;
    toolIdentityInvalid?: string;
    backendType?: import('../adapters/backend/types.js').BackendType;
    existingAppServer?: unknown;
  };
  explicit?: AutomationUser;
  explicitSource?: 'task' | 'connector';
  provenance?: AutomationUser;
  /** Injected for tests; defaults to the bot's live access policy. */
  canUse?: (user: AutomationUser) => boolean;
}): AutomationIdentityResolution {
  const canUse: (user: ToolExecutionPrincipal) => boolean = input.canUse
    ? (user) => input.canUse!(user as AutomationUser)
    : (user) => canOperate(input.appId, input.chatId, user.openId, user.unionId ?? '');
  const selection = selectTurnExecutionUser({
    larkAppId: input.appId,
    policy: normalizeToolIdentityPolicy({ ...input.config, larkAppId: input.appId }),
    ...(input.explicit !== undefined ? { explicit: input.explicit } : {}),
    ...(input.explicitSource !== undefined ? { explicitSource: input.explicitSource } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    canUse,
  });
  return {
    ...(selection.user ? { user: selection.user as AutomationUser } : {}),
    source: selection.source,
    tools: [...selection.tools],
    ...(selection.failure && selection.failure !== 'missing_provenance'
      ? { failure: toLegacyFailure(selection.failure) } : {}),
  };
}

/** A live worker keeps its spawn-time wrappers even when bot settings change.
 *  `tools` is the run's effective frozen scope; omit to use the live bot policy. */
export function assertAutomationSession(
  user: AutomationUser,
  ds: DaemonSession,
  tools?: readonly TriggerUserAuthTool[],
): void {
  assertAutomationUserAllowed(user, ds.larkAppId, ds.chatId);
  const bot = getBot(ds.larkAppId).config;
  assertToolIdentitySession(bot, ds, tools ?? automationIdentityTools(bot));
}

/** Freeze even the default (null), so later edits apply only to future runs. */
export function freezeAutomationTurnUser(
  ds: DaemonSession,
  turnId: string,
  user: AutomationUser | null,
  meta?: {
    source?: AutomationIdentitySource;
    tools?: readonly TriggerUserAuthTool[];
    policy?: NormalizedToolIdentityPolicy;
  },
): () => void {
  const hadTargets = ds.session.replyTargets !== undefined;
  ds.session.replyTargets ??= {};
  const previous = ds.session.replyTargets[turnId];
  if (previous && Object.hasOwn(previous, 'automationUser')) return () => {};
  const frozen = {
    ...previous,
    updatedAt: new Date().toISOString(),
    automationUser: user ? { ...user } : null,
    // Versioned exact-turn decision (plan §5.2): makes the frozen HOST /
    // MANAGED / DENIED mode explicit for new records; the legacy fields stay
    // for pre-refactor readers.
    toolIdentityDecision: buildAutomaticTurnDecision({
      user: user ?? undefined,
      source: meta?.source,
      tools: meta?.tools,
      ...(meta?.policy ? { policy: meta.policy }
        : ds.larkAppId ? { policy: normalizeToolIdentityPolicy(getBot(ds.larkAppId).config) } : {}),
    }),
    ...(meta?.source ? { automationIdentitySource: meta.source } : {}),
    ...(meta?.tools ? { automationIdentityTools: [...meta.tools] } : {}),
  };
  ds.session.replyTargets[turnId] = frozen;
  return () => {
    if (ds.session.replyTargets?.[turnId] !== frozen) return;
    if (previous) ds.session.replyTargets[turnId] = previous;
    else delete ds.session.replyTargets[turnId];
    if (!hadTargets && !Object.keys(ds.session.replyTargets).length) delete ds.session.replyTargets;
  };
}
