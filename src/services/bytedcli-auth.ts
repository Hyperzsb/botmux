/**
 * Per-person `bytedcli` authorization.
 *
 * ## Why this is not the Lark token store
 *
 * `bytedcli` authenticates against ByteCloud SSO — a different identity
 * provider from Lark OAuth, with no conversion between them. A person who has
 * run `/login` for Feishu is still unauthorized here, and vice versa. So they
 * authorize twice; that is a property of the two providers, not something
 * botmux can paper over.
 *
 * ## Why we store a HOME directory instead of a token
 *
 * `bytedcli` keeps its auth state under `$HOME/.local/share/bytedcli`, resolved
 * through `os.homedir()` at call time. Measured: with `HOME` pointed at an
 * empty directory, `bytedcli auth status` reports `not logged in` even while
 * the real user is logged in on the same machine. That makes `HOME` a genuine
 * isolation boundary — one directory per person, and neither the machine's own
 * login nor anyone else's is touched.
 *
 * The alternative — capturing the ByteCloud JWT at login and storing it — looks
 * simpler and is wrong. That JWT lives 2 hours, while the login behind it lives
 * about 3 weeks (a refresh token). Storing the JWT would make everyone re-scan
 * a QR code every 2 hours to renew something that had not actually expired.
 * Keeping the directory lets `bytedcli` mint a fresh JWT per call and refresh
 * it internally; a person is only interrupted when the 3-week login really ends.
 *
 * Credentials originate in that private HOME; short-lived in-memory token
 * caches are cleared on logout and used only after a fresh personal-login check.
 * The module shells out with `HOME` set to it. Login callers name the intended
 * site; after the person opens that site's device-flow link, only that saved
 * site challenge can be completed before minting its JWT.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  BYTECLOUD_USER_SITES,
  type ByteCloudUserSite,
} from '../utils/bytecloud-sites.js';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';
import {
  scrubCredentialLikeEnv,
  scrubSessionTurnMarkerEnv,
} from '../utils/child-env.js';
import { cliAuthEpochAllows, readCliAuthEpoch, stampCliAuthEpoch } from './cli-auth-epoch.js';

/** Root under which each authorized person gets their own bytedcli HOME. */
import { BYTEDCLI_HOME_ROOT } from './bytedcli-home.js';

/** How long to wait on a `bytedcli` invocation. The device-code calls talk to
 *  ByteCloud, so they are network-bound; the JWT reads are usually local but
 *  may refresh. Generous enough not to fail a slow network, short enough that a
 *  wedged CLI cannot hold a turn open. */
const BYTEDCLI_TIMEOUT_MS = 30_000;

/** ByteCloud gives a device-code challenge about an hour; expire ours a little
 *  sooner so we never hand back a token that is about to be refused. */
const CHALLENGE_TTL_MS = 50 * 60_000;

/**
 * This person's private bytedcli HOME.
 *
 * Keyed by open_id, so two people on one bot never share auth state — the same
 * property the per-person Lark token files give, by the same reasoning.
 */
export function bytedcliHomeFor(openId: string): string {
  if (!isUsableOpenId(openId)) {
    // The value is concatenated into a filesystem path, so a `../`-shaped id
    // must not be able to redirect it at somebody else's directory.
    throw new Error(`[bytedcli-auth] unusable open_id: ${JSON.stringify(openId)}`);
  }
  return join(BYTEDCLI_HOME_ROOT, openId);
}

/** Ask the credential provider whether this person's isolated login is usable.
 * Storage layout belongs to bytedcli/its SDK, not Botmux. A directory or a
 * legacy token filename is neither necessary nor sufficient authorization. */
class BytedcliAuthUnavailableError extends Error {
  constructor(operation: string) {
    super(`bytedcli authorization service unavailable (${operation}); retry after the service recovers, without starting another login`);
    this.name = 'BytedcliAuthUnavailableError';
  }
}

interface LoginObservation {
  authenticated: boolean;
  /** Provider-reported login expiry, when `auth status` includes one. */
  expiresAt?: string;
  /** Which login is in force: the account it names plus that login's own
   *  expiry marks. A re-login, a refresh or another account in the same HOME
   *  changes it. Absent when the status names no account; nothing is reused
   *  across turns then. */
  fingerprint?: string;
}

