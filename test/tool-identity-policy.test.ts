/**
 * Unified tool identity policy — the contract layer
 * (docs/plans/2026-11-06-tool-identity-policy-refactor.md §3, Phase 1).
 *
 * What matters here:
 * - The FOUR primary per-tool combinations resolve as the matrix says, and
 *   off/unassigned is HOST credentials decided without any identity service.
 * - A configured-but-unusable winning selection fails closed; it never
 *   becomes another user or host mode.
 * - The explicit binding tri-state does not implicitly change native
 *   authentication: without an installed transport, `unset` behaves like the
 *   per-tool baseline, not like `true`.
 * - The production publication path routes through the same selector.
 */
// @bun-test-skip: BASELINE_FAILURE(1fef331d, 2026-11-11) Bun resolves bytedcli-auth before vi.mock; mintByteCloudUserJwts is absent. Vitest remains authoritative.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Publication must not touch credential providers for this suite: the
// off/unassigned cases never consult them, and the managed cases here are
// decided purely by policy.
const mintByteCloudUserJwts = vi.fn(async () => null);
vi.mock('../src/services/bytedcli-auth.js', () => ({
  mintBytedcliJwts: vi.fn(async () => ({ codeJwt: 'code-x' })),
  mintByteCloudUserJwts: (openId: string) => mintByteCloudUserJwts(openId),
  beginBytedcliLogin: vi.fn(async () => ({
    authUrl: 'https://cloud.example.com/auth?state=auto',
    completeToken: 'tok-auto',
  })),
}));
const beginLarkCliLogin = vi.fn(async () => ({
  authUrl: 'https://example.com/lark-device', stage: 'user-login' as const,
}));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  materializeLarkCliHomeForSession: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: () => beginLarkCliLogin(),
}));
vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  DOC_COMMENT_OAUTH_SCOPES: [],
  FEED_GROUP_OAUTH_SCOPES: [],
  resolveOAuthRedirectUri: () => undefined,
  listAuthorizedUsers: () => [],
  resolveOwnerUserToken: vi.fn(async () => null),
  requestUserAuthorization: vi.fn(async () => ({})),
  isUsableOpenId: (openId: string | undefined) => !!openId?.startsWith('ou_'),
}));

const {
  normalizeToolIdentityPolicy,
  unenforceableManagedToolNormalized,
  parseToolIdentityConfig,
  senderLoginTools,
  senderToolCredentialSource,
} = await import('../src/services/tool-identity-config.js');
const { selectTurnExecutionUser, selectToolCredential } = await import('../src/core/tool-identity-policy.js');
const { buildAutomaticTurnDecision, toolIdentityDecisionFromReplyTarget } = await import('../src/core/tool-identity-decision.js');
const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
const { sessionIdentityDataDir } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');

const APP = 'cli_bot';
const ALICE = { larkAppId: APP, openId: 'ou_alice', unionId: 'on_alice', name: 'Alice' };
const BOB = { larkAppId: APP, openId: 'ou_bob', unionId: 'on_bob' };

function policy(overrides: Partial<ReturnType<typeof normalizeToolIdentityPolicy>> = {}) {
  return normalizeToolIdentityPolicy({ larkAppId: APP, ...overrides });
}

