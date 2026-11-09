/**
 * Per-turn publication of the acting CLI identity.
 *
 * This is where the three pieces meet: the bot's {@link TriggerUserAuthConfig}
 * policy, the per-person token store, and the per-turn identity snapshot a
 * wrapper sources when that turn executes.
 *
 * Every publication follows the winning per-tool decision: verified sender,
 * frozen automatic principal, fixed user or delegated grant. Credentials come
 * only from that decision's source; unavailable credentials publish a denial.
 */
import type { ByteCloudUserSite } from '../utils/bytecloud-sites.js';
import { logger } from '../utils/logger.js';
import { lookupAuthorizedUserName } from '../utils/user-token.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import {
  mintByteCloudUserJwts,
  mintBytedcliJwts,
} from '../services/bytedcli-auth.js';
import {
  resolveLarkCliHomeForTurn,
  materializeLarkCliHomeForSession,
  beginLarkCliLogin,
  type LarkCliLoginChallenge,
} from '../services/lark-cli-auth.js';
import { readCliAuthEpoch } from '../services/cli-auth-epoch.js';
import type { BotConfig } from '../bot-registry.js';
import { isLarkToolBound } from './lark-tool-binding.js';
import { rememberLarkToolDelegation } from './lark-tool-delegation.js';
import { registerActiveIdentityTurn } from './active-identity-turns.js';
import {
  credentialSourceOf,
  triggerUserAuthApplies,
  TRIGGER_USER_AUTH_TOOLS,
  type TriggerUserAuthConfig,
  type TriggerUserAuthTool,
  type TriggerUserAuthCredentialSource,
} from '../services/trigger-user-auth.js';
import { normalizeToolIdentityPolicy } from '../services/tool-identity-config.js';
import { selectToolCredential } from './tool-identity-policy.js';
import type { IdentityStorageModel } from './lark-tool-binding.js';
import {
  resolvePlatformIdentity,
  platformAuthorizeUrl,
  platformRefusalReason,
  reasonTag,
  type PlatformIdentityResolution,
} from './platform-credential-source.js';
import {
  writeSessionIdentity,
  clearSessionIdentity,
  recallProvenIdentityContent,
  type CliIdentity,
} from './cli-identity.js';
import { trackBytedcliIdentityRenewal } from './bytedcli-identity-renewal.js';

/** What was published for one tool this turn — drives the user-visible notice. */
export interface ToolIdentityOutcome {
  tool: TriggerUserAuthTool;
  /**
   * - `user`: the sender's own credentials are in force.
   * - `needs-authorization`: nothing published; the sender must authorize
   *   before the tool will work. Neither governed tool degrades to a machine
   *   identity anymore, so there is no other "allowed" outcome.
   * - `unavailable`: the provider failed; retain login state without requesting a new login.
   * - `off`: the policy does not govern this tool; nothing was touched.
   */
  state: 'user' | 'needs-authorization' | 'unavailable' | 'off';
}

/** Created only by the daemon after verifying the signed dispatch and resolving
 * its stable user identity in the receiving app. Never accepted from CLI input. */
export interface DelegatedCliIdentity {
  targetOpenId?: string;
  /** The requester as seen by the ISSUING app: the key of their local
   *  credential stores on this machine. Never valid inside the receiving app. */
  credentialOpenId: string;
  /** Tenant-stable id of the same human, from the verified dispatch record.
   *  The platform key: it needs no lookup in either app. */
  unionId: string;
  tools: TriggerUserAuthTool[];
  dispatchRoot: string;
  /** `delegation_inactive`: a workflow handoff's delegation whose run attempt
   *  ended, or whose handoff was withdrawn (design 2026-11-03 §10.3). */
  denialReason?: 'target_access_denied' | 'target_validation_unavailable' | 'delegation_inactive'
    /** A workflow delegation passed on from a node session into a session
     *  that keeps identities on disk: it could not be re-checked per use. */
    | 'passed_on_unsupported';
  /** A workflow handoff's delegation (design 2026-11-03 §10). */
  workflowHandoff?: true;
  /** Workflow handoff only: re-run its run / attempt / revocation checks
   *  (local reads) and say why it no longer holds. Consulted on every use,
   *  so a stop that never reached this daemon still ends it. Daemon memory
   *  only; never serialized. */
  recheck?: () => string | undefined;
}

/** Replace one tool's published identity for `turnId` with the refusal for
 *  `delegated` (its `denialReason` explains it). Used when a workflow
 *  delegation stops holding while its turn is still running. */
export function publishDelegationRefusal(args: {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  tool: TriggerUserAuthTool;
  delegated: DelegatedCliIdentity;
  storageModel: IdentityStorageModel;
}): void {
  denyDelegated(args.tool, {
    botConfig: {} as BotConfig,
    sessionDataDir: args.sessionDataDir,
    sessionId: args.sessionId,
    senderOpenId: undefined,
    turnId: args.turnId,
    storageModel: args.storageModel,
  }, args.delegated);
}