async function readLoginState(
  openId: string,
  site: ByteCloudUserSite = 'cn',
): Promise<LoginObservation> {
  const home = bytedcliHomeFor(openId);
  if (!existsSync(home)) return { authenticated: false };
  // A HOME rewritten after revoke has no matching stamp. Do not ask the CLI —
  // its own session files are not authority once the epoch has moved.
  if (!cliAuthEpochAllows(openId, home)) return { authenticated: false };
  const result = await runAsUser(openId, ['--site', site, 'auth', 'status', '--json']);
  const envelope = parseEnvelope(result.stdout);
  const data = envelope?.data as Record<string, unknown> | undefined;
  if (!result.ok || envelope?.status !== 'success' || typeof data?.authenticated !== 'boolean') {
    throw new BytedcliAuthUnavailableError('status');
  }
  const sdk = data.bytecloud_auth as Record<string, unknown> | undefined;
  if (data.auth_as === 'app' || sdk?.authType === 'app') {
    throw new BytedcliAuthUnavailableError('unexpected app identity');
  }
  if (!data.authenticated && sdk?.status && sdk.status !== 'need_login') {
    throw new BytedcliAuthUnavailableError('provider not ready');
  }
  const expiresAt = providerExpiry(data, sdk);
  const fingerprint = data.authenticated ? loginFingerprint(data, sdk) : undefined;
  return {
    authenticated: data.authenticated,
    ...(expiresAt ? { expiresAt } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/** See {@link LoginObservation.fingerprint}. Only identity and expiry fields
 *  are read; credential fields in the same payload are ignored. */
function loginFingerprint(
  data: Record<string, unknown>,
  sdk: Record<string, unknown> | undefined,
): string | undefined {
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number') ? String(v) : '';
  const identity = (sdk?.identity ?? null) as Record<string, unknown> | null;
  const account = [text(identity?.username), text(identity?.email)];
  if (!account.some(Boolean)) return undefined;
  const marks = [sdk?.expiresAt, sdk?.expires_at, sdk?.refreshTokenExpiresAt, data.token_expires_at, data.login_expires_at].map(text);
  if (!marks.some(Boolean)) return undefined;
  return JSON.stringify([text(sdk?.site), text(sdk?.authSource), ...account, ...marks]);
}

/** ISO expiry from the status payload. Only the named expiry fields are read;
 *  JWTs and other credential fields in the same object are ignored. */
function providerExpiry(
  data: Record<string, unknown>,
  sdk: Record<string, unknown> | undefined,
): string | undefined {
  for (const source of sdk ? [sdk, data] : [data]) {
    for (const key of ['expires_at', 'expiresAt'] as const) {
      const iso = isoTimestamp(source[key]);
      if (iso) return iso;
    }
  }
  return undefined;
}

/** ECMAScript time values outside ±8.64e15 ms make `Date#toISOString` throw. */
const MAX_DATE_MS = 8.64e15;

function isoFromMs(ms: number): string | undefined {
  // A provider clock (for example a nanosecond Unix time) must not be able to
  // throw out of a status read. Login state is independent of that field.
  if (!Number.isFinite(ms) || ms < 1_000_000_000_000 || ms > MAX_DATE_MS) return undefined;
  return new Date(ms).toISOString();
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return isoFromMs(ms);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  return isoFromMs(Date.parse(trimmed));
}

export async function hasBytedcliHome(
  openId: string,
  site: ByteCloudUserSite = 'cn',
): Promise<boolean> {
  return (await readLoginState(openId, site)).authenticated;
}

/**
 * This person's bytedcli login, for a status query.
 *
 * Does not start a login and does not create a HOME. `unknown` means the
 * provider could not be asked (down, malformed, or a non-personal identity);
 * an existing login is left untouched. No credential material is returned.
 */
export async function describeBytedcliAuth(openId: string): Promise<{
  state: 'authorized' | 'needs-login' | 'unknown';
  expiresAt?: string;
}> {
  try {
    const login = await readLoginState(openId, 'cn');
    return {
      state: login.authenticated ? 'authorized' : 'needs-login',
      ...(login.expiresAt ? { expiresAt: login.expiresAt } : {}),
    };
  } catch {
    return { state: 'unknown' };
  }
}

/** Forget one person's bytedcli authorization entirely.
 * Precondition: persist bumpCliAuthEpoch(openId) BEFORE logout or this cleanup.
 * The durable epoch fences stale SDK writers in every daemon; clearing local
 * dedup maps does not stop an already-running child from recreating the HOME.
 */
export function clearBytedcliAuth(openId: string): void {
  deleteCredentialSiteEntries(beginnings, openId);
  authEpochs.set(openId, authEpoch(openId) + 1);
  deleteCredentialSiteEntries(minting, openId);
  deleteCredentialSiteEntries(renewing, openId);
  allSiteMinting.delete(openId);
  forgetCachedJwts(openId);
  try { rmSync(bytedcliHomeFor(openId), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

/**
 * Ask bytedcli to revoke this person's server-side login, if a HOME already
 * exists. Never creates the directory: `runAsUser` would mkdir, and a logout
 * of someone who never logged in must not leave an empty HOME behind.
 * A missing binary or a non-zero exit is a failed attempt, not an exception —
 * the caller still deletes the local HOME.
 */
export async function logoutBytedcli(openId: string): Promise<boolean> {
  try {
    if (!isUsableOpenId(openId) || !existsSync(bytedcliHomeFor(openId))) return false;
    const result = await runAsUser(openId, ['auth', 'logout', '--json']);
    return result.ok;
  } catch {
    return false;
  }
}

export interface BytedcliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `bytedcli` as one person.
 *
 * Keep transport settings, but remove session wrappers and caller credentials.
 * The provider must read only this person's isolated HOME.
 */
async function runAsUser(openId: string, args: string[]): Promise<BytedcliResult> {
  const home = bytedcliHomeFor(openId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  scrubSessionTurnMarkerEnv(env);
  // bytedcli subcommands accept ByteCloud JWTs/AK/SKs as well as many
  // domain-specific tokens, cookies and passwords. Leaving any ambient
  // credential in place could silently act as the daemon/operator instead of
  // this sender even though HOME itself is isolated.
  scrubCredentialLikeEnv(env);
  for (const key of [
    'BYTEDCLI_PROFILE', 'BYTEDCLI_CODEBASE_APP_ID', 'BYTEDCLI_CODEBASE_APP_SECRET',
    'BYTEDCLI_CLOUD_SITE', 'BYTEDCLI_AUTH_SITE',
    'AIME_WORKSPACE_PATH', 'AIME_CURRENT_USER',
  ]) delete env[key];
  Object.assign(env, { HOME: home, BYTECLOUD_AUTH_AS: 'user', BYTEDCLI_NO_AUTO_UPGRADE: '1' });
  return await new Promise<BytedcliResult>(resolve => {
    const child = spawn('bytedcli', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      stderr += '\n[bytedcli-auth] timed out';
      // A descendant can retain the pipes after the CLI exits; do not wait for close.
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    }, BYTEDCLI_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    // A missing binary lands here, not on a non-zero exit.
    child.on('error', err => { stderr += `\n${err.message}`; finish(false); });
    child.on('close', code => finish(!timedOut && code === 0));
  });
}

/** Parse bytedcli's `--json` envelope, which wraps everything in {status,data}. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  // `--begin` emits progress events (`qr_image_ready`) before the envelope, one
  // JSON object per line, so take the last parseable line rather than the first.
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
  } catch { /* progress lines may precede the envelope */ }
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
    } catch { /* not the envelope line */ }
  }
  return null;
}

/**
 * Where a started-but-unfinished login's resume token lives.
 *
 * Inside that person's own HOME rather than a shared pending-login store: the
 * token resumes THEIR authorization, and keeping it beside the auth state it
 * belongs to means clearing one person's authorization clears their pending
 * login with it, and no lookup can hand it to anyone else.
 */
function challengePath(openId: string, site: ByteCloudUserSite): string {
  return join(bytedcliHomeFor(openId), `.botmux-login-challenge.${site}`);
}

/** The resume token from this person's in-progress login, if it is still
 *  usable. ByteCloud gives the challenge about an hour; we expire slightly
 *  earlier so a token we hand back is not rejected the moment it is used. */
function pendingBytedcliLogin(openId: string, site: ByteCloudUserSite): BytedcliLoginChallenge | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(openId, site), 'utf8')) as
      { token?: unknown; authUrl?: unknown; createdAt?: unknown; site?: unknown };
    if (typeof raw.token !== 'string' || !raw.token || typeof raw.createdAt !== 'number'
      || !Number.isFinite(raw.createdAt) || raw.createdAt > Date.now() || raw.site !== site) return null;
    if (Date.now() - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return {
      site,
      completeToken: raw.token,
      authUrl: typeof raw.authUrl === 'string' ? raw.authUrl : '',
    };
  } catch { return null; }
}

