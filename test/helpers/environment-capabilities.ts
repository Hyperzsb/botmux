import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { listeningServersOnPath, tmuxSocketPath } from '../../src/core/tmux-server-guard.js';

/** Real permission-denial fixtures based on chmod cannot work as uid 0. */
export const runningAsRoot = process.getuid?.() === 0;

/** Bun intentionally exposes a generic Linux comm name for its main thread. */
export const runningUnderBun = Boolean(process.versions.bun);

/** Node 24 on preview also names its Linux main thread `MainThread`. */
export const runtimeUsesGenericLinuxComm = (() => {
  if (process.platform !== 'linux') return false;
  try { return readFileSync('/proc/self/comm', 'utf8').trim() === 'MainThread'; }
  catch { return false; }
})();

export function commandAvailable(name: string): boolean {
  return spawnSync('/bin/sh', ['-c', 'command -v -- "$1" >/dev/null 2>&1', 'sh', name], {
    stdio: 'ignore',
    timeout: 3_000,
  }).status === 0;
}

/**
 * A private tmpfs mounted over /tmp hides a checkout that itself lives below
 * /tmp. Namespace tests that execute files from the checkout cannot run there.
 */
export function checkoutIsUnderSystemTemp(): boolean {
  try {
    const checkout = realpathSync(resolve('.'));
    const systemTemp = realpathSync(tmpdir());
    const child = relative(systemTemp, checkout);
    return child === '' || (!child.startsWith('..') && !isAbsolute(child));
  } catch {
    return false;
  }
}

/** Dash may report a missing while-loop input redirection inside `if` but still exit 0. */
export function shellIgnoresMissingLoopRedirect(): boolean {
  const missing = `/tmp/botmux-missing-redirection-${process.pid}-${Date.now()}`;
  return spawnSync('/bin/sh', [
    '-c',
    // The production shim has more work after this `if`. Dash reports the
    // redirect error but treats it as the compound command's status and keeps
    // going, so the probe also needs a trailing successful command.
    'set -e; if [ -n x ]; then while IFS= read -r line || [ -n "$line" ]; do :; done < "$1"; fi; exit 0',
    'sh',
    missing,
  ], { stdio: 'ignore', timeout: 3_000 }).status === 0;
}

/**
 * A live preview fleet owns the default tmux socket. TmuxPipeBackend's
 * anti-fork census intentionally follows that real default socket even when a
 * test PATH shim routes the tmux client to a private `-S` socket. Such real
 * tmux fixtures therefore depend on the fleet listener staying responsive and
 * deterministically time out once the full suite loads it; dedicated CI with
 * no managed default server still exercises them.
 */
export function defaultTmuxServerConflictsWithPrivateFixture(): boolean {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  const uid = process.getuid?.() ?? -1;
  // Vitest gives each file a private TMUX_TMPDIR. The backend fixtures then
  // pass an env without that variable, so their anti-fork census resolves the
  // host default (/tmp/tmux-<uid>/default), not the fenced test default. Probe
  // the same path here or collection sees an empty fence and misses the live
  // preview fleet that will make every new-session attempt time out.
  const listeners = listeningServersOnPath(tmuxSocketPath({}, uid));
  return Array.isArray(listeners) && listeners.length > 0;
}