describe('normalizeToolIdentityPolicy', () => {
  it('per-turn off leaves the per-tool baseline empty for every tool', () => {
    expect(policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: false, tools: ['lark-cli'] }) ?? undefined }).perTurnTools).toEqual([]);
    expect(policy().perTurnTools).toEqual([]);
  });

  it('per-turn on keeps the configured tool subset', () => {
    const p = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli', 'larkdev'] }) ?? undefined });
    expect(p.perTurnTools).toEqual(['lark-cli', 'larkdev']);
  });

  it('keeps the binding tri-state raw: only explicit true selects the binding', () => {
    expect(policy().larkToolBinding).toBe('unset');
    expect(policy({ larkToolBinding: false }).larkToolBinding).toBe(false);
    expect(policy({ larkToolBinding: true }).larkToolBinding).toBe(true);
    // enforceability follows the EXPLICIT tri-state: unset lark-cli is native
    // (the old implicit inverse of the per-turn policy is gone, plan §3.4)
    expect(unenforceableManagedToolNormalized(policy(), ['lark-cli'])).toBe('lark-cli');
    expect(unenforceableManagedToolNormalized(policy({ larkToolBinding: true }), ['lark-cli'])).toBeUndefined();
    expect(unenforceableManagedToolNormalized(policy({ larkToolBinding: false }), ['lark-cli'])).toBe('lark-cli');
    const perTurnLark = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] }) ?? undefined });
    expect(unenforceableManagedToolNormalized(perTurnLark, ['lark-cli'])).toBeUndefined();
    // ByteCloud tools always need their own per-turn wrapper.
    expect(unenforceableManagedToolNormalized(policy({ larkToolBinding: true }), ['bytedcli'])).toBe('bytedcli');
  });

  it('a rejected automationIdentity is folded into the invalid sentinel, not dropped', () => {
    const p = policy({ automationIdentityInvalid: 'automationIdentity.user.larkAppId does not match this bot' });
    expect(p.automationDefault).toEqual({ invalid: 'automationIdentity.user.larkAppId does not match this bot' });
    expect(policy().automationDefault).toBeNull();
  });

  it('managed capability excludes external app servers and remote backends', () => {
    expect(policy({ backendType: 'pty' }).managedSession).toBe(true);
    expect(policy({ backendType: 'ssh_remote' }).managedSession).toBe(false);
    expect(policy({ existingAppServer: 'https://x' }).managedSession).toBe(false);
  });

  it('enforceability is per tool: lark-cli via the explicit binding, ByteCloud via per-turn', () => {
    const p = policy({ larkToolBinding: true });
    expect(unenforceableManagedToolNormalized(p, ['lark-cli'])).toBeUndefined();
    expect(unenforceableManagedToolNormalized(p, ['bytedcli'])).toBe('bytedcli');
    const off = policy({ larkToolBinding: false });
    expect(unenforceableManagedToolNormalized(off, ['lark-cli'])).toBe('lark-cli');
  });
});

