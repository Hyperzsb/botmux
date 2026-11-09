/**
 * Preview-only, read-only authorization probe through NEW src/worker.ts children.
 *
 * Run from an isolated preview checkout with its existing dependency symlink:
 *   bun test/fixtures/group-join-host-auth/verify-live.mjs
 *   GROUP_JOIN_LIVE_COMPILED=1 bun test/fixtures/group-join-host-auth/verify-live.mjs
 * The second form probes the preview-built dist/worker.js artifact.
 * Optional real Base probes (values supplied by the operator, never logged):
 *   GROUP_JOIN_LIVE_BASE_URI       -> base +url-resolve --as user
 *   GROUP_JOIN_LIVE_BASE_TOKEN and GROUP_JOIN_LIVE_TABLE_ID
 *                                -> base +record-list --limit 1 --as user
 *   GROUP_JOIN_LIVE_FIELD_ID      -> optional minimal record field projection
 *
 * Keeps the authenticated host HOME. All Botmux state and worker working dirs
 * are temporary; BOTS_CONFIG isolates the registry/config directory as well as
 * SESSION_DATA_DIR/BOTMUX_HOME. A tmux fence protects every spawn before any
 * production config is imported. Tests PTY and, when installed, tmux via Pi's
 * existing adapter with an AI CLI stub. The stub runs only the listed real
 * read-only auth/Base commands; it never calls an AI service or writes Base.
 *
 * This proves the frozen automatic host decision survives a newly installed
 * sender-auth wrapper. It does not impersonate the daemon's proven loopback
 * channel, invoke larkdev/Guardian, or verify the TraeX model/RPC lifecycle.
 * Run ipc-current-execution-route.test.ts separately for the proven model.
 */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(fixturePath), '../../..');
const workerEntry = join(repoRoot, process.env.GROUP_JOIN_LIVE_COMPILED === '1' ? 'dist/worker.js' : 'src/worker.ts');
const requiredScopes = ['base:record:read', 'base:record:create', 'base:record:update'];
const governedTools = ['lark-cli', 'bytedcli', 'larkdev'];
const ownerCanary = 'ou_live_probe_owner_must_not_supply_credentials';

class ProbeFailure extends Error {
  constructor(code, details) { super(code); this.code = code; this.details = details; }
}

function demand(condition, code, details) {
  if (!condition) throw new ProbeFailure(code, details);
}

function executableOnPath(name, pathValue = process.env.PATH ?? '') {
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* keep searching */ }
  }
  return undefined;
}

function diagnosticPath(value) {
  if (!value) return null;
  // Diagnostics accept filesystem paths only; a URL/control sequence in an
  // unusual PATH entry must not expose query credentials or terminal escapes.
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]|:\/\//.test(value)) return '[non-filesystem-path]';
  const hostHome = process.env.GROUP_JOIN_LIVE_EXPECTED_HOME;
  const masked = hostHome && (value === hostHome || value.startsWith(`${hostHome}/`))
    ? `~${value.slice(hostHome.length)}` : value;
  return masked.length > 400 ? `${masked.slice(0, 400)}[truncated]` : masked;
}

