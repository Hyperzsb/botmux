/**
 * Normalized tool identity policy configuration.
 *
 * This is the normalized contract layer between the public bot configuration
 * (`triggerUserAuth`, `automationIdentity`, `larkToolBinding`, and later the
 * fixed-bot `toolIdentity` assignment) and the pure per-tool selector in
 * `core/tool-identity-policy.ts`. It exists so that admission, publication,
 * and diagnostics all read ONE policy shape instead of re-deriving precedence
 * from parallel optional fields (plan §4.2: "avoid parallel optional
 * properties whose combinations can contradict one another").
 *
 * Like `automation-identity-config.ts`, this module has no runtime dependency
 * on bot-registry: it is imported by both the config loader and the resolver.
 * It holds no credentials and no live bot state.
 */
import {
  TRIGGER_USER_AUTH_DEFAULT_TOOLS,
  TRIGGER_USER_AUTH_TOOLS,
  type TriggerUserAuthConfig,
  type TriggerUserAuthTool,
  credentialSourceOf,
  triggerUserAuthApplies,
  type TriggerUserAuthCredentialSource,
} from './trigger-user-auth.js';
import {
  automationIdentityTools,
  DEFAULT_AUTOMATION_IDENTITY_TOOLS,
  isInvalidAutomationIdentity,
  type AutomationIdentitySetting,
  type AutomationUser,
} from './automation-identity-config.js';

/**
 * Backends whose local session can host the managed per-user wrappers (the
 * PTY/Tmux family plus the managed-RPC backends that re-use the same wrapper
 * machinery). Adopt, external app servers, and remote backends are excluded:
 * an execution environment without the wrappers must never silently fall back
 * to the host login (plan §5.4).
 */
export const MANAGED_IDENTITY_BACKENDS = ['pty', 'tmux', 'herdr', 'zellij', 'zmx'] as const;

/** Whether this bot/backend combination can enforce a managed per-user run. */
export function managedSessionCapable(config: {
  backendType?: string;
  existingAppServer?: unknown;
}): boolean {
  return !config.existingAppServer
    && (!config.backendType
      || (MANAGED_IDENTITY_BACKENDS as readonly string[]).includes(config.backendType));
}

/**
 * The first tool in `tools` this bot cannot currently enforce a managed
 * per-user run on, or undefined when the whole scope is enforceable.
 *
 * Capability is per tool (plan §3.2 rule 3): `lark-cli` is provided by the
 * managed app binding even when per-turn auth is off. Fixed assignments and
 * per-turn policy install the same personal wrappers. Resolver, save-time
 * validation and diagnostics therefore share the same capability plan.
 */
export function unenforceableManagedTool(
  config: {
    larkToolBinding?: boolean;
    triggerUserAuth?: TriggerUserAuthConfig | null;
    toolIdentity?: ToolIdentitySetting;
    identityTools?: readonly TriggerUserAuthTool[];
  },
  tools: readonly TriggerUserAuthTool[],
): TriggerUserAuthTool | undefined {
  return unenforceableManagedToolNormalized(normalizeToolIdentityPolicy({
    larkAppId: '',
    ...config,
  }), tools);
}

/** {@link unenforceableManagedTool} over the normalized policy. This is the
 *  form the pure selector consumes. `lark-cli` is enforceable when the bot
 *  EXPLICITLY bound the application or governs lark-cli through the per-turn
 *  policy or fixed-user assignment; ByteCloud tools need a personal wrapper. */
export function unenforceableManagedToolNormalized(
  policy: Pick<NormalizedToolIdentityPolicy, 'larkToolBinding' | 'wrapperTools'>,
  tools: readonly TriggerUserAuthTool[],
): TriggerUserAuthTool | undefined {
  return tools.find(tool => tool === 'lark-cli'
    ? !(policy.larkToolBinding === true) && !policy.wrapperTools.includes('lark-cli')
    : !policy.wrapperTools.includes(tool));
}

/**
 * The normalized, per-bot tool identity policy consumed by
 * `core/tool-identity-policy.ts`. Every field is derived from the stored
 * configuration exactly once, here, so callers cannot disagree.
 */
