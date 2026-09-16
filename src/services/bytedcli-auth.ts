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
 * So: nothing in this module holds a credential. It holds a path, and shells
 * out to `bytedcli` with `HOME` set to it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';
import { startBytedcliIpv4Proxy } from './bytedcli-ipv4-proxy.js';

/** Root under which each authorized person gets their own bytedcli HOME. */
const BYTEDCLI_HOME_ROOT = join(homedir(), '.botmux', 'data', 'bytedcli-home');

/** Bound ordinary requests tightly so a black-holed ByteCloud TLS connection
 *  can be retried without holding the chat command open for minutes. Login
 *  completion is deliberately different: auth.login.complete is a long poll
 *  and routinely needs more than three seconds after browser approval. */
const BYTEDCLI_HTTP_TIMEOUT_MS = 3_000;
const BYTEDCLI_ATTEMPT_TIMEOUT_MS = 8_000;
const BYTEDCLI_MAX_ATTEMPTS = 5;
const BYTEDCLI_COMPLETE_HTTP_TIMEOUT_MS = 30_000;
const BYTEDCLI_COMPLETE_ATTEMPT_TIMEOUT_MS = 40_000;
// Token minting also crosses the ByteCloud auth runtime. A freshly completed
// login was measured taking more than 12 seconds to mint its first JWT, so the
// ordinary 3-second request budget falsely turns valid logins into refusals.
const BYTEDCLI_TOKEN_HTTP_TIMEOUT_MS = 30_000;
const BYTEDCLI_TOKEN_ATTEMPT_TIMEOUT_MS = 40_000;

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

/** Whether this person has ever completed a bytedcli login here. Cheap enough
 *  to call per turn; says nothing about whether that login is still valid. */
export function hasBytedcliHome(openId: string): boolean {
  try { return existsSync(bytedcliHomeFor(openId)); } catch { return false; }
}

