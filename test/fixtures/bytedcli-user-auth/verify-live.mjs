/** Preview-only read-only probe of personal mint -> publication -> real CLI.
 *
 * Run with bun from an isolated preview checkout; BYTECLOUD_LIVE_COMPILED=1
 * selects the preview-built dist modules. The native host login is the
 * one consenting test principal; a temporary HOME alias lets the real personal
 * provider run without copying credentials or changing any Bot configuration.
 * Native auth refresh may update that same host login. All identity files and
 * invocation homes are isolated and removed, and no JWT/native output is logged.
 * Optional BYTECLOUD_LIVE_INCIDENT_ID enables one exact read-only Guardian read.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || !process.env.HOME) throw new Error('preview_native_login_required');
// Bun caches os.homedir() at process startup. Set the isolated HOME before
// creating the runtime that imports the provider, instead of changing it after.
if (process.argv[2] !== '--isolated-child') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-personal-bytecloud-')));
  const { spawnTsScript } = await import('../../helpers/ts-runner.ts');
  try {
    const child = spawnTsScript(fileURLToPath(import.meta.url), ['--isolated-child'], {
      env: { ...process.env, HOME: root, BYTECLOUD_LIVE_NATIVE_HOME: process.env.HOME,
        BYTECLOUD_LIVE_TEST_ROOT: root }, stdio: 'inherit',
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 115000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    process.exitCode = code ?? 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
} else await runProbe();

async function runProbe() {
  const nativeHome = process.env.BYTECLOUD_LIVE_NATIVE_HOME;
  const root = process.env.BYTECLOUD_LIVE_TEST_ROOT;
  if (!nativeHome || !root || process.env.HOME !== root) throw new Error('isolated_child_home_required');
  const originalEnv = { ...process.env };
  const principal = 'ou_live_native_login_test_principal';
  const sessionId = 'live-personal-bytecloud';
  const turnId = 'live-personal-turn';
  const reports = [];
  let stage = 'setup';
  try {
    process.env.HOME = root;
    process.env.BOTMUX_HOME = join(root, 'botmux');
    process.env.BOTS_CONFIG = join(root, 'bots.json');
    process.env.SESSION_DATA_DIR = join(root, 'data');
    process.env.BOTMUX_NO_CLAIM = '1';
    delete process.env.CI;
    const { createTmuxFence, applyTmuxFenceEnv, teardownTmuxFence } = await import('../../helpers/tmux-fence.ts');
    const fence = createTmuxFence(originalEnv);
    applyTmuxFenceEnv(fence, process.env);
    try {
      stage = 'module_import';
      const compiled = process.env.BYTECLOUD_LIVE_COMPILED === '1';
      const { bytedcliHomeFor, mintByteCloudUserJwts } = await import(new URL(compiled
        ? '../../../dist/services/bytedcli-auth.js' : '../../../src/services/bytedcli-auth.ts', import.meta.url).href);
      const { prepareTriggerUserCliEnv, writeSessionIdentity, publishActiveTurn } = await import(new URL(compiled
        ? '../../../dist/core/cli-identity.js' : '../../../src/core/cli-identity.ts', import.meta.url).href);
      const home = bytedcliHomeFor(principal);
      if (!home.startsWith(root + '/')) throw new Error('personal_home_not_isolated');
      mkdirSync(join(home, '..'), { recursive: true, mode: 0o700 });
      symlinkSync(nativeHome, home, 'dir');
      stage = 'personal_mint';
      const jwts = await mintByteCloudUserJwts(principal);
      if (!jwts?.cn || !jwts?.['i18n-bd'] || !jwts?.['i18n-tt']) throw new Error('personal_regional_mint_unavailable');
      const metadata = Object.fromEntries(Object.entries(jwts).map(([site, jwt]) => {
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
        return [site, { remainingSeconds: Math.floor(claims.exp - Date.now() / 1000) }];
      }));
      const env = { ...originalEnv, SESSION_DATA_DIR: process.env.SESSION_DATA_DIR,
        BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1', BOTMUX_TMUX_SOCKET: process.env.BOTMUX_TMUX_SOCKET };
      delete env.CI;
      stage = 'publication';
      prepareTriggerUserCliEnv(env, env.SESSION_DATA_DIR, sessionId,
        { enabled: true, tools: ['bytedcli'], fallback: 'none', credentialSource: 'local' }, () => {}, 'single');
      writeSessionIdentity(env.SESSION_DATA_DIR, sessionId,
        { tool: 'bytedcli', cloudJwts: jwts, openId: principal, turnId }, 'single');
      publishActiveTurn(env.SESSION_DATA_DIR, sessionId, turnId, principal);
      for (const site of ['cn', 'i18n-bd', 'i18n-tt']) {
        stage = 'published_auth';
        const r = spawnSync('bytedcli', ['--site', site, '--as', 'user', '--json', 'auth', 'status'],
          { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        const body = JSON.parse(r.stdout);
        const sdk = body.data?.bytecloud_auth;
        const passed = r.status === 0 && body.status === 'success' && body.data?.authenticated === true
          && sdk?.status === 'ready' && sdk?.authType === 'user' && sdk?.authSource === 'env';
        reports.push({ tool: 'bytedcli', site, passed, exitCode: r.status });
        if (!passed) throw new Error('published_personal_auth_failed');
      }
      const incidentId = originalEnv.BYTECLOUD_LIVE_INCIDENT_ID;
      if (incidentId) {
        stage = 'guardian_read';
        if (!/^\d+$/.test(incidentId)) throw new Error('invalid_incident_id');
        const r = spawnSync('bytedcli', ['--site', 'cn', '--as', 'user', '--json', 'guardian', 'incident', 'get', '--id', incidentId],
          { env, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 });
        const body = JSON.parse(r.stdout);
        const passed = r.status === 0 && body.status === 'success' && String(body.data?.incident?.id) === incidentId;
        reports.push({ tool: 'guardian', site: 'cn', operation: 'incident.get', passed, exitCode: r.status });
        if (!passed) throw new Error('published_personal_guardian_read_failed');
      }
      process.stdout.write(JSON.stringify({ passed: true, metadata, reports }) + '\n');
    } finally { teardownTmuxFence(fence); }
  } catch (error) {
    process.stderr.write(JSON.stringify({ passed: false, reason: 'personal_probe_failed_redacted', stage,
      errorType: error?.name, errorCode: error?.code,
      ...(stage === 'module_import' ? { moduleError: String(error?.message ?? '').replace(/https?:\/\/\S+/g, '[url]').slice(0,500) } : {}), reports }) + '\n');
    process.exitCode = 1;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}