export interface NormalizedToolIdentityPolicy {
  /** Bot app the stored identifiers are scoped to. */
  larkAppId: string;
  /** Tools whose per-turn sender authentication is enabled. Empty = off for
   *  every tool: the per-tool baseline is then the tool's native host policy. */
  perTurnTools: readonly TriggerUserAuthTool[];
  perTurnCredentialSource: TriggerUserAuthCredentialSource;
  /** Transport installed at spawn, independent of the selected principal. */
  wrapperTools: readonly TriggerUserAuthTool[];
  /**
   * The RAW explicit Lark application binding tri-state (plan §3.4).
   * `larkToolBindingEnabled` resolves it: only explicit `true` selects the
   * managed app binding; `unset` and `false` both mean the tool stays on its
   * native host baseline. The old implicit inverse of the per-turn policy is
   * gone (plan §2).
   */
  larkToolBinding: 'unset' | true | false;
  /** Automatic-only bot default, including the configured-invalid sentinel.
   *  Kept automatic-only during migration (plan §4.1). */
  automationDefault: AutomationIdentitySetting | null;
  /**
   * The fixed bot user assignment (`toolIdentity.defaultUser`, plan §4.1),
   * including the configured-invalid sentinel. Applies to human turns when
   * the per-turn policy is off for a tool, and is the lower-priority
   * automatic default. `null` = unset.
   */
  fixedBotUser: ToolIdentitySetting | null;
  /** Whether the bot/backend can enforce managed per-user runs at all. */
  managedSession: boolean;
}

/** Bot configuration subset the normalization reads. */
export type ToolIdentityPolicyConfig = {
  larkAppId: string;
  triggerUserAuth?: TriggerUserAuthConfig | null;
  larkToolBinding?: boolean;
  automationIdentity?: AutomationIdentitySetting;
  automationIdentityInvalid?: string;
  toolIdentity?: ToolIdentitySetting;
  toolIdentityInvalid?: string;
  backendType?: string;
  existingAppServer?: unknown;
  /** Worker spawn transport scope, when evaluating frozen worker capabilities. */
  identityTools?: readonly TriggerUserAuthTool[];
};

/**
 * Assemble the normalized policy from the stored bot configuration.
 *
 * A rejected `automationIdentity` is carried over as the invalid sentinel
 * (wrapped into the same shape the parser produces) so "configured but
 * broken" stays distinguishable from "unset" (plan §4.2).
 */
export function normalizeToolIdentityPolicy(config: ToolIdentityPolicyConfig): NormalizedToolIdentityPolicy {
  const perTurnTools: readonly TriggerUserAuthTool[] = config.triggerUserAuth?.enabled
    ? [...config.triggerUserAuth.tools]
    : [];
  const automationDefault: AutomationIdentitySetting | null = (() => {
    if (config.automationIdentityInvalid !== undefined) {
      return { invalid: config.automationIdentityInvalid };
    }
    if (config.automationIdentity === undefined) return null;
    return config.automationIdentity;
  })();
  const fixedBotUser: ToolIdentitySetting | null = (() => {
    if (config.toolIdentityInvalid !== undefined) {
      return { invalid: config.toolIdentityInvalid };
    }
    if (config.toolIdentity === undefined) return null;
    return config.toolIdentity;
  })();
  const larkToolBinding = config.larkToolBinding === undefined
    ? 'unset' as const
    : config.larkToolBinding;
  return {
    larkAppId: config.larkAppId,
    perTurnTools,
    perTurnCredentialSource: credentialSourceOf(config.triggerUserAuth),
    wrapperTools: config.identityTools ?? wrapperIdentityTools(config),
    larkToolBinding,
    automationDefault,
    fixedBotUser,
    managedSession: managedSessionCapable(config),
  };
}

/**
 * The fixed bot user assignment (plan §4.1): ONE narrowly scoped public
 * concept expressing the "Off | Configured" quadrants of the primary matrix.
 * Its user applies to human turns only when the per-turn policy is off for
 * that tool, and acts as the lower-priority automatic default (after a
 * task/connector override and the automatic-only `automationIdentity`).
 * `automationIdentity` stays automatic-only during migration: silently
 * broadening its historical meaning to normal human turns would change
 * existing operators' authorization choices.
 */
export interface ToolIdentityDefaultUserConfig {
  /** Verified human used as this bot's fixed execution user. */
  user: AutomationUser;
  /** Tools this fixed assignment governs. Explicitly scoped so the fixed
   *  user never silently enables every personal tool. */
  tools: TriggerUserAuthTool[];
  /** Where the fixed user's credentials come from (same matrix as
   *  `triggerUserAuth.credentialSource`). */
  credentialSource: 'auto' | 'platform' | 'local';
  updatedAt?: string;
}

export interface InvalidToolIdentityConfig { invalid: string }
export type ToolIdentitySetting = ToolIdentityDefaultUserConfig | InvalidToolIdentityConfig;

export function isInvalidToolIdentity(
  value: ToolIdentitySetting | null | undefined,
): value is InvalidToolIdentityConfig {
  return !!value && typeof value === 'object' && typeof (value as { invalid?: unknown }).invalid === 'string';
}

const TOOL_IDENTITY_CREDENTIAL_SOURCES = ['auto', 'platform', 'local'] as const;

/**
 * Parse the optional `toolIdentity` entry from `bots.json` into the explicit
 * `unset | valid | invalid` states (plan §4.2). Malformed input is retained
 * as a configured failure (with a warning) rather than dropped, so a broken
 * winning assignment fails closed instead of silently changing mode; the bot
 * itself keeps running.
 */
