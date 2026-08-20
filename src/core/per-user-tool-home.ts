/**
 * Per-user CLI-tool auth isolation (HOME override).
 *
 * PROBLEM: when several Feishu users drive the SAME bot, every topic's agent CLI
 * runs auxiliary tools (`bytedcli`, `lark-cli`, `larkdev`, …) that authenticate
 * against the ONE host user account — so user A's `bytedcli auth login` session
 * is what user B's agent silently reuses (and vice-versa). The tools key their
 * auth off `$HOME`, and botmux hands every session the same host HOME.
 *
 * MODEL (per-user HOME override): give each session's CLI child (and every Bash
 * subprocess it spawns) a per-identity HOME under `<botmuxHome>/tool-homes/<id>`,
 * where `<id>` is the session owner's Lark identity (union_id, falling back to
 * app-scoped open_id). The per-identity HOME is a MIRROR of the real host HOME —
 * every top-level entry is symlinked back to the real one so PATH / rcfiles /
 * toolchains (nvm / pnpm / fnm) and the AGENT CLI's own login (`~/.claude`,
 * `~/.codex`, …) stay SHARED — EXCEPT a small allowlist of tool auth dirs
 * ({@link DEFAULT_ISOLATED_TOOL_HOME_RELPATHS}) which are left as fresh, real,
 * per-identity directories. A tool resolving its auth under `$HOME/<tool dir>`
 * therefore lands in the caller's own per-identity slot: different users get
 * different auth sessions; the same user reuses one across all their topics.
 *
 * This is INDEPENDENT of the file sandbox / read-isolation: those set their own
 * canonical HOME and enforce a Seatbelt/bwrap boundary, so the HOME override
 * applies only to plain (non-sandboxed) sessions. It is a per-user convenience
 * boundary, NOT a security boundary — the agent has a full shell and could still
 * read the real HOME through a symlink; combine with the sandbox for hard
 * isolation.
 *
 * This module is PURE except for the small provisioner at the bottom, so the
 * identity derivation and the mirror planner are fully unit-testable.
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Auth dirs (relative to HOME) that must become per-identity rather than shared.
 * Everything NOT under one of these stays a symlink to the real HOME, so PATH /
 * rcfiles / toolchains and the agent CLI's own login are untouched.
 *
 * The list is an ALLOWLIST of auxiliary developer tools that keep a login/token
 * under HOME. A tool is isolated ONLY if its auth dir appears here (directly or
 * via a per-bot extension) — add new tools here (or via `extraRelPaths`) to
 * cover them. Paths are normalized (leading `~/` / `/` stripped, `..` rejected).
 */
export const DEFAULT_ISOLATED_TOOL_HOME_RELPATHS: readonly string[] = [
  // bytedcli (unified ByteDance R&D CLI): stores `bytecloud-auth` + skill lock
  // under its data home `~/.local/share/bytedcli` (no XDG_DATA_HOME branch).
  '.local/share/bytedcli',
  // ByteCloud config-style CLIs (kaboo-cli / aiden-cli / cjadk) resolve their
  // base via Go's os.UserConfigDir → `~/.config/<cli>` on Linux.
  '.config/kaboo-cli',
  '.config/aiden-cli',
  '.config/cjadk',
  // …and their home dot-dir layouts.
  '.cjadk',
  '.aipaas',
  // lark-cli (Feishu/Lark developer CLI): auth + per-app store.
  '.lark-cli',
  '.lark-cli-bots',
  // larkdev (Lark developer CLI) — cover both dot-dir and XDG config layouts.
  '.larkdev',
  '.config/larkdev',
];

/** Directory that holds every per-identity tool HOME: `<botmuxHome>/tool-homes`. */
export function toolHomesRootDir(botmuxHome: string): string {
  return join(botmuxHome.replace(/\/+$/, ''), 'tool-homes');
}

/**
 * A per-identity HOME path: `<botmuxHome>/tool-homes/<safeId>`. `safeId` is the
 * sanitized owner identity ({@link sanitizeIdentitySegment}). Same identity →
 * same HOME (auth reused); different identity → different HOME (isolated).
 */
export function toolHomePath(botmuxHome: string, identity: string): string {
  return join(toolHomesRootDir(botmuxHome), sanitizeIdentitySegment(identity));
}