describe('selectTurnExecutionUser (automatic turns)', () => {
  it('off/unassigned resolves no principal: host semantics without any identity service', () => {
    const s = selectTurnExecutionUser({ larkAppId: APP, policy: policy() });
    expect(s.user).toBeUndefined();
    expect(s.source).toBe('none');
    expect(s.failure).toBeUndefined();
    expect(s.tools).toEqual(['lark-cli']);
  });

  it('a valid automatic-only default wins with its own tool scope, over provenance', () => {
    const p = policy({ larkToolBinding: true, automationIdentity: { user: ALICE, tools: ['lark-cli'] } });
    const s = selectTurnExecutionUser({ larkAppId: APP, policy: p, provenance: BOB });
    expect(s.user).toEqual(ALICE);
    expect(s.source).toBe('bot_default');
    expect(s.tools).toEqual(['lark-cli']);
  });

  it('an invalid configured default fails closed and never falls to provenance', () => {
    const p = policy({ automationIdentity: { invalid: 'cross-app user' } });
    const s = selectTurnExecutionUser({
      larkAppId: APP, policy: p, provenance: ALICE,
      canUse: () => true,
    });
    expect(s.user).toBeUndefined();
    expect(s.source).toBe('bot_default');
    expect(s.failure).toBe('invalid_identity');
  });

  it('a cross-app default user is invalid identity', () => {
    const p = policy({ automationIdentity: { user: { ...ALICE, larkAppId: 'cli_other' }, tools: ['lark-cli'] } });
    const s = selectTurnExecutionUser({ larkAppId: APP, policy: p });
    expect(s.failure).toBe('invalid_identity');
    expect(s.user).toBeUndefined();
  });

  it('a revoked default is access denied, not a fallback to another user', () => {
    const p = policy({ larkToolBinding: true, automationIdentity: { user: ALICE, tools: ['lark-cli'] } });
    const s = selectTurnExecutionUser({
      larkAppId: APP, policy: p, provenance: BOB,
      canUse: () => false,
    });
    expect(s.failure).toBe('access_denied');
    expect(s.user).toBeUndefined();
  });

  it('an explicit task selection outranks a broken lower-priority default and keeps the per-turn scope', () => {
    const p = policy({
      automationIdentity: { invalid: 'broken default' },
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] }) ?? undefined,
    });
    const s = selectTurnExecutionUser({
      larkAppId: APP, policy: p, explicit: BOB, explicitSource: 'task',
      canUse: () => true,
    });
    expect(s.user).toEqual(BOB);
    expect(s.source).toBe('task');
    expect(s.tools).toEqual(['lark-cli', 'bytedcli']);
    expect(s.failure).toBeUndefined();
  });

  it('the default tool list never blocks an explicit selection enforced on its own scope', () => {
    const p = policy({
      automationIdentity: { user: ALICE, tools: ['lark-cli'] },
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] }) ?? undefined,
    });
    const s = selectTurnExecutionUser({ larkAppId: APP, policy: p, explicit: BOB, explicitSource: 'connector' });
    expect(s.user).toEqual(BOB);
    expect(s.source).toBe('connector');
    expect(s.tools).toEqual(['lark-cli', 'bytedcli']);
  });

  it('unsupported backends deny managed selection', () => {
    const p = policy({ existingAppServer: 'https://x', automationIdentity: { user: ALICE, tools: ['lark-cli'] } });
    const s = selectTurnExecutionUser({ larkAppId: APP, policy: p, canUse: () => true });
    expect(s.failure).toBe('managed_session_unsupported');
  });

  it('a winning scope with an unenforceable ByteCloud tool is unsupported capability', () => {
    const p = policy({ automationIdentity: { user: ALICE, tools: ['lark-cli', 'bytedcli'] } });
    const s = selectTurnExecutionUser({ larkAppId: APP, policy: p, canUse: () => true });
    expect(s.failure).toBe('unsupported_capability');
    expect(s.user).toBeUndefined();
  });

  it('UNIFIED CONTRACT: provenance is admitted only with per-turn on, and per-turn-on without provenance is a managed-user denial', () => {
    const perTurnOn = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] }) ?? undefined });
    const withProvenance = selectTurnExecutionUser({ larkAppId: APP, policy: perTurnOn, provenance: ALICE });
    expect(withProvenance.user).toEqual(ALICE);
    expect(withProvenance.source).toBe('provenance');

    const denied = selectTurnExecutionUser({ larkAppId: APP, policy: perTurnOn });
    expect(denied.user).toBeUndefined();
    expect(denied.failure).toBe('missing_provenance');
    expect(denied.tools).toEqual(['lark-cli']);

    // per-turn off + no assignment stays host — even with verified creator
    // provenance present: a legacy owner-only task dispatches natively.
    const host = selectTurnExecutionUser({ larkAppId: APP, policy: policy(), provenance: ALICE });
    expect(host.source).toBe('none');
    expect(host.failure).toBeUndefined();
  });
});

