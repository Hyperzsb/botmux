import { homedir, userInfo } from 'node:os';

/**
 * A Botmux daemon/supervisor is host-scoped, never user-session-scoped. A
 * `botmux restart` issued from a managed CLI pane can carry the pane's
 * per-identity HOME into the detached supervisor. Normalize that boundary
 * before any module derives ~/.botmux paths or provisions another tool-home.
 */
export function normalizeBotmuxHostHome(env: NodeJS.ProcessEnv): void {
  const current = env.HOME?.trim() ?? '';
  const marker = env.BOTMUX_TOOL_HOME?.trim() ?? '';
  const isSessionHome = Boolean(
    marker
    || current.includes('/.botmux/tool-homes/')
    || current.includes('\\.botmux\\tool-homes\\'),
  );
  if (!isSessionHome) return;

  try {
    const accountHome = userInfo().homedir?.trim();
    if (accountHome) env.HOME = accountHome;
  } catch {
    const fallback = homedir();
    if (fallback) env.HOME = fallback;
  }
  // This marker is recomputed for each worker/session and must never become a
  // fleet-wide daemon input.
  delete env.BOTMUX_TOOL_HOME;
}