export function pendingBytedcliChallenge(
  openId: string,
  site: ByteCloudUserSite = 'cn',
): string | null {
  return pendingBytedcliLogin(openId, site)?.completeToken ?? null;
}

function saveChallenge(openId: string, site: ByteCloudUserSite, token: string, authUrl: string): boolean {
  try {
    atomicWriteFileSync(
      challengePath(openId, site),
      JSON.stringify({ site, token, authUrl, createdAt: Date.now() }),
      { mode: 0o600 },
    );
    return true;
  } catch {
    // Never hand out a challenge that the next turn cannot resume.
    logger.warn('[bytedcli-auth] could not persist the login challenge');
    return false;
  }
}

function clearChallenge(openId: string, site: ByteCloudUserSite): void {
  try { rmSync(challengePath(openId, site), { force: true }); } catch { /* already gone */ }
}

export interface BytedcliLoginChallenge {
  /** Canonical ByteCloud credential site this challenge belongs to. */
  site: ByteCloudUserSite;
  /** The page the person opens to authorize. */
  authUrl: string;
  /** Opaque token that resumes this login; valid about an hour. */
  completeToken: string;
}

/**
 * Start a login for one person and return the link to send them. An unfinished,
 * still-valid challenge is reused so repeated turns do not create new links.
 *
 * Non-blocking (`--begin`): the CLI returns immediately with a resume token
 * instead of holding a terminal open waiting for a scan, which is the only
 * shape that works when the person authorizing is on the other side of a chat.
 */
const beginnings = new Map<string, { epoch: number; durableEpoch: number; work: Promise<BytedcliLoginChallenge | null> }>();