export interface PublishTurnIdentityArgs {
  botConfig: BotConfig;
  /** Sandbox mode frozen on the session at creation time. */
  sessionSandbox?: BotConfig['sandbox'];
  sessionDataDir: string;
  sessionId: string;
  /** The person who sent THIS turn. Absent for turns with no human sender. */
  senderOpenId: string | undefined;
  delegatedIdentity?: DelegatedCliIdentity;
  /** For the stderr text the wrapper prints when a command is refused. */
  locale?: Locale;
  /**
   * The turn these credentials are for. Stamped into the file so the wrapper can
   * refuse to use them during a different turn — the CLI runs its own queue, so
   * a newer message's credentials can land while an older turn is still going.
   */
  turnId?: string;
  /** Whether publication keeps the identity in daemon memory (proven) or in the
   *  legacy single-snapshot file (single). The caller derives this with the
   *  same predicate the worker uses to render the wrapper. */
  storageModel: IdentityStorageModel;
  /** The turn's chat is a 1:1 chat between the sender and the bot. Only then
   *  may a refusal carry an authorization link for the agent to relay: in a
   *  group, whoever opens the link authorizes as themselves. */
  privateChat?: boolean;
  /**
   * Scope of the automatic assignment. Excluded tools keep their independent
   * baseline; new records carry that baseline in `decision`. Undefined keeps
   * the ordinary per-bot policy (human turns and delegated identities).
   */
  tools?: readonly TriggerUserAuthTool[];
  /** Exact-turn assignment and independent policy baselines frozen at admission. */
  decision?: import('./tool-identity-decision.js').ToolIdentityDecisionRecord;
  /** Effective policy with frozen baselines overlaid on current capabilities. */
  policy?: import('../services/tool-identity-config.js').NormalizedToolIdentityPolicy;
}

function isByteCloudTool(tool: TriggerUserAuthTool): boolean {
  return tool === 'bytedcli' || tool === 'larkdev';
}

/** Codebase/git is an optional companion. A second provider request failing
 * must not revoke the regional ByteCloud credentials already minted this turn. */
async function codebaseJwtFor(
  openId: string,
  cloudJwts: Partial<Record<ByteCloudUserSite, string>>,
): Promise<string | undefined> {
  const site = Object.keys(cloudJwts)[0] as ByteCloudUserSite | undefined;
  if (!site) return undefined;
  try { return (await mintBytedcliJwts(openId, site))?.codeJwt; }
  catch {
    logger.debug('[trigger-user-auth] Codebase companion unavailable; retaining regional ByteCloud identity');
    return undefined;
  }
}

async function larkCliHomeForExecution(
  sandbox: BotConfig['sandbox'],
  sessionDataDir: string,
  sessionId: string,
  openId: string,
): Promise<string | null> {
  const sandboxed = sandbox === true
    || sandbox === 'oncall'
    || sandbox === 'scratch';
  return sandboxed
    ? await materializeLarkCliHomeForSession(openId, sessionDataDir, sessionId)
    : await resolveLarkCliHomeForTurn(openId);
}

/**
 * Publish (or withhold) each governed tool's identity for the current turn.
 *
 * Never throws: a credential-publication failure must not take down the turn.
 * The worst case is a withheld identity, which the tool reports as an auth error
 * and the agent can act on.
 */
// ─── Publications in flight: a call that arrives mid-publication waits ───────
//
// A turn's identity is published asynchronously (a platform grant can take its
// whole budget). The opening turn of a new session is published again once the
// worker reports its identity model, and the CLI's first tool call can land in
// that window: it found nothing yet and was refused as if the person had no
// credentials, while the next message — published in time — worked.

/** Longest an identity fetch waits on a publication that is still running. */
export const PUBLICATION_WAIT_CAP_MS = 10_000;
const publicationsInFlight = new Map<string, Set<Promise<unknown>>>();
const publicationKey = (sessionDataDir: string, sessionId: string) => JSON.stringify([sessionDataDir, sessionId]);

/** Resolves when no publication for this session is running, or after `capMs`. Never throws. */
export async function awaitTurnIdentityPublication(
  sessionDataDir: string,
  sessionId: string,
  capMs = PUBLICATION_WAIT_CAP_MS,
): Promise<void> {
  const pending = publicationsInFlight.get(publicationKey(sessionDataDir, sessionId));
  if (!pending?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>(resolve => { timer = setTimeout(resolve, capMs); }),
  ]);
  clearTimeout(timer);
}

/** Mark `work` as a publication for this session until it settles. Callers
 *  whose publication starts after other async steps (the model-flip replay
 *  resolves the turn's sender first) register the whole chain up front. */
export function trackTurnIdentityPublication<T>(sessionDataDir: string, sessionId: string, work: Promise<T>): Promise<T> {
  const key = publicationKey(sessionDataDir, sessionId);
  let set = publicationsInFlight.get(key);
  if (!set) publicationsInFlight.set(key, set = new Set());
  set.add(work);
  const settle = () => {
    const current = publicationsInFlight.get(key);
    current?.delete(work);
    if (current && !current.size) publicationsInFlight.delete(key);
  };
  work.then(settle, settle);
  return work;
}

export function publishTurnCliIdentity(
  args: PublishTurnIdentityArgs,
): Promise<ToolIdentityOutcome[]> {
  return trackTurnIdentityPublication(args.sessionDataDir, args.sessionId, publishTurnCliIdentityNow(args));
}

