import { getBot } from '../bot-registry.js';
import { listObservedIdentities, type IdentityRecord } from '../im/lark/identity-cache.js';
import { resolveUnionIdFromOpenIdStrict } from '../im/lark/client.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import { readBotSessionsStrict } from './session-store.js';
import type { DaemonSession } from '../core/types.js';
import type { Session, TrustedCaller } from '../types.js';

/** App-scoped execution identity. Contains no credentials; resolved only by the host. */
export interface AutomationUser {
  larkAppId: string;
  openId: string;
  unionId: string;
  name?: string;
}
export interface AutomationUserOption {
  openId: string;
  unionId?: string;
  name?: string;
  email?: string;
}

/** Mentions and contact lookups alone do not prove someone has used this bot. */
export function collectAutomationUsers(
  appId: string, identities: readonly IdentityRecord[], sessions: readonly Session[],
): AutomationUserOption[] {
  const users = new Map<string, AutomationUserOption>();
  const humans = new Map(identities.filter(i => i.type === 'user').map(i => [i.openId, i]));
  const add = (openId: string | undefined, unionId?: string) => {
    if (!openId || !/^ou_[A-Za-z0-9_-]+$/.test(openId)) return;
    const identity = humans.get(openId);
    users.set(openId, { openId, name: identity?.name, email: identity?.email,
      unionId: unionId ?? identity?.unionId ?? users.get(openId)?.unionId });
  };
  for (const i of humans.values()) if (i.interactedAt || i.source === 'sender' || i.source === 'message_api') add(i.openId, i.unionId);
  for (const s of sessions) {
    if (s.larkAppId !== appId) continue;
    // Stored session owners are authenticated humans; external triggers without
    // an explicit user never create one. Do not infer humans from bot callers.
    add(s.ownerOpenId, s.ownerUnionId);
    for (const reply of Object.values(s.replyTargets ?? {})) {
      if (reply.senderOpenId && reply.participants?.some(p => p.openId === reply.senderOpenId && p.isBot === false)) add(reply.senderOpenId);
    }
  }
  return [...users.values()].sort((a, b) => (a.name || a.openId).localeCompare(b.name || b.openId));
}

export function listAutomationUsers(appId: string): AutomationUserOption[] {
  // Validates bot existence before constructing any app-scoped file paths.
  getBot(appId);
  return collectAutomationUsers(appId, listObservedIdentities(appId), readBotSessionsStrict(appId));
}

/** Require managed per-user wrappers. The legacy fallback flag does not alter
 * credential publication: missing user credentials always publish a denial. */
export function assertAutomationUserPolicy(appId: string): void {
  const bot = getBot(appId).config;
  const policy = bot.triggerUserAuth;
  if (bot.existingAppServer || (bot.backendType && !['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(bot.backendType))) {
    throw new Error('run_as_requires_managed_local_session');
  }
  if (!policy?.enabled || !policy.tools.length) {
    throw new Error('run_as_requires_trigger_user_auth');
  }
}

export async function resolveAutomationUser(appId: string, value: unknown): Promise<AutomationUser | undefined> {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('invalid_run_as_user');
  assertAutomationUserPolicy(appId);
  const user = listAutomationUsers(appId).find(u => u.openId === value);
  if (!user) throw new Error('run_as_user_not_observed');
  const lookup = user.unionId ? undefined : await resolveUnionIdFromOpenIdStrict(appId, user.openId);
  const unionId = user.unionId ?? (lookup?.status === 'resolved' ? lookup.unionId : undefined);
  if (!unionId?.startsWith('on_')) throw new Error('run_as_user_identity_unavailable');
  return { larkAppId: appId, openId: user.openId, unionId, ...(user.name ? { name: user.name } : {}) };
}

export function assertAutomationUserAllowed(user: AutomationUser, appId: string, chatId: string): void {
  assertAutomationUserPolicy(appId);
  if (user.larkAppId !== appId || !user.openId?.startsWith('ou_') || !user.unionId?.startsWith('on_')
    || !canOperate(appId, chatId, user.openId, user.unionId)) throw new Error('run_as_user_access_denied');
}

export function automationTrustedCaller(user: AutomationUser): TrustedCaller {
  return { requestLarkAppId: user.larkAppId, requestUserOpenId: user.openId,
    requestUserUnionId: user.unionId, senderType: 'user', source: 'automation' };
}

/** A live worker keeps its spawn-time wrappers even when bot settings change. */
export function assertAutomationSession(user: AutomationUser, ds: DaemonSession): void {
  assertAutomationUserAllowed(user, ds.larkAppId, ds.chatId);
  const frozen = ds.initConfig?.triggerUserAuth;
  const live = ds.worker && !ds.worker.killed;
  const requiredTools = getBot(ds.larkAppId).config.triggerUserAuth!.tools;
  if (ds.adoptedFrom || ds.session.adoptedFrom
    || (ds.session.backendType && !['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(ds.session.backendType))
    || (live && (!frozen?.enabled || requiredTools.some(t => !frozen.tools.includes(t))))) {
    throw new Error('run_as_requires_managed_per_user_session');
  }
}

/** Freeze even the default (null), so later edits apply only to future runs. */
export function freezeAutomationTurnUser(ds: DaemonSession, turnId: string, user: AutomationUser | null): () => void {
  const hadTargets = ds.session.replyTargets !== undefined;
  ds.session.replyTargets ??= {};
  const previous = ds.session.replyTargets[turnId];
  if (previous && Object.hasOwn(previous, 'automationUser')) return () => {};
  const frozen = { ...previous, updatedAt: new Date().toISOString(), automationUser: user ? { ...user } : null };
  ds.session.replyTargets[turnId] = frozen;
  return () => {
    if (ds.session.replyTargets?.[turnId] !== frozen) return;
    if (previous) ds.session.replyTargets[turnId] = previous;
    else delete ds.session.replyTargets[turnId];
    if (!hadTargets && !Object.keys(ds.session.replyTargets).length) delete ds.session.replyTargets;
  };
}