export function parseToolIdentityConfig(
  raw: unknown,
  larkAppId?: string,
): { value?: ToolIdentitySetting; warning?: string } {
  if (raw === undefined || raw === null) return {};
  const invalid = (warning: string) => ({ value: { invalid: warning } as InvalidToolIdentityConfig, warning });
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('toolIdentity must be an object');
  }
  const rec = raw as Record<string, unknown>;
  // defaultUser is the persisted/public shape; user is accepted for normalized
  // in-memory values and files written during the initial migration.
  if (rec.defaultUser !== undefined && rec.user !== undefined) {
    return invalid('toolIdentity must specify only defaultUser or user');
  }
  const userRaw = rec.defaultUser ?? rec.user;
  if (!userRaw || typeof userRaw !== 'object' || Array.isArray(userRaw)) {
    return invalid('toolIdentity.defaultUser must be an object');
  }
  const user = userRaw as Record<string, unknown>;
  if (typeof user.larkAppId !== 'string' || !/^cli_[A-Za-z0-9_-]+$/.test(user.larkAppId)) {
    return invalid('toolIdentity.defaultUser.larkAppId must be a cli_* app id');
  }
  if (larkAppId && user.larkAppId !== larkAppId) {
    return invalid('toolIdentity.defaultUser.larkAppId does not match this bot');
  }
  if (typeof user.openId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(user.openId)) {
    return invalid('toolIdentity.defaultUser.openId must be an ou_* open id');
  }
  if (typeof user.unionId !== 'string' || !/^on_[A-Za-z0-9_-]+$/.test(user.unionId)) {
    return invalid('toolIdentity.defaultUser.unionId must be an on_* union id');
  }

  let tools: TriggerUserAuthTool[] = [...DEFAULT_AUTOMATION_IDENTITY_TOOLS];
  if (rec.tools !== undefined) {
    if (!Array.isArray(rec.tools)) return invalid('toolIdentity.tools must be an array');
    const unknown = rec.tools.filter(tool => typeof tool !== 'string'
      || !(TRIGGER_USER_AUTH_TOOLS as readonly string[]).includes(tool));
    if (unknown.length) {
      return invalid(`toolIdentity.tools has unknown entries: ${unknown.map(String).join(', ')}`);
    }
    tools = [...new Set(rec.tools as TriggerUserAuthTool[])];
  }
  if (tools.length === 0) return invalid('toolIdentity.tools must not be empty');

  let credentialSource: (typeof TOOL_IDENTITY_CREDENTIAL_SOURCES)[number] = 'auto';
  if (rec.credentialSource !== undefined && rec.credentialSource !== null) {
    if (!(TOOL_IDENTITY_CREDENTIAL_SOURCES as readonly unknown[]).includes(rec.credentialSource)) {
      return invalid(`toolIdentity.credentialSource must be one of ${TOOL_IDENTITY_CREDENTIAL_SOURCES.join(' | ')}`);
    }
    credentialSource = rec.credentialSource as (typeof TOOL_IDENTITY_CREDENTIAL_SOURCES)[number];
  }

  const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : undefined;
  const updatedAt = typeof rec.updatedAt === 'string' && rec.updatedAt.trim() ? rec.updatedAt : undefined;
  return {
    value: {
      user: {
        larkAppId: user.larkAppId,
        openId: user.openId,
        unionId: user.unionId,
        ...(name ? { name } : {}),
      },
      tools,
      credentialSource,
      ...(updatedAt ? { updatedAt } : {}),
    },
  };
}

/**
 * The wrapper-installation scope for a worker spawn: the per-turn tools plus
 * the fixed bot user's tools. A fixed personal account must remain
 * enforceable without globally enabling sender mode (plan §12.1) — the
 * wrapper is TRANSPORT; the per-tool decision of WHO executes stays with the
 * daemon-side policy selector.
 */
export function wrapperIdentityTools(config: {
  // Accept the pre-normalization legacy shape too: omitted `tools` means the
  // historical lark-cli + bytedcli scope, not an empty wrapper set.
  triggerUserAuth?: Partial<TriggerUserAuthConfig> | null;
  toolIdentity?: ToolIdentitySetting;
  toolIdentityInvalid?: string;
}): TriggerUserAuthTool[] {
  const tools = new Set<TriggerUserAuthTool>();
  if (config.triggerUserAuth?.enabled) {
    for (const tool of config.triggerUserAuth.tools ?? TRIGGER_USER_AUTH_DEFAULT_TOOLS) tools.add(tool);
  }
  const fixed = config.toolIdentity;
  if (fixed && !isInvalidToolIdentity(fixed)) {
    for (const tool of fixed.tools) tools.add(tool);
  }
  return [...tools];
}

