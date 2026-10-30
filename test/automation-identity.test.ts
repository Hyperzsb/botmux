import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { IdentityRecord } from '../src/im/lark/identity-cache.js';

const state = vi.hoisted(() => ({
  config: { triggerUserAuth: { enabled: true, tools: ['bytedcli'], fallback: 'none' } } as any,
  identities: [] as any[], sessions: [] as any[], allowed: true,
  lookup: vi.fn(async (..._args: any[]) => ({ status: 'resolved', unionId: 'on_selected' })),
}));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: state.config }) }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ listObservedIdentities: (appId: string) => appId === 'app_a' ? state.identities : [] }));
vi.mock('../src/im/lark/client.js', () => ({ resolveUnionIdFromOpenIdStrict: (...args: any[]) => state.lookup(...args) }));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({ canOperate: () => state.allowed }));
vi.mock('../src/services/session-store.js', () => ({ readBotSessionsStrict: (appId: string) => appId === 'app_a' ? state.sessions : [] }));

import {
  assertAutomationSession, assertAutomationUserAllowed, automationTrustedCaller,
  collectAutomationUsers, freezeAutomationTurnUser, resolveAutomationUser,
} from '../src/services/automation-identity.js';

const user = { larkAppId: 'app_a', openId: 'ou_selected', unionId: 'on_selected' };
const identity = (openId: string, overrides: Partial<IdentityRecord> = {}): IdentityRecord => ({
  openId, type: 'user', source: 'contact_api', updatedAt: 1, ...overrides,
});
beforeEach(() => {
  state.config = { triggerUserAuth: { enabled: true, tools: ['bytedcli'], fallback: 'none' } };
  state.identities = [identity(user.openId, { interactedAt: 1, unionId: user.unionId })];
  state.sessions = [];
  state.allowed = true;
  state.lookup.mockReset().mockResolvedValue({ status: 'resolved', unionId: user.unionId });
});