describe('selectToolCredential (per-tool frozen decision)', () => {
  it('off/unassigned is host credentials with no identity references attached', () => {
    const d = selectToolCredential({ larkAppId: APP, tool: 'lark-cli', authority: 'human', policy: policy() });
    expect(d).toEqual({ mode: 'host', source: 'native_default' });
    expect(d.mode === 'host' && 'user' in d).toBe(false);
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'automatic', policy: policy() }).mode).toBe('host');
  });

  it('per-turn on resolves the verified sender, or denies — never host', () => {
    const p = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] }) ?? undefined });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'human', policy: p, senderOpenId: 'ou_x' }))
      .toEqual({ mode: 'managed_user', source: 'sender', user: { openId: 'ou_x' }, credentialSource: 'auto' });
    const d = selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'human', policy: p });
    expect(d).toEqual({ mode: 'denied', reason: 'missing_provenance', source: 'sender' });
    // bot senders are not ou_ humans
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'human', policy: p, senderOpenId: 'bot_x' }).mode).toBe('denied');
  });

  it('an installed binding transport owns lark-cli regardless of the per-turn policy', () => {
    const p = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] }) ?? undefined });
    expect(selectToolCredential({ larkAppId: APP, tool: 'lark-cli', authority: 'human', policy: p, senderOpenId: 'ou_x', bindingInstalled: true }).mode).toBe('bound_app');
    expect(selectToolCredential({ larkAppId: APP, tool: 'lark-cli', authority: 'automatic', policy: policy(), bindingInstalled: true }).mode).toBe('bound_app');
    // other tools are unaffected by the binding transport (bytedcli is not
    // per-turn governed here, so its baseline is native)
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'human', policy: p, senderOpenId: 'ou_x', bindingInstalled: true }).mode).toBe('host');
  });

  it('binding UNSET never becomes bound_app without an installed transport', () => {
    const d = selectToolCredential({ larkAppId: APP, tool: 'lark-cli', authority: 'human', policy: policy() });
    expect(d.mode).toBe('host');
  });

  it('a frozen scope exclusion evaluates the independent sender baseline', () => {
    const d = selectToolCredential({
      larkAppId: APP, tool: 'bytedcli', authority: 'automatic',
      policy: policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'] }) ?? undefined }),
      turn: { user: ALICE, source: 'bot_default', tools: ['lark-cli'] },
      senderOpenId: 'ou_sender',
    });
    expect(d).toEqual({ mode: 'managed_user', source: 'sender', user: { openId: 'ou_sender' }, credentialSource: 'auto' });
  });

  it('the frozen principal wins inside its scope', () => {
    const d = selectToolCredential({
      larkAppId: APP, tool: 'bytedcli', authority: 'automatic',
      policy: policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'] }) ?? undefined }),
      turn: { user: ALICE, source: 'task', tools: ['lark-cli', 'bytedcli'] },
      senderOpenId: 'ou_sender',
    });
    expect(d).toEqual({ mode: 'managed_user', source: 'task', user: ALICE, credentialSource: 'auto' });
  });

  it('delegated grants are retained as-is; a governed tool excluded from the grant is denied, an ungoverned one stays native', () => {
    const grant = { grantRef: 'grant-1', permitted: true, tools: ['lark-cli', 'bytedcli'] as const };
    const p = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] }) ?? undefined });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'delegated', policy: p, delegatedGrant: grant }))
      .toMatchObject({ mode: 'delegated', permitted: true });
    // grant exclusion for a governed tool: denial (never host fallback)
    expect(selectToolCredential({ larkAppId: APP, tool: 'lark-cli', authority: 'delegated', policy: p, delegatedGrant: { ...grant, tools: ['bytedcli'] } }))
      .toMatchObject({ mode: 'delegated', permitted: false });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'delegated', policy: p, delegatedGrant: { ...grant, permitted: false } }))
      .toMatchObject({ mode: 'delegated', permitted: false });
    // an ungoverned tool outside the grant is not claimed by the delegation
    expect(selectToolCredential({ larkAppId: APP, tool: 'larkdev', authority: 'delegated', policy: p, delegatedGrant: grant }).mode).toBe('host');
    // a governed tool with no usable grant is denied
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'delegated', policy: p }))
      .toEqual({ mode: 'denied', reason: 'missing_provenance', source: 'delegated' });
  });
});

describe('tool identity decision record (versioned freeze, plan §5.2/§8)', () => {
  it('maps a frozen automatic turn to an explicit mode: host / managed / denied', () => {
    // off/unassigned → HOST, decided and recorded explicitly
    expect(buildAutomaticTurnDecision({ source: 'none', tools: ['lark-cli'] })).toMatchObject({
      v: 1, authority: 'automatic', mode: 'host', source: 'none',
    });
    // a frozen principal → managed_user with the audit source
    expect(buildAutomaticTurnDecision({ user: ALICE, source: 'task', tools: ['lark-cli'] })).toMatchObject({
      mode: 'managed_user', source: 'task', user: { openId: ALICE.openId },
    });
    // a source without a usable user is DENIED, never native
    expect(buildAutomaticTurnDecision({ source: 'bot_default', tools: ['lark-cli'] })).toMatchObject({
      mode: 'denied', failure: 'invalid_identity',
    });
    // the record never carries credential material — only principal references
    const record = JSON.stringify(buildAutomaticTurnDecision({ user: ALICE, source: 'task' }));
    expect(record).not.toMatch(/token|secret|jwt|credential/i);
  });

  it('reads the versioned record first, then normalizes explicit legacy triples, and never guesses from null alone', () => {
    const record = buildAutomaticTurnDecision({ user: BOB, source: 'bot_default', tools: ['lark-cli'] });
    expect(toolIdentityDecisionFromReplyTarget({ toolIdentityDecision: record })).toEqual(record);

    // legacy frozen triple (explicit markers) normalizes to the same contract
    expect(toolIdentityDecisionFromReplyTarget({
      automationUser: BOB, automationIdentitySource: 'bot_default', automationIdentityTools: ['lark-cli'],
    })).toMatchObject({ mode: 'managed_user', source: 'bot_default' });
    expect(toolIdentityDecisionFromReplyTarget({
      automationUser: null, automationIdentitySource: 'none', automationIdentityTools: ['lark-cli'],
    })).toMatchObject({ mode: 'host' });
    expect(toolIdentityDecisionFromReplyTarget({
      automationUser: null, automationIdentitySource: 'bot_default', automationIdentityTools: ['lark-cli'],
    })).toMatchObject({ mode: 'denied' });

    // §9: `automationUser: null` ALONE is ambiguous — no mode is guessed.
    expect(toolIdentityDecisionFromReplyTarget({ automationUser: null })).toBeUndefined();
    // an ordinary human turn's reply target carries no decision
    expect(toolIdentityDecisionFromReplyTarget({ senderOpenId: 'ou_x' } as any)).toBeUndefined();
    expect(toolIdentityDecisionFromReplyTarget(undefined)).toBeUndefined();
  });
});