/** Forget one person's bytedcli authorization entirely. */
export function clearBytedcliAuth(openId: string): void {
  try { rmSync(bytedcliHomeFor(openId), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

export interface BytedcliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `bytedcli` as one person.
 *
 * `HOME` is the whole mechanism. Everything else in the environment is
 * inherited, because bytedcli needs the usual PATH/proxy/site settings to reach
 * ByteCloud at all.
 */
interface BytedcliRunOptions {
  httpTimeoutMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
}

async function runAsUser(
  openId: string,
  args: string[],
  options: BytedcliRunOptions = {},
): Promise<BytedcliResult> {
  const home = bytedcliHomeFor(openId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const httpTimeoutMs = options.httpTimeoutMs ?? BYTEDCLI_HTTP_TIMEOUT_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? BYTEDCLI_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? BYTEDCLI_MAX_ATTEMPTS;
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  let proxy: Awaited<ReturnType<typeof startBytedcliIpv4Proxy>> | undefined;
  let commandArgs = ['--no-auto-upgrade', ...args];
  if (process.platform === 'linux') {
    // The bundled ByteCloud Auth runtime is a statically-linked Go binary, so
    // GODEBUG=netdns=cgo is ignored. On dual-stack hosts an unreachable AAAA
    // address can consequently consume the whole TLS deadline. A short-lived
    // loopback CONNECT proxy resolves the gateway with Node's IPv4 resolver.
    proxy = await startBytedcliIpv4Proxy();
    commandArgs = [
      '--no-auto-upgrade',
      '--http-proxy', proxy.url,
      '--http-timeout-ms', String(httpTimeoutMs),
      ...args,
    ];
    // A host-level NO_PROXY entry for *.bytedance.net would bypass the explicit
    // proxy. These values are private to this one child process.
    childEnv.NO_PROXY = '127.0.0.1,localhost';
    childEnv.no_proxy = '127.0.0.1,localhost';
  }
  try {
    const runAttempt = () => new Promise<BytedcliResult>(resolve => {
      const child = spawn('bytedcli', commandArgs, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, stdout, stderr });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        stderr += '\n[bytedcli-auth] timed out';
        finish(false);
      }, attemptTimeoutMs);
      child.stdout.on('data', d => { stdout += String(d); });
      child.stderr.on('data', d => { stderr += String(d); });
      // A missing binary lands here, not on a non-zero exit.
      child.on('error', err => { stderr += `\n${err.message}`; finish(false); });
      child.on('close', code => finish(code === 0));
    });

    let lastResult: BytedcliResult = { ok: false, stdout: '', stderr: '' };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      lastResult = await runAttempt();
      if (lastResult.ok || !isRetryableNetworkFailure(lastResult) || attempt === maxAttempts) {
        return lastResult;
      }
      logger.warn(`[bytedcli-auth] transient network failure; retrying (${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, attempt * 100));
    }
    return lastResult;
  } finally {
    await proxy?.close();
  }
}

function isRetryableNetworkFailure(result: BytedcliResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return output.includes('bytecloud_auth_runtime_error')
    || output.includes('bytecloud_auth_login_timeout')
    || output.includes('tls handshake timeout')
    || output.includes('timeout awaiting response headers')
    || output.includes('connection reset')
    || output.includes('econnreset')
    || output.includes('no route to host')
    || output.includes('network is unreachable');
}

/** Parse bytedcli's `--json` envelope, which wraps everything in {status,data}. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  // `--begin` emits progress events (`qr_image_ready`) before the envelope, one
  // JSON object per line, so take the last parseable line rather than the first.
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
function challengePath(openId: string): string {
  return join(bytedcliHomeFor(openId), '.botmux-login-challenge');
}

/** The resume token from this person's in-progress login, if it is still
 *  usable. ByteCloud gives the challenge about an hour; we expire slightly
 *  earlier so a token we hand back is not rejected the moment it is used. */
export function pendingBytedcliChallenge(openId: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(openId), 'utf8')) as
      { token?: unknown; createdAt?: unknown };
    if (typeof raw.token !== 'string' || typeof raw.createdAt !== 'number') return null;
    if (Date.now() - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return raw.token;
  } catch { return null; }
}

function saveChallenge(openId: string, token: string): void {
  try {
    atomicWriteFileSync(
      challengePath(openId),
      JSON.stringify({ token, createdAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (e) {
    // Non-fatal: the person can still authorize, they just cannot resume with
    // `done` and will need a fresh link.
    logger.debug(`[bytedcli-auth] could not persist the login challenge: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function clearChallenge(openId: string): void {
  try { rmSync(challengePath(openId), { force: true }); } catch { /* already gone */ }
}

export interface BytedcliLoginChallenge {
  /** The page the person opens to authorize. */
  authUrl: string;
  /** Opaque token that resumes this login; valid about an hour. */
  completeToken: string;
}

/**
 * Start a login for one person and return the link to send them.
 *
 * Non-blocking (`--begin`): the CLI returns immediately with a resume token
 * instead of holding a terminal open waiting for a scan, which is the only
 * shape that works when the person authorizing is on the other side of a chat.
 */
export async function beginBytedcliLogin(openId: string): Promise<BytedcliLoginChallenge | null> {
  // A failed fresh begin must not leave `done` pointing at an older challenge.
  clearChallenge(openId);
  const { ok, stdout, stderr } = await runAsUser(openId, ['auth', 'login', '--begin', '--json']);
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  const authUrl = typeof data?.verification_uri_complete === 'string'
    ? data.verification_uri_complete
    : undefined;
  const completeToken = typeof data?.complete_token === 'string' ? data.complete_token : undefined;
  if (!ok || !authUrl || !completeToken) {
    const detail = (env?.error as Record<string, unknown> | undefined)?.message;
    logger.warn(`[bytedcli-auth] could not start a login: ${typeof detail === 'string' ? detail : stderr.trim() || stdout.trim() || 'no output'}`);
    return null;
  }
  saveChallenge(openId, completeToken);
  return { authUrl, completeToken };
}

export type BytedcliLoginState = 'authorized' | 'pending' | 'failed';

/**
 * Try to finish a started login.
 *
 * `pending` means the person has not authorized yet — an ordinary state, not an
 * error, and the caller should say so rather than reporting a failure.
 */
export async function completeBytedcliLogin(
  openId: string,
  completeToken: string,
): Promise<{ state: BytedcliLoginState; detail?: string }> {
  const { ok, stdout, stderr } = await runAsUser(
    openId,
    ['auth', 'login', '--complete', completeToken, '--json'],
    {
      // ByteCloud Auth implements completion as a long-poll RPC. Keep the
      // ordinary 3s budget for begin/JWT calls, but restore the SDK's 30s
      // request budget here and leave process-shutdown headroom. One attempt is
      // intentional: repeating five 30s polls would make one chat command hang
      // for minutes, while the saved challenge remains available for `done`.
      httpTimeoutMs: BYTEDCLI_COMPLETE_HTTP_TIMEOUT_MS,
      attemptTimeoutMs: BYTEDCLI_COMPLETE_ATTEMPT_TIMEOUT_MS,
      maxAttempts: 1,
    },
  );
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  if (ok && data?.status === 'pending') return { state: 'pending' };
  if (ok) { clearChallenge(openId); return { state: 'authorized' }; }
  const detail = (env?.error as Record<string, unknown> | undefined)?.message;
  return {
    state: 'failed',
    ...(typeof detail === 'string' ? { detail } : { detail: stderr.trim() || undefined }),
  };
}

export interface BytedcliJwts {
  /** Default CN credential, kept for consumers such as larkdev and git fallback. */
  cloudJwt: string;
  /**
   * ByteCloud JWTs are target-site scoped.  In particular, a CN JWT is not
   * accepted by i18n-bd even though both sites use the same ByteDance SSO
   * login.  The bytedcli wrapper selects one of these for each invocation.
   */
  cloudJwts: Partial<Record<BytedcliCredentialSite, string>>;
  /** Git pushes authenticate with this one, so commit attribution follows it. */
  codeJwt?: string;
}

export const BYTEDCLI_CREDENTIAL_SITES = [
  'cn',
  'boe',
  'i18n-bd',
  'i18n-tt',
  'us-ttp',
  'eu-ttp',
] as const;
export type BytedcliCredentialSite = typeof BYTEDCLI_CREDENTIAL_SITES[number];

/**
 * Mint this person's JWTs for the current turn.
 *
 * Called per turn rather than cached because the ByteCloud JWT lives only ~2
 * hours while the login behind it lives ~3 weeks: `bytedcli` refreshes it
 * internally when it is expiring, so asking each time is what keeps a person
 * from being sent back to a QR code every couple of hours.
 *
 * Returns null when the person's login has ended (or never happened), which the
 * caller turns into the ordinary "authorize, then retry" refusal.
 */
export async function mintBytedcliJwts(openId: string): Promise<BytedcliJwts | null> {
  if (!hasBytedcliHome(openId)) return null;
  // A ByteCloud JWT is scoped to the target cloud host, not merely to the SSO
  // identity that minted it.  `cn` and `i18n-bd`, for example, share the
  // ByteDance login but reject one another's JWT at the API boundary. Mint all
  // supported sites now, while the daemon still owns the private per-person
  // HOME. Calls are concurrent because any one may spend seconds in the auth
  // runtime. One long attempt is enough; the next turn naturally retries.
  const tokenRunOptions: BytedcliRunOptions = {
    httpTimeoutMs: BYTEDCLI_TOKEN_HTTP_TIMEOUT_MS,
    attemptTimeoutMs: BYTEDCLI_TOKEN_ATTEMPT_TIMEOUT_MS,
    maxAttempts: 1,
  };
  const siteResults = await Promise.all(BYTEDCLI_CREDENTIAL_SITES.map(async site => ({
    site,
    result: await runAsUser(
      openId,
      ['--site', site, 'auth', 'get-bytecloud-jwt-token'],
      tokenRunOptions,
    ),
  })));
  const cn = siteResults.find(({ site }) => site === 'cn')?.result;
  const cloudJwt = cn?.stdout.trim() ?? '';
  if (!cn?.ok || !cloudJwt) {
    logger.debug(`[bytedcli-auth] no ByteCloud JWT for ${openId}: ${cn?.stderr.trim() || 'empty output'}`);
    return null;
  }

  // CN remains required for backwards compatibility; the other sites are best
  // effort so an outage in one remote region does not deny every bytedcli call.
  const cloudJwts: Partial<Record<BytedcliCredentialSite, string>> = {};
  for (const { site, result } of siteResults) {
    const jwt = result.stdout.trim();
    if (result.ok && jwt) cloudJwts[site] = jwt;
    else logger.debug(
      `[bytedcli-auth] no ${site} ByteCloud JWT for ${openId}: ${result.stderr.trim() || 'empty output'}`,
    );
  }
  // The Codebase JWT is optional: without it lark/bytedcli calls still work and
  // only git attribution degrades, so a failure here must not deny the turn.
  const code = await runAsUser(openId, ['auth', 'get-codebase-jwt-token']);
  const codeJwt = code.ok ? code.stdout.trim() : '';
  if (!codeJwt) {
    logger.debug(`[bytedcli-auth] no Codebase JWT for ${openId}; git attribution will fall back`);
  }
  return { cloudJwt, cloudJwts, ...(codeJwt ? { codeJwt } : {}) };
}