async function publishTurnCliIdentityNow(
  args: PublishTurnIdentityArgs,
): Promise<ToolIdentityOutcome[]> {
  const { botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel } = args;
  const privateChat = args.privateChat === true;
  // The per-tool policy decision comes from the pure selector
  // (core/tool-identity-policy.ts) so admission, this publication, and the
  // managed binding route all answer "what may this tool run as this turn?"
  // from one place. This function only EXECUTES the decision against the
  // snapshot store: host/bound → touch nothing, managed → publish that one
  // principal, denied → publish the refusal.
  const identityPolicy = args.policy ?? normalizeToolIdentityPolicy(botConfig);
  const outcomes: ToolIdentityOutcome[] = [];
  // Record before the new-entry shortcut (and before first worker spawn).
  // The daemon has already verified the signed dispatch and target access.
  rememberLarkToolDelegation(sessionDataDir, sessionId, turnId, args.delegatedIdentity);
  // Anchor the published turn in the terminal-GC retention ledger for the whole
  // accept→queue→execute window. The worker's own queue marker is CLI-writable
  // and cannot serve as that anchor.
  if (turnId) registerActiveIdentityTurn(sessionDataDir, sessionId, turnId);

  for (const tool of TRIGGER_USER_AUTH_TOOLS) {
    const bindingInstalled = tool === 'lark-cli'
      && isLarkToolBound(botConfig, sessionDataDir, sessionId);
    const decision = selectToolCredential({
      larkAppId: botConfig.larkAppId,
      tool,
      authority: args.delegatedIdentity ? 'delegated' : args.decision?.authority ?? (args.tools ? 'automatic' : 'human'),
      policy: identityPolicy,
      ...(args.decision ? { turn: {
        user: args.decision.user, source: args.decision.source === 'sender' ? 'provenance' : args.decision.source,
        tools: args.decision.tools, failure: args.decision.failure,
      } } : args.tools ? { turn: { tools: args.tools, user: senderOpenId ? { openId: senderOpenId } : undefined, source: 'provenance' } } : {}),
      ...(senderOpenId ? { senderOpenId } : {}),
      ...(args.delegatedIdentity ? {
        delegatedGrant: {
          grantRef: turnId ?? sessionId,
          permitted: !args.delegatedIdentity.denialReason,
          tools: args.delegatedIdentity.tools,
        },
      } : {}),
      bindingInstalled,
    });
    if (decision.mode === 'bound_app') {
      outcomes.push({ tool, state: 'off' }); // the managed session entry resolves this itself
      continue;
    }
    // Automatic turns carry a frozen tool scope. Tools added to the bot policy
    // after admission stay out through the frozen baseline. Clear the prior
    // assignment material, then publish the tool's independent decision.
    const assignmentScope = args.decision?.tools ?? args.tools;
    if (assignmentScope && !assignmentScope.includes(tool)) {
      try { clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, storageModel); }
      catch { /* absence is the fail-closed state */ }
    }
    if (decision.mode === 'host') {
      // A session can keep sender-auth wrappers while its automatic opening
      // explicitly runs natively. Publish a turn-bound host record so an
      // installed wrapper can distinguish that choice from missing authority.
      if (args.decision?.authority === 'automatic' && args.decision.mode === 'host') {
        writeSessionIdentity(sessionDataDir, sessionId, { tool, mode: 'host', ...(turnId ? { turnId } : {}) }, storageModel);
      }
      outcomes.push({ tool, state: 'off' });
      continue;
    }
    try {
      if (decision.mode === 'denied') {
        outcomes.push(await withholdIdentity(
          tool, botConfig, sessionDataDir, sessionId, undefined, locale, turnId, storageModel, privateChat,
        ));
        continue;
      }
      if (decision.mode === 'delegated') {
        // publishDelegated owns the delegation-specific refusals (scope
        // exclusion, missing credentials) so the denial names the original
        // human and the dispatch root, not a generic login prompt.
        if (!args.delegatedIdentity) {
          outcomes.push(await withholdIdentity(
            tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, privateChat,
          ));
          continue;
        }
        outcomes.push(await publishDelegated(tool, args, args.delegatedIdentity, decision.credentialSource));
        continue;
      }
      // A managed decision whose principal is NOT the turn's sender (the
      // fixed bot user assignment) publishes THAT principal's credentials —
      // never accidentally the sender's, and never a mix of both.
      const managedPrincipal = decision.source === 'sender'
        ? senderOpenId
        : decision.user?.openId;
      outcomes.push(await publishOne(
        tool,
        botConfig,
        args.sessionSandbox ?? botConfig.sandbox,
        sessionDataDir,
        sessionId,
        managedPrincipal,
        locale,
        turnId,
        storageModel,
        decision.credentialSource,
        decision.user.unionId,
        privateChat,
      ));
    } catch (e) {
      // Fail closed through the SAME policy as an ordinary missing token, so a
      // credential-store outage and "this person never authorized" cannot end
      // up with different identities in force.
      logger.warn(
        `[trigger-user-auth] withheld ${tool} identity for session ${sessionId}: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
      if (decision.mode === 'managed_user' && decision.credentialSource === 'platform' && !isByteCloudTool(tool)) {
        writeDenial(sessionDataDir, sessionId, tool, decision.user.openId, botConfig, locale, turnId, storageModel,
          undefined, [t('trigger_user_auth.denied_platform_unavailable', { tool, provider: 'Lark' }, locale)],
          'provider_unavailable');
        outcomes.push({ tool, state: 'unavailable' });
        continue;
      }
      if (isByteCloudTool(tool)) {
        try {
          writeSessionIdentity(sessionDataDir, sessionId, {
            tool, mode: 'denied', ...(turnId ? { turnId } : {}),
            message: [
              locale === 'en'
                ? `botmux: ${tool} ByteCloud authorization service is unavailable. Stop automatic retries and repeated login requests; retry after the service recovers. Existing authorization is retained.`
                : `botmux: ${tool} 的 ByteCloud 授权服务暂时不可用。请停止自动重试和重复要求用户登录；服务恢复后再重试，已有授权会保留。`,
              reasonTag('provider_unavailable'),
            ].join('\n'),
          }, storageModel);
        } catch { clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, storageModel); }
        outcomes.push({ tool, state: 'unavailable' });
        continue;
      }
      outcomes.push(args.delegatedIdentity
        ? denyDelegated(tool, args, args.delegatedIdentity)
        : await withholdIdentity(
          tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, privateChat,
        ));
    }
  }
  return outcomes;
}

function denyDelegated(tool: TriggerUserAuthTool, args: PublishTurnIdentityArgs, user: DelegatedCliIdentity): ToolIdentityOutcome {
  const reason = user.denialReason === 'target_validation_unavailable'
    ? 'Target user or group membership verification is unavailable. Restore verification before retrying; logging in again will not fix this check.'
    : user.denialReason === 'target_access_denied'
      ? 'The requesting user could not be granted access to the target bot/chat. Check target access and group membership; do not request another login.'
      : user.denialReason === 'delegation_inactive'
        ? 'This workflow handoff is no longer active (its run attempt ended or the handoff was withdrawn), so the requester\'s identity no longer applies; do not request another login.'
        : user.denialReason === 'passed_on_unsupported'
          ? 'This workflow identity was passed on by another bot; it can only be used in a session that re-checks it on every call, and this session does not. Tools that need the person\'s authorization refuse here; do not request another login.'
          : 'The source must ask the original human to authorize.';
  try {
    writeSessionIdentity(args.sessionDataDir, args.sessionId, {
      tool, mode: 'denied', ...(args.turnId ? { turnId: args.turnId } : {}),
      message: `botmux: delegated ${tool} execution refused for the requesting user. `
        + `Report this blocker with botmux report --dispatch-root ${user.dispatchRoot}; `
        + reason + ' Do not ask a bot to log in or use another identity.',
    }, args.storageModel);
  } catch {
    clearSessionIdentity(args.sessionDataDir, args.sessionId, tool, args.turnId, args.storageModel);
  }
  return { tool, state: 'needs-authorization' };
}

async function publishDelegated(tool: TriggerUserAuthTool, args: PublishTurnIdentityArgs, user: DelegatedCliIdentity, source: TriggerUserAuthCredentialSource): Promise<ToolIdentityOutcome> {
  if (!user.tools.includes(tool)) return denyDelegated(tool, args, user);
  let identity: CliIdentity | null = null;
  // Platform first, keyed by the union_id in the verified dispatch record. The
  // issuer-scoped credentialOpenId means nothing to this bot's app, and
  // re-deriving the union_id from targetOpenId would hang the grant on a
  // contact lookup that need not be reachable. In strict `platform` mode a
  // non-grant is final and local stores are never read; in `auto` an
  // already-provisioned local HOME is still honoured below.
  if (source !== 'local') {
    const platform = await resolvePlatformIdentity({
      botConfig: args.botConfig, tool, unionId: user.unionId,
      sessionId: args.sessionId, ...(args.turnId ? { turnId: args.turnId } : {}),
    });
    if (platform.state === 'granted') identity = platform.identity;
    else if (source === 'platform') return denyDelegated(tool, args, user);
  }
  let localMint = false;
  if (!identity && tool === 'bytedcli') {
    // Keep the issuer-scoped credential key; do not copy a source open_id into
    // the target app or duplicate/extend the lifetime of the user's login.
    const cloudJwts = await mintByteCloudUserJwts(user.credentialOpenId);
    if (cloudJwts) {
      const codeJwt = await codebaseJwtFor(user.credentialOpenId, cloudJwts);
      identity = { tool, cloudJwts, ...(codeJwt ? { codeJwt } : {}) };
      localMint = true;
    }
  } else if (!identity && tool === 'lark-cli') {
    const home = await larkCliHomeForExecution(
      args.sessionSandbox ?? args.botConfig.sandbox,
      args.sessionDataDir,
      args.sessionId,
      user.credentialOpenId,
    );
    if (home) identity = { tool, mode: 'user-home', home };
    // No bot-app OAuth fallback. Delegation may carry the original human's
    // personal lark-cli HOME, but it must never turn a receiving Bot's shared
    // app into that person's OAuth client.
  } else if (!identity && tool === 'larkdev') {
    const cloudJwts = await mintByteCloudUserJwts(user.credentialOpenId);
    if (cloudJwts) identity = { tool, cloudJwts };
  }
  if (!identity) return denyDelegated(tool, args, user);
  const stamped = {
    ...identity,
    ...(args.turnId ? { turnId: args.turnId } : {}),
    ...(user.targetOpenId ? { openId: user.targetOpenId } : {}),
  };
  writeSessionIdentity(args.sessionDataDir, args.sessionId, stamped, args.storageModel);
  if (localMint && args.turnId && args.storageModel === 'proven' && stamped.tool === 'bytedcli' && !('mode' in stamped)) {
    trackBytedcliIdentityRenewal({
      sessionDataDir: args.sessionDataDir, sessionId: args.sessionId,
      credentialOpenId: user.credentialOpenId, identity: { ...stamped, turnId: args.turnId },
    });
  }
  return { tool, state: 'user' };
}

async function publishOne(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionSandbox: BotConfig['sandbox'],
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string | undefined,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  source: TriggerUserAuthCredentialSource,
  unionId?: string,
  privateChat = false,
): Promise<ToolIdentityOutcome> {
  const withheld = async () =>
    withholdIdentity(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, privateChat);

  // No human sender (scheduled run, hook, meeting event, bot-to-bot handoff):
  // there is no "trigger user" to act as. Withhold — never reach for the session
  // creator's or the owner's credentials to fill the gap.
  if (!senderOpenId) return await withheld();

  const publish = (identity: CliIdentity, localMint = false): ToolIdentityOutcome => {
    const stamped = { ...identity, ...(turnId ? { turnId } : {}), openId: senderOpenId };
    writeSessionIdentity(sessionDataDir, sessionId, stamped, storageModel);
    if (localMint && turnId && storageModel === 'proven' && stamped.tool === 'bytedcli' && !('mode' in stamped)) {
      trackBytedcliIdentityRenewal({
        sessionDataDir, sessionId, credentialOpenId: senderOpenId, identity: { ...stamped, turnId },
      });
    }
    return { tool, state: 'user' };
  };

  // Credential source matrix (docs/lark-tool-identity.md, 凭据来源):
  //   local            → this machine's per-person HOME only (below).
  //   auto, unbound    → same as local, including auto-starting a local login.
  //   auto, bound      → platform grant; else an EXISTING local HOME; else a
  //                      refusal that points at the platform. A bound machine
  //                      never starts a new local login on its own.
  //   platform         → platform grant or refusal; local is never consulted.
  if (source !== 'local') {
    const platform = await resolvePlatformIdentity({
      botConfig, tool, ...(unionId ? { unionId } : { openId: senderOpenId }), sessionId, ...(turnId ? { turnId } : {}),
    });
    if (platform.state === 'granted') return publish(platform.identity);
    if (source === 'platform' || platform.state !== 'unbound') {
      if (source === 'auto') {
        const local = await resolveIdentityFor(tool, botConfig, sessionSandbox, sessionDataDir, sessionId, senderOpenId);
        if (local) return publish(local, tool === 'bytedcli');
      }
      // Proven model only: the wrapper asks the daemon on every invocation, so
      // a transient refusal can be re-asked there (see retryTransientTurnIdentity).
      const retryable = platform.state === 'unavailable' && !!turnId && storageModel === 'proven';
      const outcome = refuseViaPlatform(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId, storageModel, platform, retryable);
      if (retryable) {
        rememberTransientRefusal({ botConfig, tool, sessionDataDir, sessionId, senderOpenId, locale, turnId: turnId! });
      }
      return outcome;
    }
  }

  const identity = await resolveIdentityFor(tool, botConfig, sessionSandbox, sessionDataDir, sessionId, senderOpenId);
  if (!identity) return await withheld();
  return publish(identity, true);
}

// ─── Transient platform refusals: give the turn's next call another chance ───
//
// A grant is fetched once when the turn is prepared. If the platform could not
// be reached at that moment, the refusal published for the turn used to stand
// for the whole turn, so one network blip spoiled every bytedcli / lark-cli
// call the turn made. For the proven model (the wrapper asks the daemon for
// each invocation) the daemon instead re-asks the platform when the wrapper
// next fetches that refusal — rate-limited, and only while the refusal it
// published is still what is in force (compare-and-set right before writing,
// so a newer publication or a revocation is never overwritten).
//
// Only `unavailable` qualifies: an HTTP answer about the person (not
// authorized, no consent, not a teammate, forbidden) is final for the turn.

/** Minimum spacing between re-asks for one turn/tool. The FIRST re-ask is not
 *  spaced: preparing the turn already waited out a full grant budget, and the
 *  agent's first tool call is usually the only one before it gives up. */
export const TRANSIENT_REFUSAL_RETRY_INTERVAL_MS = 10_000;
/** Longest a wrapper's identity fetch waits on a re-ask. Stays well inside the
 *  wrapper's own 20s IPC timeout (a contact lookup plus a grant can exceed it);
 *  past this the current refusal is served and the attempt finishes in the
 *  background for the next call. */
export const TRANSIENT_REFUSAL_WAIT_CAP_MS = 10_000;
/** Re-asks per turn/tool; an agent stuck in a retry loop cannot hammer the platform. */
export const TRANSIENT_REFUSAL_MAX_RETRIES = 5;
/** Forget an entry after this long even if its turn's material is still held. */
const TRANSIENT_REFUSAL_TTL_MS = 2 * 60 * 60 * 1000;
const TRANSIENT_REFUSAL_MAX_ENTRIES = 1000;

interface TransientRefusal {
  botConfig: BotConfig;
  tool: TriggerUserAuthTool;
  sessionDataDir: string;
  sessionId: string;
  senderOpenId: string;
  locale: Locale | undefined;
  turnId: string;
  /** The refusal body this module published; the CAS token. */
  body: string;
  /** The person's local credential epoch when the refusal was published; a
   *  revocation (`/logout`, Dashboard revoke) bumps it and ends the re-asks. */
  authEpoch: number;
  createdAt: number;
  lastAttemptAt: number;
  retries: number;
  inFlight?: Promise<void>;
}

const transientRefusals = new Map<string, TransientRefusal>();

function transientKey(sessionDataDir: string, sessionId: string, turnId: string, tool: TriggerUserAuthTool): string {
  return JSON.stringify([sessionDataDir, sessionId, turnId, tool]);
}

function rememberTransientRefusal(entry: Omit<TransientRefusal, 'body' | 'authEpoch' | 'createdAt' | 'lastAttemptAt' | 'retries'>): void {
  const body = recallProvenIdentityContent(entry.sessionDataDir, entry.sessionId, entry.turnId, entry.tool);
  if (!body) return; // the refusal did not land; nothing to compare against
  const now = Date.now();
  const key = transientKey(entry.sessionDataDir, entry.sessionId, entry.turnId, entry.tool);
  transientRefusals.delete(key);
  transientRefusals.set(key, {
    ...entry, body, authEpoch: readCliAuthEpoch(entry.senderOpenId),
    createdAt: now, lastAttemptAt: Number.NEGATIVE_INFINITY, retries: 0,
  });
  while (transientRefusals.size > TRANSIENT_REFUSAL_MAX_ENTRIES) {
    const oldest = transientRefusals.keys().next().value;
    if (oldest === undefined) break;
    transientRefusals.delete(oldest);
  }
}

/**
 * Called by the proven identity route before it serves a turn's identity. When
 * what is in force is a transient platform refusal this module published, ask
 * the platform again (the first time right away, then at most once per
 * {@link TRANSIENT_REFUSAL_RETRY_INTERVAL_MS}) and publish the answer if the
 * refusal is still the one in force. Concurrent callers share one attempt; no
 * caller waits longer than {@link TRANSIENT_REFUSAL_WAIT_CAP_MS}. Never throws.
 *
 * `currentPolicy` — not `botConfig` — is what decides whether a re-ask may run
 * and whether its answer may be written: a bot policy changed mid-turn (tool no
 * longer governed, source switched to local) ends the re-asks instead of
 * publishing under the policy the turn started with. `botConfig` is only the
 * fallback for a caller with no registry reader.
 */
export async function retryTransientTurnIdentity(args: {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  tool: TriggerUserAuthTool;
  botConfig?: BotConfig;
  /** Reads the LIVE policy for this bot. Must be supplied by whoever holds the
   *  bot registry: a mid-turn Dashboard edit replaces the whole config object,
   *  so any snapshot (including `botConfig`) stays stale and would let an
   *  in-flight attempt publish under a policy the operator already left. */
  currentPolicy?: () => TriggerUserAuthConfig | undefined;
}): Promise<void> {
  const key = transientKey(args.sessionDataDir, args.sessionId, args.turnId, args.tool);
  const entry = transientRefusals.get(key);
  if (!entry) return;
  if (!entry.inFlight) {
    const now = Date.now();
    if (!stillInForce(entry)
      || now - entry.createdAt > TRANSIENT_REFUSAL_TTL_MS
      || entry.retries >= TRANSIENT_REFUSAL_MAX_RETRIES
      || !policyStillWants(args.currentPolicy, entry, args.botConfig)) {
      transientRefusals.delete(key);
      return;
    }
    if (now - entry.lastAttemptAt < TRANSIENT_REFUSAL_RETRY_INTERVAL_MS) return;
    entry.lastAttemptAt = now;
    entry.retries++;
    entry.inFlight = runTransientRetry(key, entry, args.currentPolicy, args.botConfig)
      .finally(() => { entry.inFlight = undefined; });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    entry.inFlight,
    new Promise<void>(resolve => { timer = setTimeout(resolve, TRANSIENT_REFUSAL_WAIT_CAP_MS); }),
  ]);
  clearTimeout(timer);
}

/** The refusal this entry published is still what the turn has, and the
 *  person has not revoked their credentials since. */
function stillInForce(entry: TransientRefusal): boolean {
  return recallProvenIdentityContent(entry.sessionDataDir, entry.sessionId, entry.turnId, entry.tool) === entry.body
    && readCliAuthEpoch(entry.senderOpenId) === entry.authEpoch;
}

/** Does the bot's policy — read NOW, not when the refusal was published — still
 *  take this tool's credentials from the platform?
 *
 *  Dashboard writes replace the whole bot config object
 *  (`bots.set(appId, { config: cfg, … })`), so a snapshot taken at publication
 *  time (the entry's `botConfig`) can never observe a mid-turn edit: only a
 *  reader supplied by whoever holds the registry can.
 *
 *  A reader that throws means the bot is gone; that is "no longer governed", so
 *  the re-ask stops rather than publishing under a policy nobody stated. */
function policyStillWants(
  live: (() => TriggerUserAuthConfig | undefined) | undefined,
  entry: TransientRefusal,
  fallbackConfig: BotConfig | undefined,
): boolean {
  let policy: TriggerUserAuthConfig | undefined;
  if (live) {
    try { policy = live(); } catch { return false; }
  } else {
    policy = (fallbackConfig ?? entry.botConfig).triggerUserAuth;
  }
  return triggerUserAuthApplies(policy, entry.tool) && credentialSourceOf(policy) !== 'local';
}

async function runTransientRetry(
  key: string,
  entry: TransientRefusal,
  live: (() => TriggerUserAuthConfig | undefined) | undefined,
  fallbackConfig: BotConfig | undefined,
): Promise<void> {
  // Only ever drop THIS entry: a republication of the same turn registers a
  // fresh one under the same key, which an older attempt must not erase.
  const drop = () => { if (transientRefusals.get(key) === entry) transientRefusals.delete(key); };
  try {
    const platform = await resolvePlatformIdentity({
      botConfig: entry.botConfig, tool: entry.tool, openId: entry.senderOpenId,
      sessionId: entry.sessionId, turnId: entry.turnId,
    });
    // Compare-and-set: synchronous from here to the write. The policy check
    // belongs INSIDE this window: the attempt took a whole grant budget, and an
    // operator switching this bot to local credentials (or turning the tool off)
    // during it must not end with platform credentials on disk.
    if (transientRefusals.get(key) !== entry
      || !stillInForce(entry)
      || !policyStillWants(live, entry, fallbackConfig)) {
      drop();
      return;
    }
    if (platform.state === 'granted') {
      writeSessionIdentity(entry.sessionDataDir, entry.sessionId,
        { ...platform.identity, turnId: entry.turnId, openId: entry.senderOpenId }, 'proven');
      drop();
      logger.info(`[trigger-user-auth] platform ${entry.tool} grant recovered for session ${entry.sessionId} on retry`);
      return;
    }
    if (platform.state === 'unavailable') return; // keep the refusal; retry later
    if (platform.state === 'unbound') {
      // Unbound mid-turn: what applies now depends on the source (auto falls
      // back to local logins) and is the next turn's decision. Keep the
      // refusal the turn has; stop asking a platform that is gone.
      drop();
      return;
    }
    // The platform now answered about the person: publish that answer, final.
    refuseViaPlatform(entry.tool, entry.botConfig, entry.sessionDataDir, entry.sessionId, entry.senderOpenId,
      entry.locale, entry.turnId, 'proven', platform);
    drop();
  } catch (e) {
    logger.warn(`[trigger-user-auth] retry of ${entry.tool} identity failed for session ${entry.sessionId}: `
      + `${e instanceof Error ? e.message : String(e)}`);
  }
}

/** @internal test-only */
export function __resetTransientRefusalsForTest(): void {
  transientRefusals.clear();
}

/**
 * The refusal a bound machine publishes: it names the platform, not a local
 * device login, as the way to authorize. `unavailable` is reported as such so
 * the agent stops retrying instead of asking the person to authorize again.
 */
function refuseViaPlatform(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  platform: Exclude<PlatformIdentityResolution, { state: 'granted' }>,
  /** The daemon will re-ask on the turn's next call (proven model). */
  retryable = false,
): ToolIdentityOutcome {
  const provider = isByteCloudTool(tool) ? 'ByteCloud' : t('trigger_user_auth.provider_lark', undefined, locale);
  const vars = { tool, provider };
  let tail: string[];
  let state: ToolIdentityOutcome['state'] = 'needs-authorization';
  switch (platform.state) {
    case 'unbound':
      tail = [t('trigger_user_auth.denied_platform_unbound', vars, locale)];
      break;
    case 'not_authorized': {
      const url = platform.authorizeUrl ?? platformAuthorizeUrl();
      tail = [
        t(platform.consent ? 'trigger_user_auth.denied_platform_consent' : 'trigger_user_auth.denied_platform_login', vars, locale),
        ...(url ? [url] : []),
        t('trigger_user_auth.denied_platform_retry', undefined, locale),
      ];
      break;
    }
    case 'denied':
      tail = [platform.reason === 'not_teammate'
        ? t('trigger_user_auth.denied_platform_not_teammate', vars, locale)
        : t('trigger_user_auth.denied_platform_forbidden', { ...vars, detail: platform.detail }, locale)];
      break;
    case 'unavailable':
      tail = [t(retryable
        ? 'trigger_user_auth.denied_platform_unavailable_retryable'
        : 'trigger_user_auth.denied_platform_unavailable', vars, locale)];
      state = 'unavailable';
      break;
  }
  writeDenial(sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId, storageModel, undefined, tail,
    platformRefusalReason(platform));
  return { tool, state };
}

/**
 * What "no usable credentials for this turn's sender" resolves to.
 *
 * The one place that decision is made, so every route into it — no sender, no
 * token, a store outage — lands on the same identity.
 *
 * Neither outcome can be expressed by deleting the file. The wrapper reads an
 * absent file as a refusal, so running as the bot has to be published
 * explicitly (with app id + secret; lark-cli given nothing picks up the
 * operator's on-disk login instead). And a refusal is published too, because it
 * carries the text the refused person reads.
 */
async function withholdIdentity(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string | undefined,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  privateChat: boolean,
): Promise<ToolIdentityOutcome> {
  // A device authorization URL is bearer-adjacent and must never be relayed in
  // a group. The explicit /login command sends its response privately.
  if (!privateChat) {
    writeDenial(
      sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId,
      storageModel, undefined, undefined, senderOpenId ? 'not_authorized' : 'no_sender',
    );
    return { tool, state: 'needs-authorization' };
  }
  // Pre-fetch a ready lark-cli authorization link so the moment that tool is
  // refused, the agent has a link to relay instead of asking the person to type
  // a command. ByteCloud cannot do this safely: the turn has not selected a
  // site yet, so its refusal names the explicit site-bearing login command.
  let login: LarkCliLoginChallenge | undefined;
  if (senderOpenId) {
    try {
      if (!isByteCloudTool(tool)) {
        const brand = normalizeBrand(botConfig.brand);
        login = await (brand === 'lark'
          ? beginLarkCliLogin(senderOpenId, [], brand)
          : beginLarkCliLogin(senderOpenId)) ?? undefined;
      }
    } catch (e) {
      if (isByteCloudTool(tool)) throw e;
      logger.warn(
        `[trigger-user-auth] could not pre-fetch ${tool} auth link for session ${sessionId}: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  writeDenial(
    sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId,
    storageModel, login, undefined, senderOpenId ? 'not_authorized' : 'no_sender',
  );
  return { tool, state: 'needs-authorization' };
}

/**
 * Publish a refusal the wrapper prints verbatim on stderr.
 *
 * Names the person whose authorization is missing when we know it, and always
 * says how to supply it. Without the "how", someone whose command just failed
 * has no way to discover that /login is the answer — they retry, fail again,
 * and conclude the bot is broken.
 *
 * Best-effort by construction: if this write fails the file stays absent, which
 * the wrapper also reads as a denial. Safety does not depend on it landing —
 * only the quality of the message does.
 */
function writeDenial(
  sessionDataDir: string,
  sessionId: string,
  tool: TriggerUserAuthTool,
  senderOpenId: string | undefined,
  botConfig: BotConfig,
  locale: Locale | undefined,
  turnId: string | undefined,
  storageModel: IdentityStorageModel,
  login?: LarkCliLoginChallenge,
  /** Replaces the local-login tail (auto-link or /login how-to) when the
   *  authorization lives elsewhere — e.g. on the central platform. */
  tailOverride?: string[],
  /** Machine-readable cause, printed as the last line (`[reason=…]`). */
  reason?: string,
): void {
  try {
    const name = senderOpenId && botConfig.larkAppId
      // Brand matters: the lookup checks it, so a Lark-brand bot with the
      // default 'feishu' finds nothing and the refusal loses the person's name.
      ? lookupAuthorizedUserName(botConfig.larkAppId, senderOpenId, normalizeBrand(botConfig.brand))
      : undefined;
    // Name the right provider. bytedcli authenticates against ByteCloud, so
    // saying "Feishu authorization" would send the reader to authorize the
    // wrong thing — the same mistake as naming the wrong /login command.
    const provider = isByteCloudTool(tool)
      ? 'ByteCloud'
      : t('trigger_user_auth.provider_lark', undefined, locale);
    // With no name, address the reader directly rather than printing a raw
    // open_id at them. The name comes from a stored Lark token, which someone
    // being refused for lack of authorization usually does not have — so the
    // nameless case is the COMMON one here, not an edge case, and `「ou_5f3a…」
    // 本人` reads as a machine talking to itself.
    const head = !senderOpenId
      ? t('trigger_user_auth.denied_anonymous', { tool, provider }, locale)
      : name
        ? t('trigger_user_auth.denied_known_user', { name, tool, provider }, locale)
        : t('trigger_user_auth.denied_you', { tool, provider }, locale);
    writeSessionIdentity(sessionDataDir, sessionId, {
      tool,
      mode: 'denied',
      ...(turnId ? { turnId } : {}),
      message: [
        head,
        // A ready device-code link for either tool: lead with the self-serve,
        // one-tap instruction and a clear "authorize once" framing so it reads
        // as "one step left", not as a broken bot. Without a link (fetch failed
        // or no human sender), fall back to the /login instructions.
        ...(tailOverride ? tailOverride : login
          ? [
              t(
                login.stage === 'app-setup'
                  ? 'trigger_user_auth.denied_personal_app_setup'
                  : 'trigger_user_auth.denied_auto_login',
                { tool, provider },
                locale,
              ),
              login.authUrl,
              t(
                login.stage === 'app-setup'
                  ? 'trigger_user_auth.denied_personal_app_retry'
                  : 'trigger_user_auth.denied_auto_retry',
                undefined,
                locale,
              ),
            ]
          : [t(
              'trigger_user_auth.denied_howto',
              { command: isByteCloudTool(tool) ? '/login bytedcli <site>' : '/login' },
              locale,
            ),
            t(
              isByteCloudTool(tool)
                ? 'trigger_user_auth.denied_howto_status_bytedcli'
                : 'trigger_user_auth.denied_howto_status',
              undefined,
              locale,
            )]),
        ...(reason ? [reasonTag(reason)] : []),
      ].join('\n'),
    }, storageModel);
  } catch (e) {
    clearSessionIdentity(sessionDataDir, sessionId, tool, turnId, storageModel);
    logger.debug(
      `[trigger-user-auth] could not publish the ${tool} denial (absent file denies too): `
      + `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function resolveIdentityFor(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionSandbox: BotConfig['sandbox'],
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string,
): Promise<CliIdentity | null> {
  if (tool === 'lark-cli') {
    // Preferred path: the per-person HOME created by the lark-cli device-code
    // flow. lark-cli then acts as that person using the provisioned app bound
    // inside that HOME — no token is injected into the environment, and the
    // acting identity is a directory isolated per sender (mirrors bytedcli).
    // No appId is passed: the HOME's own lark-cli config already names the app.
    //
    // The resolver polls a pending device login once before deciding: a browser
    // approval writes nothing locally, so without that poll "tap the link, then
    // retry" could never succeed on the turn path.
    const home = await larkCliHomeForExecution(
      sessionSandbox,
      sessionDataDir,
      sessionId,
      senderOpenId,
    );
    if (home) {
      return { tool: 'lark-cli', mode: 'user-home', home };
    }
    // Strict boundary: trigger-user lark-cli accepts only the sender's personal
    // app + login HOME. A bot-app token is per-user but still shares one OAuth
    // application, which is the identity escape this mode must prevent.
    return null;
  }

  if (tool === 'larkdev') {
    // larkdev uses the same ByteCloud person as bytedcli, but receives
    // site-specific short-lived JWTs. Its wrapper points LARKDEV_AUTH_DIR at a
    // fresh directory, so an unavailable region cannot fall back to the
    // operator's ~/.larkdev/auth state.
    const cloudJwts = await mintByteCloudUserJwts(senderOpenId);
    return cloudJwts ? { tool: 'larkdev', cloudJwts } : null;
  }

  // bytedcli authenticates against ByteCloud SSO, a different provider from
  // Lark OAuth — a Lark user token is not convertible into a ByteCloud JWT. Mint
  // this person's real ByteCloud SDK JWT inputs for every supported site. The
  // wrapper runs the real bytedcli in an empty HOME, so a missing regional JWT
  // fails closed instead of falling back to the operator's persistent login.
  //
  // Null when they have not authorized (or their login has ended), which the
  // caller turns into the ordinary "authorize, then retry" refusal rather than
  // falling back to the machine's own SSO session.
  const cloudJwts = await mintByteCloudUserJwts(senderOpenId);
  if (!cloudJwts) return null;
  const codeJwt = await codebaseJwtFor(senderOpenId, cloudJwts);
  return { tool: 'bytedcli', cloudJwts, ...(codeJwt ? { codeJwt } : {}) };
}