describe('fixed bot user assignment (toolIdentity, plan §4.1/§3.2)', () => {
  it('parses into unset | valid | invalid, retaining a broken entry as a configured failure', () => {
    expect(parseToolIdentityConfig(undefined).value).toBeUndefined();
    const valid = parseToolIdentityConfig({
      defaultUser: { larkAppId: APP, openId: 'ou_alice', unionId: 'on_alice', name: 'Alice' },
      tools: ['lark-cli', 'bytedcli'], credentialSource: 'platform',
    });
    expect(valid.value).toMatchObject({
      user: { openId: 'ou_alice', unionId: 'on_alice' },
      tools: ['lark-cli', 'bytedcli'], credentialSource: 'platform',
    });
    // default scope + auto source
    expect(parseToolIdentityConfig({ defaultUser: { larkAppId: APP, openId: 'ou_alice', unionId: 'on_alice' } }).value)
      .toMatchObject({ tools: ['lark-cli'], credentialSource: 'auto' });
    // cross-app, unknown tools, empty tools → invalid (fail closed), never unset
    expect(parseToolIdentityConfig({ defaultUser: { larkAppId: 'cli_other', openId: 'ou_a', unionId: 'on_a' } }, APP).value)
      .toEqual({ invalid: 'toolIdentity.defaultUser.larkAppId does not match this bot' });
    expect(parseToolIdentityConfig({ defaultUser: { larkAppId: APP, openId: 'ou_a', unionId: 'on_a' }, tools: ['nope'] }).value)
      .toMatchObject({ invalid: expect.stringContaining('unknown entries') });
    expect(parseToolIdentityConfig({ defaultUser: { larkAppId: APP, openId: 'ou_a', unionId: 'on_a' }, tools: [] }).value)
      .toMatchObject({ invalid: expect.stringContaining('must not be empty') });
  });

  it('HUMAN turn, per-turn off + fixed user in scope → that user; per-turn on → sender wins', () => {
    const fixed = { user: ALICE, tools: ['bytedcli'] as ('lark-cli' | 'bytedcli')[], credentialSource: 'auto' as const };
    const p = policy({ toolIdentity: fixed });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'human', policy: p, senderOpenId: 'ou_sender' }))
      .toEqual({ mode: 'managed_user', source: 'automatic_default', user: ALICE, credentialSource: 'auto' });
    // a governed tool still outranks the fixed assignment
    const governed = policy({
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'] }) ?? undefined,
      toolIdentity: fixed,
    });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'human', policy: governed, senderOpenId: 'ou_sender' }).source).toBe('sender');
    // outside the fixed scope → native baseline
    expect(selectToolCredential({ larkAppId: APP, tool: 'larkdev', authority: 'human', policy: p }).mode).toBe('host');
    // a broken winning assignment denies instead of going native
    const broken = policy({ toolIdentity: { invalid: 'cross-app user' } });
    expect(selectToolCredential({ larkAppId: APP, tool: 'lark-cli', authority: 'human', policy: broken }))
      .toEqual({ mode: 'denied', reason: 'config_invalid', source: 'automatic_default' });
  });

  it('AUTOMATIC turn: fixed user is the LOWEST-priority assignment; a broken one fails closed', async () => {
    const fixed = { user: ALICE, tools: ['lark-cli'] as const, credentialSource: 'auto' as const };
    const withFixed = policy({ larkToolBinding: true, toolIdentity: fixed });
    expect(selectTurnExecutionUser({ larkAppId: APP, policy: withFixed })).toMatchObject({
      user: ALICE, source: 'automatic_default', tools: ['lark-cli'],
    });
    // the automatic-only default outranks the fixed user
    const both = policy({
      larkToolBinding: true,
      automationIdentity: { user: BOB, tools: ['lark-cli'] },
      toolIdentity: fixed,
    });
    expect(selectTurnExecutionUser({ larkAppId: APP, policy: both })).toMatchObject({ user: BOB, source: 'bot_default' });
    // a broken fixed user is a configured failure, never host
    const broken = policy({ larkToolBinding: true, toolIdentity: { invalid: 'bad' } });
    expect(selectTurnExecutionUser({ larkAppId: APP, policy: broken })).toMatchObject({
      source: 'automatic_default', failure: 'config_invalid',
    });
    // the resolver maps it into the legacy failure union
    const { resolveAutomationIdentity } = await import('../src/services/automation-identity.js');
    expect(resolveAutomationIdentity({ appId: APP, chatId: 'oc', config: { larkToolBinding: true, toolIdentityInvalid: 'bad' } }))
      .toMatchObject({ source: 'automatic_default', failure: 'invalid_identity' });
  });
});

