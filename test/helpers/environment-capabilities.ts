import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  listeningServersOnPath,
  probeTmuxOwner,
  tmuxSocketPath,
} from '../../src/core/tmux-server-guard.js';

/** Real permission-denial fixtures based on chmod cannot work as uid 0. */
export const runningAsRoot = process.getuid?.() === 0;

/** Bun intentionally exposes a generic Linux comm name for its main thread. */
export const runningUnderBun = Boolean(process.versions.bun);

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

/** Dash may report a missing while-loop input redirection but still exit 0. */
export function shellIgnoresMissingLoopRedirect(): boolean {
  const missing = `/tmp/botmux-missing-redirection-${process.pid}-${Date.now()}`;
  return spawnSync('/bin/sh', [
    '-c',
    'set -e; while IFS= read -r line || [ -n "$line" ]; do :; done < "$1"',
    'sh',
    missing,
  ], { stdio: 'ignore', timeout: 3_000 }).status === 0;
}

/**
 * The preview fleet owns the default socket in another PID namespace. Real
 * tmux fixtures must not wait through the anti-fork timeout in that shape.
 */
export function defaultTmuxListenerIsUnreachable(): boolean {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  const owner = probeTmuxOwner();
  if (owner.kind === 'reachable' || owner.kind === 'no-server') return false;
  const uid = process.getuid?.() ?? -1;
  const listeners = listeningServersOnPath(tmuxSocketPath(process.env, uid));
  return Array.isArray(listeners) && listeners.length > 0;
}