/**
 * Resolve the owner identity that keys the per-identity HOME. Prefer the
 * tenant-stable `union_id` (`on_…`, same human across every bot app), else the
 * app-scoped `open_id` (`ou_…`). Returns undefined for an ownerless / foreign-bot
 * session, where there is no user to isolate per — the caller then keeps the
 * shared host HOME.
 */
export function resolveToolAuthIdentity(input: {
  ownerUnionId?: string;
  ownerOpenId?: string;
}): string | undefined {
  const union = input.ownerUnionId?.trim();
  if (union) return union;
  const open = input.ownerOpenId?.trim();
  if (open) return open;
  return undefined;
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Turn an owner identity into a safe single path segment. Real Feishu ids
 * (`on_…` / `ou_…`) already match the safe class and pass through verbatim (so
 * the dir is human-recognizable); anything else — or an all-dots traversal
 * segment — is replaced by a stable sha256 hex so it can never escape
 * `tool-homes/`.
 */
export function sanitizeIdentitySegment(identity: string): string {
  const trimmed = identity.trim();
  if (trimmed && SAFE_SEGMENT_RE.test(trimmed) && !/^\.+$/.test(trimmed)) {
    return trimmed;
  }
  return `id-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

/** Normalize an isolated rel-path: strip leading `~/` and `/`, drop trailing
 *  slashes, split into segments, reject empty / `.` / `..`. Returns null for
 *  anything unusable (a silently-ignored bad path is a fail-open trap). */
export function normalizeToolHomeRelPath(raw: string): string[] | null {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;
  t = t.replace(/^~(?=\/)/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!t) return null;
  const segs = t.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return null;
  }
  return segs;
}

export interface ToolHomeMirrorAction {
  /** 'dir' → create a real (per-identity) directory; 'symlink' → link to real HOME. */
  kind: 'dir' | 'symlink';
  /** Absolute path INSIDE the per-identity tool HOME. */
  path: string;
  /** For 'symlink': absolute path in the REAL host HOME to point at. */
  target?: string;
}

interface RelPathTrieNode {
  /** This node terminates an isolated rel-path (a leaf to keep per-identity). */
  isolated: boolean;
  children: Map<string, RelPathTrieNode>;
}

function buildRelPathTrie(relPaths: readonly string[]): RelPathTrieNode {
  const root: RelPathTrieNode = { isolated: false, children: new Map() };
  for (const raw of relPaths) {
    const segs = normalizeToolHomeRelPath(raw);
    if (!segs) continue;
    let node = root;
    for (const seg of segs) {
      let next = node.children.get(seg);
      if (!next) {
        next = { isolated: false, children: new Map() };
        node.children.set(seg, next);
      }
      node = next;
    }
    node.isolated = true;
  }
  return root;
}

/**
 * Plan the per-identity HOME mirror. PURE — the caller injects `readdir` (entry
 * names of an absolute dir, or `[]` when it is missing / not a directory).
 *
 * For each real-HOME entry:
 *  - an isolated LEAF (in the allowlist) → a real per-identity `dir` (the tool
 *    writes fresh auth there); never symlinked, never recursed.
 *  - an ANCESTOR of an isolated leaf (e.g. `.local` above `.local/share/bytedcli`)
 *    → a real `dir`, then recurse so its non-isolated children can be symlinked
 *    at a finer grain (`.local/bin` stays shared, `.local/share/bytedcli` doesn't).
 *  - anything else → a `symlink` to the real entry (shared).
 *
 * Ancestor dirs that don't yet exist in the real HOME are still materialized (so
 * a tool can create its fresh auth dir under them). Actions are returned
 * parents-before-children so the provisioner can apply them in order.
 */
export function planToolHomeMirror(input: {
  realHome: string;
  toolHome: string;
  isolatedRelPaths?: readonly string[];
  readdir: (absPath: string) => string[];
}): ToolHomeMirrorAction[] {
  const realHome = input.realHome.replace(/\/+$/, '');
  const toolHome = input.toolHome.replace(/\/+$/, '');
  const trie = buildRelPathTrie(input.isolatedRelPaths ?? DEFAULT_ISOLATED_TOOL_HOME_RELPATHS);
  const actions: ToolHomeMirrorAction[] = [];

  const walk = (realDir: string, toolDir: string, node: RelPathTrieNode): void => {
    const seen = new Set<string>();
    for (const name of input.readdir(realDir)) {
      if (name === '.' || name === '..' || seen.has(name)) continue;
      seen.add(name);
      const childReal = join(realDir, name);
      const childTool = join(toolDir, name);
      const childNode = node.children.get(name);
      if (childNode?.isolated) {
        // Isolated leaf — a fresh per-identity dir; do not link or recurse.
        actions.push({ kind: 'dir', path: childTool });
        continue;
      }
      if (childNode && childNode.children.size > 0) {
        // Ancestor of an isolated leaf — real dir + recurse for fine-grained mix.
        actions.push({ kind: 'dir', path: childTool });
        walk(childReal, childTool, childNode);
        continue;
      }
      actions.push({ kind: 'symlink', path: childTool, target: childReal });
    }
    // Ancestor/leaf dirs that the real HOME does not (yet) contain still need to
    // exist so the tool can create its fresh auth under them.
    for (const [name, childNode] of node.children) {
      if (seen.has(name)) continue;
      const childReal = join(realDir, name);
      const childTool = join(toolDir, name);
      actions.push({ kind: 'dir', path: childTool });
      if (!childNode.isolated && childNode.children.size > 0) {
        walk(childReal, childTool, childNode);
      }
    }
  };

  walk(realHome, toolHome, trie);
  return actions;
}

/** Whether per-user tool-auth isolation is enabled for this session. Global
 *  default ON; the `BOTMUX_PER_USER_TOOL_AUTH` kill switch (`0`/`false`) forces
 *  OFF fleet-wide; a per-bot `perUserToolAuth` value overrides the default
 *  (true = force on, false = force off, undefined = follow the default). */
export function perUserToolAuthEnabled(input: {
  perBot?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const raw = (input.env ?? process.env).BOTMUX_PER_USER_TOOL_AUTH?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (input.perBot === false) return false;
  return true; // default ON (per-bot true or unset both resolve here)
}

/**
 * Provision the per-identity tool HOME on disk from {@link planToolHomeMirror}
 * and return its absolute path (to set as the child's `$HOME`), or null when the
 * mirror cannot be established (never fall back silently to a shared login on an
 * explicit-isolation request — the caller decides). Idempotent + self-healing:
 * runs on every cold spawn, repairs stale/missing symlinks, and NEVER removes an
 * isolated per-identity auth dir (a re-login persists across spawns).
 */
export function provisionToolHome(input: {
  realHome: string;
  botmuxHome: string;
  identity: string;
  extraRelPaths?: readonly string[];
  log?: (message: string) => void;
}): string | null {
  const realHome = (() => {
    try { return realpathSync(input.realHome); } catch { return input.realHome.replace(/\/+$/, ''); }
  })();
  const toolHome = toolHomePath(input.botmuxHome, input.identity);
  const isolatedRelPaths = [
    ...DEFAULT_ISOLATED_TOOL_HOME_RELPATHS,
    ...(input.extraRelPaths ?? []),
  ];
  try {
    mkdirSync(toolHome, { recursive: true });
    const actions = planToolHomeMirror({
      realHome,
      toolHome,
      isolatedRelPaths,
      readdir: (absPath) => {
        try { return readdirSync(absPath); } catch { return []; }
      },
    });
    for (const action of actions) {
      if (action.kind === 'dir') {
        // Never clobber an existing per-identity auth dir; recursive mkdir is
        // idempotent for the ancestor chain.
        try {
          if (!pathExistsNoFollow(action.path)) mkdirSync(action.path, { recursive: true });
        } catch { /* best-effort; a failed ancestor just means the tool re-creates it */ }
        continue;
      }
      applySymlink(action.path, action.target!);
    }
    return toolHome;
  } catch (err) {
    input.log?.(`[per-user-tool-home] WARN could not provision ${toolHome}: ${(err as Error).message}`);
    return null;
  }
}

function pathExistsNoFollow(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Create/repair a symlink `path -> target`. Leaves an existing REAL file/dir
 *  (unexpected for a non-isolated entry) untouched — never destroys user data. */
function applySymlink(path: string, target: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      let current: string | undefined;
      try { current = readlinkSync(path); } catch { /* re-link below */ }
      if (current === target) return; // already correct
      try { unlinkSync(path); } catch { return; }
    } else {
      // A real dir/file already sits here (e.g. a shadowing ancestor we manage);
      // leave it — do not risk removing real content.
      return;
    }
  } catch { /* missing → create below */ }
  try { symlinkSync(target, path); } catch { /* best-effort */ }
}
