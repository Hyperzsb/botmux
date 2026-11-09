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
  collectAutomationUsers, freezeAutomationTurnUser, listAutomationUsers,
  resolveAutomationIdentity, resolveAutomationUser, resolveFixedToolUser,
} from '../src/services/automation-identity.js';
import { automationIdentityTools, isInvalidAutomationIdentity, parseAutomationIdentityConfig } from '../src/services/automation-identity-config.js';

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

describe('automation identity config', () => {
  it('defaults the tool scope to the managed lark binding and rejects a foreign app', () => {
    const raw = { user: { larkAppId: 'cli_app_a', openId: 'ou_user', unionId: 'on_user', name: 'User' } };
    expect(parseAutomationIdentityConfig(raw, 'cli_app_a').value).toMatchObject({
      user: { larkAppId: 'cli_app_a', openId: 'ou_user', unionId: 'on_user', name: 'User' },
      tools: ['lark-cli'],
    });
    expect(isInvalidAutomationIdentity(parseAutomationIdentityConfig(raw, 'cli_app_b').value)).toBe(true);
    expect(isInvalidAutomationIdentity(
      parseAutomationIdentityConfig({ ...raw, tools: ['unknown'] }, 'cli_app_a').value,
    )).toBe(true);
    // The effective scope never silently expands to every personal tool.
    expect(automationIdentityTools({ larkToolBinding: true })).toEqual(['lark-cli']);
    expect(automationIdentityTools({ triggerUserAuth: { enabled: true, tools: ['bytedcli'], fallback: 'none' } }))
      .toEqual(['bytedcli']);
  });
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

  it('excludes a session owner that is independently known to be a bot', () => {
    const users = collectAutomationUsers('app_a', [
      identity('ou_alarm_bot', { type: 'bot', source: 'sender' }),
      identity('ou_human', { interactedAt: 1, source: 'contact_api', unionId: 'on_human' }),
    ], [
      { larkAppId: 'app_a', ownerOpenId: 'ou_alarm_bot' },
      { larkAppId: 'app_a', ownerOpenId: 'ou_human', ownerUnionId: 'on_human' },
    ] as Session[]);
    expect(users.map(u => u.openId)).toEqual(['ou_human']);
  });

  it('deduplicates owners and retains identity enrichment after later contact lookups', () => {
    const users = collectAutomationUsers('app_a', [identity(user.openId, { interactedAt: 1, name: 'Person', email: 'person@example.test' })],
      [{ larkAppId: 'app_a', ownerOpenId: user.openId, ownerUnionId: user.unionId }] as Session[]);
    expect(users).toEqual([{ openId: user.openId, unionId: user.unionId, name: 'Person', email: 'person@example.test' }]);
  });

  it('keeps a verified fixed assignment resolvable after observed history is cleaned up', async () => {
    state.config = {
      larkAppId: 'app_a',
      triggerUserAuth: { enabled: false, tools: [], fallback: 'none' },
      toolIdentity: { user: { ...user, name: 'Assigned' }, tools: ['bytedcli'], credentialSource: 'local' },
    };
    state.identities = [];
    state.sessions = [];
    expect(listAutomationUsers('app_a')).toEqual([{
      openId: user.openId, unionId: user.unionId, name: 'Assigned', email: undefined,
    }]);
    await expect(resolveFixedToolUser('app_a', user.openId, ['bytedcli']))
      .resolves.toEqual({ ...user, name: 'Assigned' });
  });

  it('does not revive a configured identity independently known to be a bot', () => {
    state.config = {
      larkAppId: 'app_a',
      toolIdentity: { user, tools: ['bytedcli'], credentialSource: 'local' },
    };
    state.identities = [identity(user.openId, { type: 'bot', source: 'sender' })];
    expect(listAutomationUsers('app_a')).toEqual([]);
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

  it('preserves opt-out behavior and allows a selection through the managed lark binding without trigger-user auth', async () => {
    state.config.triggerUserAuth.enabled = false;
    await expect(resolveAutomationUser('app_a', '')).resolves.toBeUndefined();
    // The managed lark-cli binding enforces --as user on its own; the old
    // global triggerUserAuth.enabled prerequisite made Run as unusable on
    // exactly the bots hit by the default-mode regression. The binding is an
    // explicit opt-in (plan §3.4), so the test bot binds it explicitly.
    state.config.larkToolBinding = true;
    await expect(resolveAutomationUser('app_a', user.openId)).resolves.toEqual(user);
    // An explicit binding-off leaves no wrapper that could enforce the user,
    // so the same selection must be refused rather than silently ignored.
    state.config.larkToolBinding = false;
    await expect(resolveAutomationUser('app_a', user.openId)).rejects.toThrow('run_as_requires_managed_tool:lark-cli');
  });

  it('requires the trigger-user wrapper for ByteCloud automation tools', async () => {
    state.config.triggerUserAuth = { enabled: false, tools: ['bytedcli'], fallback: 'none' };
    // A selection that explicitly targets ByteCloud tools must be validated
    // against those tools; the unrelated bot default is not its policy.
    await expect(resolveAutomationUser('app_a', user.openId, ['bytedcli']))
      .rejects.toThrow('run_as_requires_managed_tool:bytedcli');
    state.config.triggerUserAuth.enabled = true;
    await expect(resolveAutomationUser('app_a', user.openId, ['bytedcli'])).resolves.toEqual(user);
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

  it('rejects a live worker whose frozen wrappers cannot enforce the selected identity', () => {
    const ds = { larkAppId: 'app_a', chatId: 'oc_chat', session: {}, worker: { killed: false },
      initConfig: { triggerUserAuth: { enabled: false, tools: [], fallback: 'none' }, larkToolBinding: false } } as unknown as DaemonSession;
    // Current config can enforce the tool (binding on), but the live worker was
    // spawned without it: it must restart before accepting the run.
    expect(() => assertAutomationSession(user, ds)).toThrow('run_as_requires_managed_per_user_session');
    // A cold session would spawn with the current config, so it is admissible.
    ds.worker = { killed: true } as any;
    expect(() => assertAutomationSession(user, ds)).not.toThrow();
    // No enforceable wrapper at all in the current config.
    state.config.triggerUserAuth.enabled = false;
    state.config.larkToolBinding = false;
    expect(() => assertAutomationSession(user, ds)).toThrow('run_as_requires_managed_tool:lark-cli');
    state.config.larkToolBinding = true;
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

  it('freezes the identity source and effective tool scope with the user', () => {
    const ds = { session: {} } as DaemonSession;
    freezeAutomationTurnUser(ds, 'turn_a', user, { source: 'bot_default', tools: ['lark-cli'] });
    expect(ds.session.replyTargets?.turn_a).toMatchObject({
      automationUser: user,
      automationIdentitySource: 'bot_default',
      automationIdentityTools: ['lark-cli'],
    });
  });

  it('resolves task selection first, then the bot default, then verified provenance (per-turn ON only)', () => {
    const defaultUser = { larkAppId: 'app_a', openId: 'ou_default', unionId: 'on_default' };
    const creator = { larkAppId: 'app_a', openId: 'ou_creator', unionId: 'on_creator' };
    const config = { larkToolBinding: true, automationIdentity: { user: defaultUser, tools: ['lark-cli'] as any } };
    const canUse = () => true;
    expect(resolveAutomationIdentity({ appId: 'app_a', chatId: 'oc', config, explicit: user, explicitSource: 'task', canUse }))
      .toMatchObject({ user, source: 'task', tools: ['lark-cli'] });
    expect(resolveAutomationIdentity({ appId: 'app_a', chatId: 'oc', config, provenance: creator, canUse }))
      .toMatchObject({ user: defaultUser, source: 'bot_default' });
    // Unified contract (plan §3.3 class 5): creator provenance is admitted
    // only while the per-turn policy governs the tool; the schedule entry
    // resolves its verified creator downstream at the exact-turn publication.
    const perTurnOn = { larkToolBinding: true, triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } };
    expect(resolveAutomationIdentity({ appId: 'app_a', chatId: 'oc', config: perTurnOn, provenance: creator, canUse }))
      .toMatchObject({ user: creator, source: 'provenance' });
    // Per-turn off + no assignment → host: a legacy owner-only task dispatches
    // natively and never acquires managed human authority from that.
    const hostResult = resolveAutomationIdentity({ appId: 'app_a', chatId: 'oc', config: { larkToolBinding: true }, provenance: creator, canUse });
    expect(hostResult.source).toBe('none');
    expect(hostResult.user).toBeUndefined();
    expect(hostResult.failure).toBeUndefined();
  });

  it('fails closed on an invalid or revoked configured identity instead of falling through', () => {
    const creator = { larkAppId: 'app_a', openId: 'ou_creator', unionId: 'on_creator' };
    const config = { larkToolBinding: true };
    const invalid = resolveAutomationIdentity({
      appId: 'app_a', chatId: 'oc', config, explicit: { ...user, larkAppId: 'app_b' }, provenance: creator,
      canUse: () => true,
    });
    expect(invalid).toMatchObject({ source: 'task', failure: 'invalid_identity' });
    expect(invalid.user).toBeUndefined();
    const revoked = resolveAutomationIdentity({
      appId: 'app_a', chatId: 'oc', config: { ...config, automationIdentity: { user, tools: ['lark-cli'] } },
      provenance: creator, canUse: () => false,
    });
    expect(revoked).toMatchObject({ source: 'bot_default', failure: 'access_denied' });
    expect(revoked.user).toBeUndefined();
  });

  it('keeps a rejected configured default as an explicit invalid state, not as unset', () => {
    const creator = { larkAppId: 'app_a', openId: 'ou_creator', unionId: 'on_creator' };
    const config = { larkToolBinding: true, automationIdentityInvalid: 'app mismatch' };
    const rejected = resolveAutomationIdentity({
      appId: 'app_a', chatId: 'oc', config, provenance: creator, canUse: () => true,
    });
    expect(rejected).toMatchObject({ source: 'bot_default', failure: 'invalid_identity' });
    expect(rejected.user).toBeUndefined();
    // The parsed value itself also carries the invalid state, so a caller that
    // only forwards `parsed.value` cannot silently fall through to provenance.
    const parsed = parseAutomationIdentityConfig(
      { user: { larkAppId: 'cli_other', openId: 'ou_wrong', unionId: 'on_wrong' } },
      'app_a',
    );
    expect(parsed.warning).toBeTruthy();
    expect(resolveAutomationIdentity({
      appId: 'app_a', chatId: 'oc',
      config: { larkToolBinding: true, automationIdentity: parsed.value },
      provenance: creator, canUse: () => true,
    })).toMatchObject({ source: 'bot_default', failure: 'invalid_identity' });
    // An explicit task/connector selection is higher priority and stays usable
    // even when the unrelated bot default was rejected at load.
    expect(resolveAutomationIdentity({
      appId: 'app_a', chatId: 'oc', config, explicit: user, explicitSource: 'task',
      provenance: creator, canUse: () => true,
    })).toMatchObject({ user, source: 'task' });
  });

  it('resolves an explicit selection independently from an unsupported default tool policy', async () => {
    // The default scope is unenforceable on this bot, but an explicit
    // task/connector selection follows the ordinary per-turn policy instead.
    // Saving it must not be blocked by the unrelated default.
    state.config = {
      larkToolBinding: true,
      triggerUserAuth: { enabled: false, tools: ['bytedcli'], fallback: 'none' },
      automationIdentity: { user, tools: ['bytedcli'] },
    };
    await expect(resolveAutomationUser('app_a', user.openId)).resolves.toEqual(user);
  });

  it('excludes legacy lifecycle synthetic reply senders without independent human evidence', () => {
    const sessions = [{
      larkAppId: 'app_a',
      ownerOpenId: 'ou_alarm_bot',
      replyTargets: {
        join_old: {
          senderOpenId: 'ou_alarm_bot',
          participants: [{ openId: 'ou_alarm_bot', isBot: false }],
          updatedAt: '2026-11-04T02:10:01.978Z',
        },
      },
    }] as unknown as Session[];
    // The old group-entry record asserted isBot:false for an automation bot.
    // Without an independent human record it must not become a Run as option.
    expect(collectAutomationUsers('app_a', [], sessions)).toEqual([]);
    const marked = [{
      larkAppId: 'app_a',
      replyTargets: {
        join_new: {
          senderOpenId: 'ou_alarm_bot',
          participants: [{ openId: 'ou_alarm_bot', isBot: false }],
          lifecycleSynthetic: true,
          updatedAt: '2026-11-06T00:00:00.000Z',
        },
      },
    }] as unknown as Session[];
    expect(collectAutomationUsers('app_a', [], marked)).toEqual([]);
  });
});