describe('publishTurnCliIdentity routes through the selector (production path)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-tool-identity-policy-'));
    mintByteCloudUserJwts.mockClear();
    beginLarkCliLogin.mockClear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function config(triggerUserAuth: unknown, larkToolBinding?: boolean) {
    return {
      larkAppId: APP,
      larkAppSecret: 'secret',
      brand: 'feishu' as const,
      triggerUserAuth: parseTriggerUserAuthConfig(triggerUserAuth) ?? undefined,
      ...(larkToolBinding !== undefined ? { larkToolBinding } : {}),
    } as any;
  }

  it('off/unassigned publishes nothing and consults no identity service — host execution', async () => {
    const outcomes = await publishTurnCliIdentity({
      botConfig: config({ enabled: false }),
      sessionDataDir: dir,
      sessionId: 'sess-host',
      senderOpenId: 'ou_alice',
      turnId: 'turn-1',
      storageModel: 'single',
    });
    expect(outcomes.map(o => o.state)).toEqual(['off', 'off', 'off']);
    const identityDir = sessionIdentityDataDir(dir, 'sess-host');
    for (const tool of ['lark-cli', 'bytedcli', 'larkdev']) {
      expect(existsSync(join(identityDir, `${tool}.env`))).toBe(false);
    }
    expect(mintByteCloudUserJwts).not.toHaveBeenCalled();
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('an automatic turn frozen to "no user" still refuses governed tools (fail closed), and leaves ungoverned tools native', async () => {
    const outcomes = await publishTurnCliIdentity({
      botConfig: config({ enabled: true, tools: ['bytedcli'] }),
      sessionDataDir: dir,
      sessionId: 'sess-auto',
      senderOpenId: undefined,
      turnId: 'turn-2',
      storageModel: 'single',
      tools: ['bytedcli'],
    });
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    // lark-cli is out of the frozen scope: no material, native baseline.
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('off');
    expect(existsSync(join(sessionIdentityDataDir(dir, 'sess-auto'), 'lark-cli.env'))).toBe(false);
    // The ByteCloud provider was never asked: the denial is a policy decision.
    expect(mintByteCloudUserJwts).not.toHaveBeenCalled();
  });

  it('publishes explicit host execution for an unconfigured join despite the ordinary sender policy', async () => {
    const decision = buildAutomaticTurnDecision({
      source: 'none', tools: ['lark-cli', 'bytedcli', 'larkdev'],
      policy: policy({ perTurnTools: [] }),
    });
    const outcomes = await publishTurnCliIdentity({
      botConfig: config({ enabled: true, tools: ['lark-cli', 'bytedcli', 'larkdev'] }),
      policy: policy({ perTurnTools: [] }), decision,
      sessionDataDir: dir, sessionId: 'sess-host-join', senderOpenId: undefined,
      turnId: 'join_host', storageModel: 'single',
    });
    expect(outcomes.every(outcome => outcome.state === 'off')).toBe(true);
    const fs = await import('node:fs');
    for (const tool of ['lark-cli', 'bytedcli', 'larkdev', 'codebase']) {
      expect(fs.readFileSync(join(sessionIdentityDataDir(dir, 'sess-host-join'), `${tool}.env`), 'utf8'))
        .toContain("BOTMUX_IDENTITY_MODE='host'");
    }
    expect(mintByteCloudUserJwts).not.toHaveBeenCalled();
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });
});


