/**
 * Bot-level automation identity configuration.
 *
 * This module deliberately has no runtime dependency on bot-registry: it is
 * imported by the config loader, while `automation-identity.ts` (which reads
 * live bots through getBot) imports these types. Keeping the shape and parser
 * here avoids an import cycle between the registry and the resolver.
 */
import {
  TRIGGER_USER_AUTH_TOOLS,
  type TriggerUserAuthTool,
  type TriggerUserAuthConfig,
} from './trigger-user-auth.js';

/** App-scoped execution identity. Contains no credentials; resolved only by the host. */
export interface AutomationUser {
  larkAppId: string;
  openId: string;
  unionId: string;
  name?: string;
}

export interface AutomationIdentityConfig {
  /** Verified human used for automatic turns that have no task/connector-level
   *  Run as selection and no authenticated event actor. */
  user: AutomationUser;
  /** Tools this automation identity governs. Explicitly scoped so a bot
   *  automation default never silently enables every personal tool. */
  tools: TriggerUserAuthTool[];
  updatedAt?: string;
}

/** Parser result for a configured-but-rejected default. Keeping this in
 *  `value` (rather than dropping to undefined) lets every resolver distinguish
 *  "explicitly configured invalid" from "unset" and fail closed. */
export interface InvalidAutomationIdentityConfig {
  invalid: string;
}
export type AutomationIdentitySetting = AutomationIdentityConfig | InvalidAutomationIdentityConfig;

export function isInvalidAutomationIdentity(
  value: AutomationIdentitySetting | null | undefined,
): value is InvalidAutomationIdentityConfig {
  return !!value && typeof value === 'object' && typeof (value as { invalid?: unknown }).invalid === 'string';
}

/**
 * The minimum useful automation scope: managed `lark-cli`. That is the only
 * tool whose `--as user` capability is provided by the application binding
 * itself (i.e. works without `triggerUserAuth`). Operators who want ByteCloud
 * tools must opt in through `automationIdentity.tools` — and those tools must
 * also be governed by `triggerUserAuth` on the bot.
 */
export const DEFAULT_AUTOMATION_IDENTITY_TOOLS: readonly TriggerUserAuthTool[] = ['lark-cli'];

const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]+$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]+$/;
const APP_ID_RE = /^cli_[A-Za-z0-9_-]+$/;

/** Parse the optional `automationIdentity` entry from `bots.json`.
 *
 * Malformed input is ignored (logged by callers through the returned warning)
 * rather than aborting the whole bot: the setting is an automation convenience,
 * and refusing to start a bot because one optional identity field was mistyped
 * would take a working bot offline. Every resolution path re-validates the
 * stored identity against the live app, so an ignored entry fails closed.
 */
export function parseAutomationIdentityConfig(
  raw: unknown,
  larkAppId?: string,
): { value?: AutomationIdentitySetting; warning?: string } {
  if (raw === undefined || raw === null) return {};
  const invalid = (warning: string) => ({ value: { invalid: warning }, warning });
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('automationIdentity must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const userRaw = rec.user;
  if (!userRaw || typeof userRaw !== 'object' || Array.isArray(userRaw)) {
    return invalid('automationIdentity.user must be an object');
  }
  const user = userRaw as Record<string, unknown>;
  if (typeof user.larkAppId !== 'string' || !APP_ID_RE.test(user.larkAppId)) {
    return invalid('automationIdentity.user.larkAppId must be a cli_* app id');
  }
  if (larkAppId && user.larkAppId !== larkAppId) {
    return invalid('automationIdentity.user.larkAppId does not match this bot');
  }
  if (typeof user.openId !== 'string' || !OPEN_ID_RE.test(user.openId)) {
    return invalid('automationIdentity.user.openId must be an ou_* open id');
  }
  if (typeof user.unionId !== 'string' || !UNION_ID_RE.test(user.unionId)) {
    return invalid('automationIdentity.user.unionId must be an on_* union id');
  }

  let tools: TriggerUserAuthTool[] = [...DEFAULT_AUTOMATION_IDENTITY_TOOLS];
  if (rec.tools !== undefined) {
    if (!Array.isArray(rec.tools)) return invalid('automationIdentity.tools must be an array');
    const unknown = rec.tools.filter(tool => typeof tool !== 'string'
      || !(TRIGGER_USER_AUTH_TOOLS as readonly string[]).includes(tool));
    if (unknown.length) {
      return invalid(`automationIdentity.tools has unknown entries: ${unknown.map(String).join(', ')}`);
    }
    tools = [...new Set(rec.tools as TriggerUserAuthTool[])];
  }
  if (tools.length === 0) return invalid('automationIdentity.tools must not be empty');

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
      ...(updatedAt ? { updatedAt } : {}),
    },
  };
}

/**
 * Effective automation tool scope for a bot.
 *
 * Precedence: the explicit `automationIdentity.tools`, then the tools the bot
 * already governs through `triggerUserAuth` (an operator who chose those tools
 * for human turns has already scoped the personal-tool surface), then the
 * managed lark binding alone. The last fallback is what makes Run as usable on
 * a bot whose per-turn authentication is off — the incident this fixes.
 */
export function automationIdentityTools(config: {
  automationIdentity?: AutomationIdentitySetting;
  triggerUserAuth?: TriggerUserAuthConfig | null;
}): TriggerUserAuthTool[] {
  const configured = config.automationIdentity;
  if (configured && !isInvalidAutomationIdentity(configured) && configured.tools?.length) {
    return [...configured.tools];
  }
  if (config.triggerUserAuth?.enabled && config.triggerUserAuth.tools.length) {
    return [...config.triggerUserAuth.tools];
  }
  return [...DEFAULT_AUTOMATION_IDENTITY_TOOLS];
}

/** Tool scope for an explicit task/connector Run as. It follows the bot's
 *  ordinary per-turn policy; the bot-level default's `tools` belong only to
 *  that default and must not narrow an unrelated explicit selection. */
export function explicitAutomationIdentityTools(config: {
  automationIdentity?: AutomationIdentitySetting;
  triggerUserAuth?: TriggerUserAuthConfig | null;
}): TriggerUserAuthTool[] {
  return automationIdentityTools({ ...config, automationIdentity: undefined });
}