function jsonCommand(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let body;
  try { body = JSON.parse(result.stdout); } catch { /* no raw output escapes */ }
  return { body, exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT' };
}

// Only booleans/status codes and the bounded, masked filesystem diagnostics
// cross the fixture boundary. Never persist native stdout/stderr, tokens,
// URLs or whole envs.
function commandSummary(result, success) {
  return { exitCode: result.exitCode, timedOut: result.timedOut, json: !!result.body, passed: result.exitCode === 0 && success };
}

function runCliStub() {
  const resultPath = process.env.GROUP_JOIN_LIVE_RESULT_PATH;
  const expectedBin = process.env.GROUP_JOIN_LIVE_WRAPPER_BIN;
  if (!resultPath || !expectedBin) process.exit(2);
  const report = {
    wrapperPath: {},
    pathDiagnostics: {
      effectivePathHead: (process.env.PATH ?? '').split(delimiter).filter(Boolean).slice(0, 8).map(diagnosticPath),
      actualToolPaths: {},
      expectedWrapperBin: diagnosticPath(expectedBin),
    },
    homePreserved: process.env.HOME === process.env.GROUP_JOIN_LIVE_EXPECTED_HOME,
    ownerIsCanary: process.env.BOTMUX_OWNER_OPEN_ID === ownerCanary
      && process.env.__OWNER_OPEN_ID === ownerCanary,
    appBindingAbsent: !process.env.BOTMUX_LARK_TOOL_BINDING,
    larkdev: { queried: false, reason: 'no_safe_auth_status_probe' },
    codebase: { queried: false, reason: 'companion_wrapper_only' },
  };
  for (const tool of [...governedTools, 'codebase']) {
    const binary = executableOnPath(tool);
    const realBinary = binary ? realpathSync(binary) : undefined;
    report.pathDiagnostics.actualToolPaths[tool] = {
      lookup: diagnosticPath(binary), real: diagnosticPath(realBinary),
    };
    // Production installs a wrapper only when its native executable exists.
    // Optional larkdev/codebase absence is explicit; available tools must wrap.
    report.wrapperPath[tool] = binary ? realBinary === join(expectedBin, tool) : null;
  }
  // Refuse before making native calls if the requested session wrapper lost
  // PATH priority (including tmux/login-shell PATH reconstruction).
  if (!report.homePreserved || !report.ownerIsCanary || !report.appBindingAbsent
    || !report.wrapperPath['lark-cli'] || !report.wrapperPath.bytedcli) {
    report.setupPassed = false;
  } else {
    report.setupPassed = true;
    const lark = jsonCommand('lark-cli', ['auth', 'status', '--json']);
    const user = lark.body?.identities?.user;
    report.larkAuth = {
      ...commandSummary(lark, lark.body?.identity === 'user' && user?.available === true
        && ['ready', 'needs_refresh'].includes(user?.status)),
      identityIsUser: lark.body?.identity === 'user',
      userAvailable: user?.available === true,
      readyOrRefreshable: ['ready', 'needs_refresh'].includes(user?.status),
    };
    const byted = jsonCommand('bytedcli', ['--site', 'i18n-bd', '--json', 'auth', 'status']);
    const cloud = byted.body?.data?.bytecloud_auth;
    report.bytedAuth = {
      ...commandSummary(byted, byted.body?.status === 'success' && byted.body?.data?.authenticated === true
        && cloud?.status === 'ready' && cloud?.authType === 'user'),
      authenticated: byted.body?.data?.authenticated === true,
      cloudReady: cloud?.status === 'ready',
      identityIsUser: cloud?.authType === 'user',
    };
    const scopes = jsonCommand('lark-cli', ['auth', 'check', '--scope', requiredScopes.join(' '), '--json']);
    const granted = Array.isArray(scopes.body?.granted) ? scopes.body.granted : [];
    const missing = scopes.body?.missing;
    report.scopes = {
      ...commandSummary(scopes, scopes.body?.ok === true && requiredScopes.every(scope => granted.includes(scope))
        && (missing === null || Array.isArray(missing) && missing.length === 0)),
      allRequiredGranted: requiredScopes.every(scope => granted.includes(scope)),
      noneMissing: missing === null || Array.isArray(missing) && missing.length === 0,
    };
    if (process.env.GROUP_JOIN_LIVE_BASE_URI) {
      const url = jsonCommand('lark-cli', ['base', '+url-resolve', '--url', process.env.GROUP_JOIN_LIVE_BASE_URI, '--as', 'user']);
      report.baseUrl = {
        ...commandSummary(url, url.body?.ok === true && url.body?.identity === 'user'
          && url.body?.data?.resource_type === 'bitable' && !!url.body?.data?.base_token),
        identityIsUser: url.body?.identity === 'user',
        baseResolved: url.body?.data?.resource_type === 'bitable' && !!url.body?.data?.base_token,
      };
    } else report.baseUrl = { queried: false, reason: 'uri_not_supplied' };
    if (process.env.GROUP_JOIN_LIVE_BASE_TOKEN && process.env.GROUP_JOIN_LIVE_TABLE_ID) {
      const args = ['base', '+record-list', '--base-token', process.env.GROUP_JOIN_LIVE_BASE_TOKEN,
        '--table-id', process.env.GROUP_JOIN_LIVE_TABLE_ID, '--limit', '1', '--as', 'user'];
      if (process.env.GROUP_JOIN_LIVE_FIELD_ID) args.push('--field-id', process.env.GROUP_JOIN_LIVE_FIELD_ID);
      const records = jsonCommand('lark-cli', args);
      report.baseRead = {
        ...commandSummary(records, records.body?.ok === true && records.body?.identity === 'user'),
        identityIsUser: records.body?.identity === 'user',
      };
    } else report.baseRead = { queried: false, reason: 'base_coordinates_not_supplied' };
  }
  writeFileSync(resultPath, JSON.stringify(report), { mode: 0o600 });
  // Keep the same CLI lifetime alive until Worker close; no output quiescence
  // may turn it into a successful finished turn before the probes complete.
  process.stdout.write('Ready\n');
  setInterval(() => {}, 1000);
}

async function main() {
  demand(process.platform === 'linux', 'preview_linux_required');
  demand(!!process.env.HOME, 'authenticated_host_home_required');
  const originalEnv = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-live-host-auth-')));
  const botmuxHome = join(root, 'botmux');
  mkdirSync(botmuxHome, { mode: 0o700 });
  writeFileSync(join(botmuxHome, 'bots.json'), '[]\n', { mode: 0o600 });
  const { createTmuxFence, applyTmuxFenceEnv, readTmuxFenceDenials, teardownTmuxFence } =
    await import('../../helpers/tmux-fence.ts');
  const fence = createTmuxFence(originalEnv);
  const activeChildren = new Set();
  const closes = new Map();
  const reports = [];
  let abort;
  const aborted = new Promise((_, reject) => { abort = reject; });
  // Signals may arrive during imports, before the execution race is attached.
  void aborted.catch(() => {});
  let timeout;
  let cancelled = false;
  let executing;
  const cancel = reason => { cancelled = true; abort(new ProbeFailure(reason)); };
  const stop = () => cancel('interrupted');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const closeWorker = async child => {
    if (closes.has(child)) return closes.get(child);
    const closing = (async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(done => child.once('exit', done));
      try { if (child.connected) child.send({ type: 'close' }); } catch { /* exited concurrently */ }
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(force);
    })();
    closes.set(child, closing);
    return closing;
  };
  try {
    // config.ts performs tmux functional probes at import time. Install the
    // fence and empty config registry BEFORE importing any production module.
    Object.assign(process.env, {
      BOTMUX_HOME: botmuxHome,
      BOTS_CONFIG: join(botmuxHome, 'bots.json'),
      SESSION_DATA_DIR: join(root, 'bootstrap-data'),
      BOTMUX_NO_CLAIM: '1', BOTMUX_SANDBOX: '0', BOTMUX_CORE_ONLY: '1',
      WEB_HOST: '127.0.0.1',
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      BOTMUX_TMUX_SOCKET: `live-probe-${randomUUID().slice(0, 8)}`,
    });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('BOTMUX_IDENTITY_') || key.startsWith('BOTMUX_WORKFLOW') || key.startsWith('BOTMUX_GOAL_')
        || ['BOTMUX_DAEMON_IPC_PORT', 'BOTMUX_V3_GOAL', 'BOTMUX_LARK_TOOL_BINDING', 'BOTMUX_OWNER_OPEN_ID',
          '__OWNER_OPEN_ID', 'BOTMUX_TURN_ID', 'BOTMUX_BOT_INDEX', 'CI'].includes(key)) delete process.env[key];
    }
    applyTmuxFenceEnv(fence, process.env);
    mkdirSync(process.env.SESSION_DATA_DIR, { mode: 0o700 });
    const { spawnNodeTsScript, nodeTsRunnerPrefix } = await import('../../helpers/ts-runner.ts');
    const { normalizeToolIdentityPolicy } = await import('../../../src/services/tool-identity-config.ts');
    const { buildAutomaticTurnDecision } = await import('../../../src/core/tool-identity-decision.ts');
    const { publishTurnCliIdentity } = await import('../../../src/core/turn-cli-identity.ts');
    const { sessionIdentityBinDir, sessionIdentityDataDir, sessionActiveTurnPath } = await import('../../../src/core/cli-identity.ts');
    demand(!!executableOnPath('lark-cli') && !!executableOnPath('bytedcli'), 'native_tools_missing');
    const node = nodeTsRunnerPrefix().command;
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const fakeCli = join(root, 'probe-pi');
    writeFileSync(fakeCli, `#!/bin/sh\nexec ${quote(node)} ${quote(fixturePath)} --stub-cli "$@"\n`, { mode: 0o700 });
    const backends = ['pty', ...(fence.binDir ? ['tmux'] : [])];
    if (!fence.binDir) reports.push({ backend: 'tmux', queried: false, reason: 'tmux_not_installed' });
    timeout = setTimeout(() => cancel('total_timeout_120s'), 120_000);
    const execute = async () => {
      for (const backendType of backends) {
        demand(!cancelled, 'cancelled');
        const sessionId = randomUUID();
        const turnId = `join_${randomUUID()}`;
        const dataDir = join(root, backendType, 'data');
        const workDir = join(root, backendType, 'work');
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        mkdirSync(workDir, { mode: 0o700 });
        process.env.SESSION_DATA_DIR = dataDir;
        const resultPath = join(workDir, 'result.json');
        const botConfig = {
          larkAppId: 'cli_live_probe_no_transport', larkAppSecret: 'not-a-live-bot-secret',
          apiOnly: true, backendType, larkToolBinding: false,
          triggerUserAuth: { enabled: true, tools: governedTools, credentialSource: 'local' },
        };
        // Freeze native baselines at automatic admission while sender-auth is
        // off, then retain that exact decision when a NEW worker installs the
        // all-three sender-auth wrappers. ownerCanary is not a turn sender.
        const admittedPolicy = normalizeToolIdentityPolicy({ ...botConfig, triggerUserAuth: undefined });
        const decision = buildAutomaticTurnDecision({ source: 'none', policy: admittedPolicy });
        demand(decision.mode === 'host' && decision.baseline?.perTurnTools.length === 0, 'admission_not_host');
        const outcomes = await publishTurnCliIdentity({
          botConfig, sessionDataDir: dataDir, sessionId, senderOpenId: undefined,
          turnId, storageModel: 'single', locale: 'en', decision,
          policy: { ...normalizeToolIdentityPolicy(botConfig), ...decision.baseline },
        });
        demand(!cancelled, 'cancelled');
        demand(outcomes.length === governedTools.length && outcomes.every(outcome => outcome.state === 'off'), 'host_publication_failed');
        const snapshots = [...governedTools, 'codebase'].map(tool => readFileSync(join(sessionIdentityDataDir(dataDir, sessionId), `${tool}.env`), 'utf8'));
        demand(snapshots.every(body => body.includes("BOTMUX_IDENTITY_MODE='host'") && body.includes(turnId)
          && !body.includes(ownerCanary) && !/TOKEN|JWT|SECRET|BOTMUX_IDENTITY_OPEN_ID/.test(body)), 'host_snapshot_not_native');
        const workerEnv = { ...process.env };
        const injected = {
          GROUP_JOIN_LIVE_RESULT_PATH: resultPath,
          GROUP_JOIN_LIVE_WRAPPER_BIN: sessionIdentityBinDir(dataDir, sessionId),
          GROUP_JOIN_LIVE_EXPECTED_HOME: originalEnv.HOME,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        };
        for (const key of ['GROUP_JOIN_LIVE_BASE_URI', 'GROUP_JOIN_LIVE_BASE_TOKEN', 'GROUP_JOIN_LIVE_TABLE_ID', 'GROUP_JOIN_LIVE_FIELD_ID']) {
          if (originalEnv[key]) injected[key] = originalEnv[key];
        }
        const child = spawnNodeTsScript(workerEntry, [], {
          env: workerEnv, cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        activeChildren.add(child);
        let identityModel;
        let spawnError = false;
        child.on('error', () => { spawnError = true; });
        child.on('message', message => {
          if (message?.type === 'session_identity_decision' && message.sessionId === sessionId) identityModel = message.model;
        });
        try {
          demand(!!child.send, 'worker_ipc_unavailable');
          child.send({
            type: 'init', ...botConfig, sessionId, turnId, ownerOpenId: ownerCanary,
            chatId: 'oc_live_probe_no_transport', rootMessageId: 'om_live_probe_no_transport',
            workingDir: workDir, cliId: 'pi', cliPathOverride: fakeCli,
            prompt: 'Run the bounded read-only authorization probe.', sandbox: false,
            envPolicy: { mode: 'inherit' }, env: injected, locale: 'en', webPort: 0,
          }, error => { if (error) spawnError = true; });
          const legDeadline = Date.now() + 100_000;
          while (!cancelled && !existsSync(resultPath) && child.exitCode === null && child.signalCode === null && !spawnError && Date.now() < legDeadline) {
            await new Promise(done => setTimeout(done, 100));
          }
          demand(!cancelled, 'cancelled');
          demand(existsSync(resultPath), spawnError ? 'worker_spawn_failed' : 'worker_probe_not_completed');
          demand(identityModel === 'single', 'worker_model_not_single');
          const report = JSON.parse(readFileSync(resultPath, 'utf8'));
          const details = { backend: backendType, ...report };
          demand(report.setupPassed, 'session_route_or_home_failed', details);
          demand(Object.values(report.wrapperPath).every(value => value !== false), 'expected_wrapper_not_installed', details);
          demand(report.larkAuth?.passed, 'lark_native_user_auth_failed', details);
          demand(report.bytedAuth?.passed, 'bytedcli_i18n_bd_native_user_auth_failed', details);
          demand(report.scopes?.passed, 'base_required_scopes_failed', details);
          demand(report.baseUrl?.queried === false || report.baseUrl?.passed, 'base_url_resolve_failed', details);
          demand(report.baseRead?.queried === false || report.baseRead?.passed, 'base_read_failed', details);
          const active = readFileSync(sessionActiveTurnPath(dataDir, sessionId), 'utf8').split('\n');
          demand(active[0] === turnId && !active[1], 'active_host_turn_changed_or_owner_became_sender');
          const denialCount = readTmuxFenceDenials(fence).length;
          demand(denialCount === 0, 'tmux_fence_denied_host_socket');
          reports.push({ backend: backendType, cliAdapter: 'pi', workerModel: identityModel,
            frozenHostPublishedBeforeWorker: true, activeTurnMatches: true, ownerFallbackAbsent: true,
            tmuxFenceDenials: denialCount, ...report });
        } finally {
          await closeWorker(child);
          activeChildren.delete(child);
        }
      }
    };
    executing = execute();
    await Promise.race([executing, aborted]);
  } finally {
    cancelled = true;
    clearTimeout(timeout);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await Promise.all([...activeChildren].map(closeWorker));
    // Await the cancelled loop before deleting its files/fence. A timed-out
    // first leg cannot race cleanup by starting a second worker afterward.
    if (executing) await executing.catch(() => {});
    const denials = readTmuxFenceDenials(fence).length;
    teardownTmuxFence(fence);
    rmSync(root, { recursive: true, force: true });
    if (denials) throw new ProbeFailure('tmux_fence_denied_host_socket');
  }
  process.stdout.write(JSON.stringify({ passed: true, reports }) + '\n');
}

if (process.argv[2] === '--stub-cli') runCliStub();
else await main().catch(error => {
  // Raw errors can include command argv, URLs and credential provider output.
  process.stderr.write(JSON.stringify({ passed: false,
    reason: error instanceof ProbeFailure ? error.code : 'unexpected_error_redacted',
    ...(error instanceof ProbeFailure && error.details ? { details: error.details } : {}) }) + '\n');
  process.exitCode = 1;
});