describe('automation execution identity', () => {
  it('offers observed humans and historical session owners, excluding bots, mere mentions, and other apps', () => {
    const users = collectAutomationUsers('app_a', [
      identity('ou_seen', { interactedAt: 1, source: 'contact_api', name: 'Seen' }),
      identity('ou_mention', { source: 'mention' }),
      identity('ou_contact'),
      identity('ou_bot', { type: 'bot', source: 'sender' }),
    ], [
      { larkAppId: 'app_a', ownerOpenId: 'ou_historical', ownerUnionId: 'on_historical' },
      { larkAppId: 'app_b', ownerOpenId: 'ou_foreign', ownerUnionId: 'on_foreign' },
    ] as Session[]);
    expect(users.map(u => u.openId).sort()).toEqual(['ou_historical', 'ou_seen']);
    expect(users.find(u => u.openId === 'ou_historical')?.unionId).toBe('on_historical');
  });

  it('deduplicates owners and retains identity enrichment after later contact lookups', () => {
    const users = collectAutomationUsers('app_a', [identity(user.openId, { interactedAt: 1, name: 'Person', email: 'person@example.test' })],
      [{ larkAppId: 'app_a', ownerOpenId: user.openId, ownerUnionId: user.unionId }] as Session[]);
    expect(users).toEqual([{ openId: user.openId, unionId: user.unionId, name: 'Person', email: 'person@example.test' }]);
  });

  it('resolves only observed users and never accepts a caller-provided identity pair', async () => {
    await expect(resolveAutomationUser('app_a', user.openId)).resolves.toEqual(user);
    await expect(resolveAutomationUser('app_b', user.openId)).rejects.toThrow('run_as_user_not_observed');
    await expect(resolveAutomationUser('app_a', 'ou_arbitrary')).rejects.toThrow('run_as_user_not_observed');
    await expect(resolveAutomationUser('app_a', user)).rejects.toThrow('invalid_run_as_user');
    expect(state.lookup).not.toHaveBeenCalled();
  });

  it('fails closed when a historical user cannot be resolved', async () => {
    state.identities = [identity(user.openId, { interactedAt: 1 })];
    state.lookup.mockResolvedValue({ status: 'unavailable' } as any);
    await expect(resolveAutomationUser('app_a', user.openId)).rejects.toThrow('run_as_user_identity_unavailable');
  });

  it('preserves opt-out behavior while requiring enabled credential wrappers for a selection', async () => {
    state.config.triggerUserAuth.enabled = false;
    await expect(resolveAutomationUser('app_a', '')).resolves.toBeUndefined();
    await expect(resolveAutomationUser('app_a', user.openId)).rejects.toThrow('run_as_requires_trigger_user_auth');
    state.config.triggerUserAuth.enabled = true;
    state.config.triggerUserAuth.tools = [];
    await expect(resolveAutomationUser('app_a', user.openId)).rejects.toThrow('run_as_requires_trigger_user_auth');
  });

  it.each(['bot-identity', 'none', undefined])('accepts a selection with legacy fallback %s without changing bot settings', async fallback => {
    state.config.triggerUserAuth.fallback = fallback;
    await expect(resolveAutomationUser('app_a', user.openId)).resolves.toEqual(user);
    const ds = { larkAppId: 'app_a', chatId: 'oc_chat', session: {}, worker: { killed: false },
      initConfig: { triggerUserAuth: { enabled: true, tools: ['bytedcli'], fallback } } } as unknown as DaemonSession;
    expect(() => assertAutomationSession(user, ds)).not.toThrow();
    expect(state.config.triggerUserAuth.fallback).toBe(fallback);
  });

  it('rechecks access and app binding at execution time', () => {
    expect(() => assertAutomationUserAllowed(user, 'app_a', 'oc_chat')).not.toThrow();
    expect(() => assertAutomationUserAllowed(user, 'app_b', 'oc_chat')).toThrow('run_as_user_access_denied');
    state.allowed = false;
    expect(() => assertAutomationUserAllowed(user, 'app_a', 'oc_chat')).toThrow('run_as_user_access_denied');
  });

  it('rejects a live worker whose frozen credential wrappers do not enforce the selected policy', () => {
    const ds = { larkAppId: 'app_a', chatId: 'oc_chat', session: {}, worker: { killed: false },
      initConfig: { triggerUserAuth: { enabled: false, tools: [], fallback: 'none' } } } as unknown as DaemonSession;
    expect(() => assertAutomationSession(user, ds)).toThrow('run_as_requires_managed_per_user_session');
    ds.initConfig!.triggerUserAuth = state.config.triggerUserAuth;
    expect(() => assertAutomationSession(user, ds)).not.toThrow();
    ds.session.adoptedFrom = { tmuxTarget: 'external:0.0' };
    expect(() => assertAutomationSession(user, ds)).toThrow('run_as_requires_managed_per_user_session');
  });

  it('rolls back only its own unaccepted snapshot without removing another queued turn', () => {
    const ds = { session: {} } as DaemonSession;
    const rollback = freezeAutomationTurnUser(ds, 'rejected', user);
    freezeAutomationTurnUser(ds, 'accepted', user);
    rollback();
    expect(ds.session.replyTargets?.rejected).toBeUndefined();
    expect(ds.session.replyTargets?.accepted.automationUser).toEqual(user);
    const empty = { session: {} } as DaemonSession;
    freezeAutomationTurnUser(empty, 'rejected', user)();
    expect(empty.session.replyTargets).toBeUndefined();
  });

  it('freezes each turn independently, including an explicit default', () => {
    const ds = { session: {} } as DaemonSession;
    freezeAutomationTurnUser(ds, 'turn_a', user);
    freezeAutomationTurnUser(ds, 'turn_b', null);
    freezeAutomationTurnUser(ds, 'turn_a', { ...user, openId: 'ou_later' });
    freezeAutomationTurnUser(ds, 'turn_b', user);
    expect(ds.session.replyTargets?.turn_a.automationUser).toEqual(user);
    expect(ds.session.replyTargets?.turn_b.automationUser).toBeNull();
    expect(automationTrustedCaller(user)).toMatchObject({ source: 'automation', requestUserOpenId: user.openId, requestUserUnionId: user.unionId });
  });
});