describe('fixed user persistence and independent tool policy', () => {
  it.each(['auto', 'platform', 'local'] as const)('round-trips the normalized fixed user with %s credentials', source => {
    const first = parseToolIdentityConfig({ defaultUser: ALICE, tools: ['lark-cli', 'bytedcli'], credentialSource: source }, APP);
    expect(parseToolIdentityConfig(JSON.parse(JSON.stringify(first.value)), APP)).toEqual(first);
  });

  it.each(['lark-cli', 'bytedcli', 'larkdev'] as const)('admits a fixed %s user with sender auth off and binding unset', tool => {
    const p = policy({ toolIdentity: { user: ALICE, tools: [tool], credentialSource: 'platform' } });
    expect(selectTurnExecutionUser({ larkAppId: APP, policy: p })).toMatchObject({ user: ALICE, tools: [tool] });
    expect(selectTurnExecutionUser({ larkAppId: APP, policy: p }).failure).toBeUndefined();
  });

  it.each([BOB.openId, undefined])('evaluates an excluded tool against its own sender policy (%s)', sender => {
    const p = policy({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' }) ?? undefined });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'automatic', policy: p,
      turn: { user: ALICE, source: 'bot_default', tools: ['lark-cli'] }, senderOpenId: sender,
    })).toEqual(sender
      ? { mode: 'managed_user', source: 'sender', user: { openId: sender }, credentialSource: 'platform' }
      : { mode: 'denied', reason: 'missing_provenance', source: 'sender' });
  });

  it('uses an independent fixed assignment outside the automatic assignment scope', () => {
    const p = policy({ toolIdentity: { user: BOB, tools: ['bytedcli'], credentialSource: 'local' } });
    expect(selectToolCredential({ larkAppId: APP, tool: 'bytedcli', authority: 'automatic', policy: p,
      turn: { user: ALICE, source: 'task', tools: ['lark-cli'] },
    })).toEqual({ mode: 'managed_user', source: 'automatic_default', user: BOB, credentialSource: 'local' });
  });

  it('lets only the fixed user manage fixed-tool credentials when sender auth is off', () => {
    const config = { larkAppId: APP, toolIdentity: {
      user: ALICE, tools: ['bytedcli', 'larkdev'] as Array<'bytedcli' | 'larkdev'>,
      credentialSource: 'local' as const,
    } };
    expect(senderLoginTools(config, ALICE.openId)).toEqual(['bytedcli', 'larkdev']);
    expect(senderToolCredentialSource(config, ALICE.openId, 'bytedcli')).toBe('local');
    expect(senderLoginTools(config, BOB.openId)).toEqual([]);
  });

  it('uses the per-turn source before a fixed assignment for the same sender and tool', () => {
    const config = { larkAppId: APP,
      triggerUserAuth: parseTriggerUserAuthConfig({
        enabled: true, tools: ['bytedcli'], credentialSource: 'platform',
      }) ?? undefined,
      toolIdentity: { user: ALICE, tools: ['bytedcli'] as Array<'bytedcli'>, credentialSource: 'local' as const },
    };
    expect(senderToolCredentialSource(config, ALICE.openId, 'bytedcli')).toBe('platform');
    expect(senderToolCredentialSource(config, BOB.openId, 'bytedcli')).toBe('platform');
  });
});