export async function beginBytedcliLogin(
  openId: string,
  site: ByteCloudUserSite = 'cn',
): Promise<BytedcliLoginChallenge | null> {
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const key = credentialSiteKey(openId, site);
  const existing = beginnings.get(key);
  if (existing?.epoch === epoch && existing.durableEpoch === durableEpoch) {
    const result = await existing.work;
    return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null;
  }
  const work = serializedCredentialWork(openId, () => credentialEpochCurrent(openId, epoch, durableEpoch)
    ? beginLogin(openId, site, epoch, durableEpoch) : Promise.resolve(null));
  beginnings.set(key, { epoch, durableEpoch, work });
  try { return await work; } finally {
    if (beginnings.get(key)?.work === work) beginnings.delete(key);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function beginLogin(
  openId: string,
  site: ByteCloudUserSite,
  epoch: number,
  durableEpoch: number,
): Promise<BytedcliLoginChallenge | null> {
  const home = bytedcliHomeFor(openId);
  // A revoked HOME must not resume its old challenge. Clear it before login;
  // a newer login that landed during this call is left alone below.
  // The durable epoch/stamp is shared by every daemon. A matching new login
  // must survive here even if this process performed an earlier revoke.
  // An unstamped legacy HOME is still valid at epoch zero.
  if (existsSync(home) && !cliAuthEpochAllows(openId, home)) {
    // The previous SDK child has left the shared queue. Remove any late files
    // before stamping a new login; cleanup is not a new revocation operation.
    try { rmSync(home, { recursive: true, force: true }); } catch { return null; }
    forgetCachedJwts(openId);
  }

  const pending = pendingBytedcliLogin(openId, site);
  if (pending?.authUrl) return pending;

  const { ok, stdout } = await runAsUser(openId, [
    '--site', site,
    'auth', 'login', '--begin', '--json',
  ]);
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  const authUrl = typeof data?.verification_uri_complete === 'string'
    ? data.verification_uri_complete
    : undefined;
  const completeToken = typeof data?.complete_token === 'string' ? data.complete_token : undefined;
  if (!ok || env?.status !== 'success' || !authUrl || !completeToken) {
    logger.warn('[bytedcli-auth] could not start a login; provider failed or returned an invalid challenge');
    return null;
  }
  // Epoch moved while the CLI ran: a revoke, or a newer login, won. Do not
  // stamp or delete — the newer HOME may already be valid.
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  stampCliAuthEpoch(openId, home);
  if (!saveChallenge(openId, site, completeToken, authUrl)) return null;
  return { site, authUrl, completeToken };
}

export type BytedcliLoginState = 'authorized' | 'pending' | 'failed' | 'unavailable';

/**
 * Try to finish a started login.
 *
 * `pending` means the person has not authorized yet — an ordinary state, not an
 * error, and the caller should say so rather than reporting a failure.
 */
export async function completeBytedcliLogin(
  openId: string,
  siteOrCompleteToken: ByteCloudUserSite | string,
  maybeCompleteToken?: string,
): Promise<{ state: BytedcliLoginState; detail?: string }> {
  const site: ByteCloudUserSite = maybeCompleteToken === undefined
    ? 'cn'
    : siteOrCompleteToken as ByteCloudUserSite;
  const completeToken = maybeCompleteToken ?? siteOrCompleteToken;
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const work = serializedCredentialWork(openId, () =>
    completeLogin(openId, site, completeToken, epoch, durableEpoch));
  try { return await work; } finally {
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function completeLogin(
  openId: string,
  site: ByteCloudUserSite,
  completeToken: string,
  epoch: number,
  durableEpoch: number,
): Promise<{ state: BytedcliLoginState; detail?: string }> {
  const current = () => credentialEpochCurrent(openId, epoch, durableEpoch)
    && (!pendingBytedcliChallenge(openId, site)
      || pendingBytedcliChallenge(openId, site) === completeToken);
  const retired = () => ({ state: 'failed' as const, detail: 'Login attempt was replaced or revoked.' });
  if (!current()) return retired();
  const { ok, stdout } = await runAsUser(
    openId,
    ['--site', site, 'auth', 'login', '--complete', completeToken, '--json'],
  );
  if (!current()) return retired();
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  const state = data?.login_status ?? data?.status;
  const error = env?.error as Record<string, unknown> | undefined;
  const errorCode = typeof error?.code === 'string' ? error.code : '';
  if ((ok && env?.status === 'success' && state === 'pending')
    || errorCode === 'BYTECLOUD_AUTH_LOGIN_PENDING') return { state: 'pending' };
  if (ok && env?.status === 'success' && (state === 'success' || state === 'ok')) {
    // Completion is not authority until the isolated provider can use the login.
    try {
      if ((await readLoginState(openId, site)).authenticated) {
        if (!current()) return retired();
        clearChallenge(openId, site);
        return { state: 'authorized' };
      }
    } catch { /* Preserve the challenge until the provider can verify it. */ }
    return { state: 'unavailable', detail: 'Login completion did not produce usable personal credentials; retry status without starting another login.' };
  }
  const terminal = ['expired', 'denied', 'invalid_ticket'].includes(String(state))
    || ['BYTECLOUD_AUTH_LOGIN_EXPIRED', 'BYTECLOUD_AUTH_LOGIN_DENIED',
      'BYTECLOUD_AUTH_LOGIN_INVALID_TICKET', 'BYTECLOUD_AUTH_LOGIN_CHALLENGE_INVALID'].includes(errorCode);
  // Network errors, timeouts and unknown output do not invalidate a challenge.
  if (!current()) return retired();
  if (terminal) clearChallenge(openId, site);
  return { state: terminal ? 'failed' : 'unavailable', detail: terminal
    ? 'Login challenge expired or was rejected.'
    : 'Authorization service unavailable; the existing login challenge was retained. Retry later without reauthorizing.' };
}

export interface BytedcliJwts {
  cloudJwt: string;
  /** Git pushes authenticate with this one, so commit attribution follows it. */
  codeJwt?: string;
  /** ByteCloud JWTs for non-default regions, keyed by region. */
  regionalCloudJwts?: BytedcliRegionalJwts;
}

const allSiteMinting = new Map<
  string,
  {
    epoch: number;
    durableEpoch: number;
    work: Promise<Partial<Record<ByteCloudUserSite, string>> | null>;
  }
>();

/**
 * Mint the current sender's ByteCloud JWT for every control plane their login
 * can reach. Missing regional access is represented by an absent entry, never
 * by falling through to a machine login inside a governed CLI.
 */
export async function mintByteCloudUserJwts(
  openId: string,
): Promise<Partial<Record<ByteCloudUserSite, string>> | null> {
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const existing = allSiteMinting.get(openId);
  if (existing?.epoch === epoch && existing.durableEpoch === durableEpoch) {
    const result = await existing.work;
    return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null;
  }
  const work = serializedCredentialWork(openId, async () =>
    credentialEpochCurrent(openId, epoch, durableEpoch)
      ? await mintAllSiteUserJwts(openId, epoch, durableEpoch)
      : null);
  allSiteMinting.set(openId, { epoch, durableEpoch, work });
  try {
    const result = await work;
    return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null;
  } finally {
    if (allSiteMinting.get(openId)?.work === work) allSiteMinting.delete(openId);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function mintAllSiteUserJwts(
  openId: string,
  epoch: number,
  durableEpoch: number,
): Promise<Partial<Record<ByteCloudUserSite, string>> | null> {
  const result: Partial<Record<ByteCloudUserSite, string>> = {};
  let unavailable: unknown;
  // Keep one process at a time inside the same durable HOME. ByteCloud Auth
  // may rotate and persist login state while minting; concurrent regional
  // processes must not race those writes. Every site is authoritative for
  // itself: CN being absent must not suppress an authorized I18N/US/EU site.
  for (const site of BYTECLOUD_USER_SITES) {
    if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
    try {
      const jwt = await mintSiteCloudJwt(openId, site, epoch, durableEpoch);
      if (jwt) result[site] = jwt;
    } catch (error) {
      unavailable = error;
      logger.debug(`[bytedcli-auth] personal ByteCloud JWT unavailable for governed CLI site ${site}`);
    }
  }
  if (Object.keys(result).length) return result;
  if (unavailable) throw unavailable;
  return null;
}

/** Backward-compatible name for callers that only use the tokens with larkdev. */
export const mintLarkdevByteCloudJwts = mintByteCloudUserJwts;

/**
 * ByteCloud JWTs are partition-scoped: the default (cn) token is rejected by
 * i18n services with `invalid jwt token ... partition i18n`. Each entry names
 * the region and one `--site` that mints its token; the wrapper maps every
 * `--site` value onto these regions (see renderIdentityWrapper).
 */
export const BYTEDCLI_REGIONAL_SITES = [
  // The site `i18n` belongs to i18nbd; use i18n-tt for the i18n region.
  ['i18n', 'i18n-tt'],
  ['i18nbd', 'i18n-bd'],
  ['tx', 'us-ttp'],
] as const;
export type BytedcliRegion = typeof BYTEDCLI_REGIONAL_SITES[number][0];
export type BytedcliRegionalJwts = Partial<Record<BytedcliRegion, string>>;

/**
 * Mint this person's JWTs for the current turn.
 *
 * Called per turn because the ByteCloud JWT lives only ~2 hours while the
 * login behind it lives ~3 weeks: `bytedcli` refreshes it internally when it
 * is expiring, so asking each time is what keeps a person from being sent back
 * to a QR code every couple of hours. Each call checks the login; tokens an
 * earlier turn minted under that same login are reused while they keep enough
 * life (see `turnJwtCache`), so a turn costs one CLI run instead of six.
 *
 * If a device login is pending for this site, first try to complete it. This
 * makes "open the link, then retry" sufficient while keeping the challenge,
 * status check and minted JWT on the same explicit site.
 *
 * The completion is BEST-EFFORT, never a gate: a still-pending (or just-failed)
 * challenge says nothing about whether this person already has a valid login,
 * and returning null here would lock an already-authorized person out — a
 * single transient blip can auto-begin a challenge on the refusal path, and a
 * non-authorized poll result must not then veto the perfectly good HOME below
 * (which is also the only thing that can clear that state). So regardless of
 * the poll outcome, fall through and let the HOME / JWT read be the authority.
 */
const minting = new Map<string, Promise<BytedcliJwts | null>>();
const authEpochs = new Map<string, number>();
// Epoch invalidation must not release the HOME's operation lock while an old
// provider child can still write its SDK cache.
const credentialWork = new Map<string, Promise<unknown>>();
function serializedCredentialWork<T>(openId: string, run: () => Promise<T>): Promise<T> {
  const previous = credentialWork.get(openId);
  const work = (async () => { await previous?.catch(() => null); return await run(); })();
  credentialWork.set(openId, work);
  return work;
}

function credentialSiteKey(openId: string, site: ByteCloudUserSite): string {
  return `${openId}\0${site}`;
}

function deleteCredentialSiteEntries(map: Map<string, unknown>, openId: string): void {
  const prefix = `${openId}\0`;
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}

function authEpoch(openId: string): number { return authEpochs.get(openId) ?? 0; }
function credentialEpochCurrent(openId: string, epoch: number, durableEpoch: number): boolean {
  return epoch === authEpoch(openId) && durableEpoch === readCliAuthEpoch(openId);
}


/**
 * Regional JWTs reused while they keep at least half an hour of life. A fresh
 * mint gains nothing earlier: bytedcli serves its own disk-cached token until
 * that nears expiry, so re-asking every turn only adds CLI round trips — and
 * stretches the window in which a turn's identity is not yet published. Reuse
 * needs this turn's default mint to have just confirmed the login is live.
 */
const regionalJwtCache = new Map<string, { jwt: string; expiresAtMs: number; durableEpoch: number; fingerprint?: string }>();
const REGIONAL_JWT_REUSE_MARGIN_MS = 30 * 60_000;

function jwtClaims(jwt: string): { exp?: unknown; region?: unknown } | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Regions this person's login could not mint a token for, and under which
 * login. Most logins hold no regional access, so without this every turn spent
 * three failing CLI runs (~2.5s measured) re-learning that. A miss only means
 * "that region keeps the default token", which is also what a failure means,
 * so remembering it can never widen access. It is forgotten on any change of
 * login or epoch, on logout, and after {@link REGIONAL_MISS_TTL_MS}.
 */
const regionalMissCache = new Map<string, { fingerprint: string; epoch: number; durableEpoch: number; atMs: number }>();
export const REGIONAL_MISS_TTL_MS = 10 * 60_000;

async function regionalCloudJwt(
  openId: string,
  region: BytedcliRegion,
  site: ByteCloudUserSite,
  forceRefresh = false,
  epoch = authEpoch(openId),
  durableEpoch = readCliAuthEpoch(openId),
): Promise<string | null> {
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const login = await readLoginState(openId, site);
  if (!login.authenticated || !credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const fingerprint = login.fingerprint;
  const key = `${openId}\0${region}`;
  const cached = regionalJwtCache.get(key);
  // The login it was minted under must still be the one in force: a re-login
  // as another account in the same HOME moves no epoch.
  if (!forceRefresh && cached && cached.durableEpoch === durableEpoch && cached.fingerprint === fingerprint
    && cached.expiresAtMs - Date.now() > REGIONAL_JWT_REUSE_MARGIN_MS) return cached.jwt;
  regionalJwtCache.delete(key);
  const miss = regionalMissCache.get(key);
  if (!forceRefresh && fingerprint && miss && miss.fingerprint === fingerprint && miss.epoch === epoch
    && miss.durableEpoch === durableEpoch && Date.now() - miss.atMs < REGIONAL_MISS_TTL_MS && Date.now() >= miss.atMs) return null;
  regionalMissCache.delete(key);
  const result = await runAsUser(openId, [
    '--site', site, 'auth', 'get-bytecloud-jwt-token', ...(forceRefresh ? ['--force-refresh'] : []),
  ]);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const jwt = result.ok ? result.stdout.trim() : '';
  const claims = jwt && !/\s/.test(jwt) ? jwtClaims(jwt) : null;
  // A token for another partition would only move the failure; keep the default.
  if (!claims || claims.region !== region) {
    logger.debug(`[bytedcli-auth] no ${region} ByteCloud JWT for ${openId}; that region keeps the default token`);
    // Remember only a definite answer about this login (the CLI ran and said
    // it holds no login for that site, or handed back no usable token). A
    // timeout, a crash or a missing binary says nothing, so the next turn asks
    // again.
    if (fingerprint && regionalAnswerIsDefinite(result)) {
      regionalMissCache.set(key, { fingerprint, epoch, durableEpoch, atMs: Date.now() });
    }
    return null;
  }
  if (typeof claims.exp === 'number') {
    regionalJwtCache.set(key, { jwt, expiresAtMs: claims.exp * 1_000, durableEpoch, ...(fingerprint ? { fingerprint } : {}) });
  }
  return jwt;
}

/** The CLI completed and answered: either it printed something that is not a
 *  token for that region, or it refused because that site has no login. */
function regionalAnswerIsDefinite(result: BytedcliResult): boolean {
  if (result.ok) return true;
  return /\bNot authenticated\b|\bAUTH_REQUIRED\b/.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * This person's default and Codebase JWTs from an earlier turn, reused while
 * the SAME login is in force. Each turn still runs the provider's login check
 * first (the authority the per-turn path always consulted); reuse then also
 * needs the in-process and durable revoke epochs unchanged, the login check's
 * fingerprint unchanged, and the token to keep at least
 * {@link TURN_JWT_REUSE_MARGIN_MS} of life. bytedcli itself serves these
 * tokens from its disk cache until they near expiry, so this skips CLI runs,
 * not a server-side check.
 */
const turnJwtCache = new Map<string, {
  fingerprint: string; epoch: number; durableEpoch: number;
  cloud?: { jwt: string; expiresAtMs: number };
  code?: { jwt: string; expiresAtMs: number };
}>();
export const TURN_JWT_REUSE_MARGIN_MS = 30 * 60_000;

function expiringJwt(jwt: string): { jwt: string; expiresAtMs: number } | undefined {
  const exp = jwtClaims(jwt)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? { jwt, expiresAtMs: exp * 1_000 } : undefined;
}

function reusable(token: { jwt: string; expiresAtMs: number } | undefined): string | undefined {
  return token && token.expiresAtMs - Date.now() > TURN_JWT_REUSE_MARGIN_MS ? token.jwt : undefined;
}

function forgetCachedJwts(openId: string): void {
  deleteCredentialSiteEntries(turnJwtCache, openId);
  for (const cache of [regionalJwtCache, regionalMissCache]) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${openId}\0`)) cache.delete(key);
    }
  }
}

export async function mintBytedcliJwts(
  openId: string,
  requestedSite?: ByteCloudUserSite,
): Promise<BytedcliJwts | null> {
  const site = requestedSite ?? 'cn';
  const includeLegacyRegional = requestedSite === undefined;
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const key = `${credentialSiteKey(openId, site)}\0${includeLegacyRegional ? 'legacy-regional' : 'site-only'}`;
  const existing = minting.get(key);
  if (existing) {
    const result = await existing;
    return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null;
  }
  const work = serializedCredentialWork(openId, async () =>
    credentialEpochCurrent(openId, epoch, durableEpoch)
      ? await mintJwts(openId, site, epoch, durableEpoch, includeLegacyRegional)
      : null);
  minting.set(key, work);
  try { const result = await work; return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null; }
  finally {
    if (minting.get(key) === work) minting.delete(key);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

const renewing = new Map<string, Promise<BytedcliJwts | null>>();

/**
 * Force-refresh one person's ByteCloud JWTs for a turn that outlives them.
 *
 * Turn publication mints once, and a ByteCloud JWT lives ~2h, so a long job
 * started by one turn would otherwise hit 401 mid-run. The login behind the
 * JWT (~30 days) is unchanged; this only asks the SDK for a new access token.
 * Null when no fresh default token could be obtained.
 */
export async function renewBytedcliJwts(
  openId: string,
  requestedSite?: ByteCloudUserSite,
): Promise<BytedcliJwts | null> {
  const site = requestedSite ?? 'cn';
  const includeLegacyRegional = requestedSite === undefined;
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const key = `${credentialSiteKey(openId, site)}\0${includeLegacyRegional ? 'legacy-regional' : 'site-only'}`;
  const existing = renewing.get(key);
  if (existing) {
    const result = await existing;
    return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null;
  }
  const work = serializedCredentialWork(openId, async () =>
    credentialEpochCurrent(openId, epoch, durableEpoch)
      ? await renewJwts(openId, site, epoch, durableEpoch, includeLegacyRegional)
      : null);
  renewing.set(key, work);
  try { const result = await work; return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null; }
  finally {
    if (renewing.get(key) === work) renewing.delete(key);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function renewJwts(
  openId: string,
  site: ByteCloudUserSite,
  epoch: number,
  durableEpoch: number,
  includeLegacyRegional: boolean,
): Promise<BytedcliJwts | null> {
  // A forced refresh replaces the tokens a later turn would otherwise reuse.
  turnJwtCache.delete(credentialSiteKey(openId, site));
  let cloudJwt: string | null;
  try {
    cloudJwt = await mintSiteCloudJwt(openId, site, epoch, durableEpoch, true);
  } catch (error) {
    if (error instanceof BytedcliAuthUnavailableError) return null;
    throw error;
  }
  if (!cloudJwt) return null;
  const code = await runAsUser(openId, ['--site', site, 'auth', 'get-codebase-jwt-token']);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const codeJwt = code.ok ? code.stdout.trim() : '';
  const regionalCloudJwts: BytedcliRegionalJwts = {};
  if (includeLegacyRegional) {
    for (const [region, regionalSite] of BYTEDCLI_REGIONAL_SITES) {
      try {
        const jwt = await regionalCloudJwt(
          openId, region, regionalSite, true, epoch, durableEpoch,
        );
        if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
        if (jwt) regionalCloudJwts[region] = jwt;
      } catch {
        logger.debug(`[bytedcli-auth] optional regional ByteCloud JWT renewal unavailable for ${region}`);
      }
    }
  }
  if (!cliAuthEpochAllows(openId, bytedcliHomeFor(openId))) return null;
  return {
    cloudJwt,
    ...(codeJwt && !/\s/.test(codeJwt) ? { codeJwt } : {}),
    ...(Object.keys(regionalCloudJwts).length ? { regionalCloudJwts } : {}),
  };
}

async function mintSiteCloudJwt(
  openId: string,
  site: ByteCloudUserSite,
  epoch: number,
  durableEpoch: number,
  forceRefresh = false,
): Promise<string | null> {
  const challenge = pendingBytedcliChallenge(openId, site);
  if (challenge) {
    await completeLogin(openId, site, challenge, epoch, durableEpoch);
  }
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  // The login check runs every turn, cached tokens or not: it is the authority.
  const login = await readLoginState(openId, site);
  if (!login.authenticated || !credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const fingerprint = login.fingerprint;
  const key = credentialSiteKey(openId, site);
  const prior = turnJwtCache.get(key);
  const same = !!fingerprint && prior?.fingerprint === fingerprint
    && prior.epoch === epoch && prior.durableEpoch === durableEpoch;
  // A different login (re-login, another account, a refresh) invalidates
  // every token cached for this person, regional ones included.
  if (!same && prior) forgetCachedJwts(openId);
  else if (!same) turnJwtCache.delete(key);
  // A cached token was JWT-shaped when stored (only claims-parsed tokens enter
  // the cache below), so the whitespace guard protects fresh mints only.
  let cloudJwt = !forceRefresh && same ? reusable(prior.cloud) : undefined;
  if (!cloudJwt) {
    const cloud = await runAsUser(openId, [
      '--site', site,
      'auth', 'get-bytecloud-jwt-token',
      // A successful status check does not guarantee that the provider's
      // cached JWT is fresh enough for an isolated turn that cannot renew the
      // durable login itself.
      '--force-refresh',
    ]);
    if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
    cloudJwt = cloud.stdout.trim();
    if (!cloud.ok || !usableMintedJwt(cloudJwt)) {
      throw new BytedcliAuthUnavailableError(`mint personal JWT for site ${site}`);
    }
  }
  if (!forceRefresh && fingerprint && credentialEpochCurrent(openId, epoch, durableEpoch)) {
    const cloudToken = expiringJwt(cloudJwt);
    turnJwtCache.set(key, {
      fingerprint,
      epoch,
      durableEpoch,
      ...(cloudToken ? { cloud: cloudToken } : {}),
      ...(same && prior?.code ? { code: prior.code } : {}),
    });
  }
  return cloudJwt;
}

/** Check the provider's JWT lifetime, without treating payload claims as proof
 * of identity. The provider still owns signature and principal validation. */
function usableMintedJwt(jwt: string): boolean {
  if (/\s/.test(jwt)) return false;
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some(part => !part || !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return false;
    const exp = (claims as Record<string, unknown>).exp;
    // Keep enough lifetime for one bounded provider operation during setup;
    // do not publish a token that is about to expire before the CLI starts.
    return typeof exp === 'number' && Number.isFinite(exp)
      && exp * 1000 > Date.now() + BYTEDCLI_TIMEOUT_MS;
  } catch {
    return false;
  }
}

async function mintJwts(
  openId: string,
  site: ByteCloudUserSite,
  epoch: number,
  durableEpoch: number,
  includeLegacyRegional: boolean,
): Promise<BytedcliJwts | null> {
  const cloudJwt = await mintSiteCloudJwt(openId, site, epoch, durableEpoch);
  if (!cloudJwt) return null;
  // The Codebase JWT is optional: without it lark/bytedcli calls still work and
  // only git attribution degrades, so a failure here must not deny the turn.
  const key = credentialSiteKey(openId, site);
  const cached = turnJwtCache.get(key);
  let codeJwt = cached && cached.epoch === epoch && cached.durableEpoch === durableEpoch
    ? reusable(cached.code) ?? ''
    : '';
  if (!codeJwt) {
    const code = await runAsUser(openId, ['--site', site, 'auth', 'get-codebase-jwt-token']);
    if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
    const mintedCodeJwt = code.ok ? code.stdout.trim() : '';
    codeJwt = /\s/.test(mintedCodeJwt) ? '' : mintedCodeJwt;
  }
  if (!codeJwt) {
    logger.debug(`[bytedcli-auth] no Codebase JWT for ${openId}; git attribution will fall back`);
  }
  // Regional tokens are best-effort like the Codebase JWT: without one, that
  // region's calls keep the default token. Minted one at a time — concurrent
  // mints against the same HOME were measured returning another region's token.
  const regionalCloudJwts: BytedcliRegionalJwts = {};
  if (includeLegacyRegional) {
    for (const [region, regionalSite] of BYTEDCLI_REGIONAL_SITES) {
      try {
        const jwt = await regionalCloudJwt(
          openId, region, regionalSite, false, epoch, durableEpoch,
        );
        if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
        if (jwt) regionalCloudJwts[region] = jwt;
      } catch {
        logger.debug(`[bytedcli-auth] optional regional ByteCloud JWT unavailable for ${region}`);
      }
    }
  }
  // Keep master's durable revoke fence after all regional provider awaits.
  if (!cliAuthEpochAllows(openId, bytedcliHomeFor(openId))) return null;
  const current = turnJwtCache.get(key);
  if (current && current.epoch === epoch && current.durableEpoch === durableEpoch
    && credentialEpochCurrent(openId, epoch, durableEpoch)) {
    const codeToken = codeJwt && !/\s/.test(codeJwt) ? expiringJwt(codeJwt) : undefined;
    turnJwtCache.set(key, {
      ...current,
      ...(codeToken ? { code: codeToken } : {}),
    });
  }
  return {
    cloudJwt,
    ...(codeJwt ? { codeJwt } : {}),
    ...(Object.keys(regionalCloudJwts).length ? { regionalCloudJwts } : {}),
  };
}