/**
 * Credential source a sender is allowed to manage through `/login` for one
 * tool. Per-turn sender policy has the same precedence as execution: when it
 * governs the tool, every admitted human manages their own credentials. When
 * it is off, only the fixed bot user may manage the fixed assignment's
 * credentials; another talk-only user must never write a login into that
 * principal's HOME.
 */
export function senderToolCredentialSource(
  config: Pick<ToolIdentityPolicyConfig,
    'larkAppId' | 'triggerUserAuth' | 'toolIdentity' | 'toolIdentityInvalid'>,
  senderOpenId: string | undefined,
  tool: TriggerUserAuthTool,
): TriggerUserAuthCredentialSource | undefined {
  if (triggerUserAuthApplies(config.triggerUserAuth, tool)) {
    return credentialSourceOf(config.triggerUserAuth);
  }
  if (!senderOpenId || config.toolIdentityInvalid !== undefined) return undefined;
  const fixed = config.toolIdentity;
  if (!fixed || isInvalidToolIdentity(fixed)
    || fixed.user.larkAppId !== config.larkAppId
    || fixed.user.openId !== senderOpenId
    || !fixed.tools.includes(tool)) return undefined;
  return fixed.credentialSource;
}

/** Personal tools for which this exact sender may establish credentials. */
export function senderLoginTools(
  config: Pick<ToolIdentityPolicyConfig,
    'larkAppId' | 'triggerUserAuth' | 'toolIdentity' | 'toolIdentityInvalid'>,
  senderOpenId: string | undefined,
): TriggerUserAuthTool[] {
  return TRIGGER_USER_AUTH_TOOLS.filter(tool =>
    senderToolCredentialSource(config, senderOpenId, tool) !== undefined);
}

/**
 * Effective automatic-default tool scope for the normalized policy (the same
 * precedence `automationIdentityTools` encodes, read off the normalized
 * shape): the explicit default's tools, then the per-turn tools, then the
 * managed lark binding alone.
 */
export function normalizedAutomaticTools(policy: {
  automationDefault: AutomationIdentitySetting | null;
  perTurnTools: readonly TriggerUserAuthTool[];
}): TriggerUserAuthTool[] {
  if (policy.automationDefault && !isInvalidAutomationIdentity(policy.automationDefault)
    && policy.automationDefault.tools?.length) {
    return [...policy.automationDefault.tools];
  }
  if (policy.perTurnTools.length) return [...policy.perTurnTools];
  return ['lark-cli'];
}

/**
 * Tool scope for an explicit task/connector Run as: it follows the bot's
 * ordinary per-turn policy, never the automatic default's narrower list.
 */
export function normalizedExplicitTools(policy: {
  perTurnTools: readonly TriggerUserAuthTool[];
}): TriggerUserAuthTool[] {
  return normalizedAutomaticTools({ ...policy, automationDefault: null });
}

/** Re-export so callers of the normalized layer need no second import path. */
export { automationIdentityTools, isInvalidAutomationIdentity };

/** Persist the public shape while keeping the runtime principal at `user`. */
export function serializeToolIdentityConfig(value: ToolIdentityDefaultUserConfig) {
  const { user, ...rest } = value;
  return { defaultUser: { ...user }, ...rest };
}

/** No await boundary for bots with no managed personal-tool policy. */
export function toolIdentityPublicationEnabled(config: ToolIdentityPolicyConfig): boolean {
  const policy = normalizeToolIdentityPolicy(config);
  return policy.wrapperTools.length > 0 || isInvalidToolIdentity(policy.fixedBotUser);
}

/** Shared admission gate for fresh and existing workers, for every entry type. */
export function assertToolIdentitySession(
  config: ToolIdentityPolicyConfig,
  session: {
    worker?: { killed?: boolean } | null;
    initConfig?: { triggerUserAuth?: TriggerUserAuthConfig | null; identityTools?: readonly TriggerUserAuthTool[]; larkToolBinding?: boolean } | null;
    adoptedFrom?: unknown;
    session: { backendType?: string; adoptedFrom?: unknown };
  },
  tools: readonly TriggerUserAuthTool[],
): void {
  if (!tools.length) return;
  if (!managedSessionCapable(config)) throw new Error('run_as_requires_managed_local_session');
  const unable = unenforceableManagedTool(config, tools);
  if (unable) throw new Error(`run_as_requires_managed_tool:${unable}`);
  if (session.adoptedFrom || session.session.adoptedFrom
    || !managedSessionCapable({ backendType: session.session.backendType })
    || (session.worker && !session.worker.killed
      && (!session.initConfig || unenforceableManagedTool(session.initConfig, tools)))) {
    throw new Error('run_as_requires_managed_per_user_session');
  }
}
