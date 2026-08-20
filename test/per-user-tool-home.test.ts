import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ISOLATED_TOOL_HOME_RELPATHS,
  toolHomesRootDir,
  toolHomePath,
  resolveToolAuthIdentity,
  sanitizeIdentitySegment,
  normalizeToolHomeRelPath,
  planToolHomeMirror,
  perUserToolAuthEnabled,
  type ToolHomeMirrorAction,
} from '../src/core/per-user-tool-home.js';

describe('resolveToolAuthIdentity()', () => {
  it('prefers union_id over open_id', () => {
    expect(resolveToolAuthIdentity({ ownerUnionId: 'on_u', ownerOpenId: 'ou_o' })).toBe('on_u');
  });
  it('falls back to open_id when no union_id', () => {
    expect(resolveToolAuthIdentity({ ownerOpenId: 'ou_o' })).toBe('ou_o');
    expect(resolveToolAuthIdentity({ ownerUnionId: '  ', ownerOpenId: 'ou_o' })).toBe('ou_o');
  });
  it('returns undefined for an ownerless session', () => {
    expect(resolveToolAuthIdentity({})).toBeUndefined();
    expect(resolveToolAuthIdentity({ ownerUnionId: '', ownerOpenId: '  ' })).toBeUndefined();
  });
});

describe('sanitizeIdentitySegment()', () => {
  it('passes real Feishu ids through verbatim', () => {
    expect(sanitizeIdentitySegment('on_1a2b3c')).toBe('on_1a2b3c');
    expect(sanitizeIdentitySegment('ou_ABC.def-9')).toBe('ou_ABC.def-9');
  });
  it('hashes anything with an unsafe path char', () => {
    const out = sanitizeIdentitySegment('a/../../etc/passwd');
    expect(out).toMatch(/^id-[a-f0-9]{32}$/);
    expect(out).not.toContain('/');
  });
  it('hashes all-dots traversal segments', () => {
    expect(sanitizeIdentitySegment('..')).toMatch(/^id-[a-f0-9]{32}$/);
    expect(sanitizeIdentitySegment('.')).toMatch(/^id-[a-f0-9]{32}$/);
  });
  it('is stable for the same input', () => {
    expect(sanitizeIdentitySegment('a b')).toBe(sanitizeIdentitySegment('a b'));
  });
});

describe('toolHomePath()', () => {
  it('nests the sanitized identity under tool-homes/', () => {
    expect(toolHomesRootDir('/home/u/.botmux')).toBe('/home/u/.botmux/tool-homes');
    expect(toolHomePath('/home/u/.botmux/', 'on_x')).toBe('/home/u/.botmux/tool-homes/on_x');
  });
});

describe('normalizeToolHomeRelPath()', () => {
  it('strips ~/ and leading/trailing slashes', () => {
    expect(normalizeToolHomeRelPath('~/.lark-cli')).toEqual(['.lark-cli']);
    expect(normalizeToolHomeRelPath('/.config/larkdev/')).toEqual(['.config', 'larkdev']);
    expect(normalizeToolHomeRelPath('.local/share/bytedcli')).toEqual(['.local', 'share', 'bytedcli']);
  });
  it('rejects empty / dot / traversal segments', () => {
    expect(normalizeToolHomeRelPath('')).toBeNull();
    expect(normalizeToolHomeRelPath('   ')).toBeNull();
    expect(normalizeToolHomeRelPath('../etc')).toBeNull();
    expect(normalizeToolHomeRelPath('.config/../../etc')).toBeNull();
    expect(normalizeToolHomeRelPath('a/./b')).toBeNull();
  });
});

describe('perUserToolAuthEnabled()', () => {
  it('defaults ON', () => {
    expect(perUserToolAuthEnabled({ env: {} })).toBe(true);
    expect(perUserToolAuthEnabled({ perBot: true, env: {} })).toBe(true);
  });
  it('per-bot false opts out', () => {
    expect(perUserToolAuthEnabled({ perBot: false, env: {} })).toBe(false);
  });
  it('env kill switch forces off regardless of per-bot true', () => {
    for (const raw of ['0', 'false', 'off', 'OFF', 'False']) {
      expect(perUserToolAuthEnabled({ perBot: true, env: { BOTMUX_PER_USER_TOOL_AUTH: raw } })).toBe(false);
    }
  });
  it('other env values keep the default', () => {
    expect(perUserToolAuthEnabled({ env: { BOTMUX_PER_USER_TOOL_AUTH: '1' } })).toBe(true);
    expect(perUserToolAuthEnabled({ env: { BOTMUX_PER_USER_TOOL_AUTH: 'on' } })).toBe(true);
  });
});

describe('planToolHomeMirror()', () => {
  const realHome = '/home/u';
  const toolHome = '/home/u/.botmux/tool-homes/on_x';

  const byKind = (actions: ToolHomeMirrorAction[], kind: 'dir' | 'symlink') =>
    actions.filter(a => a.kind === kind).map(a => a.path);

  it('symlinks ordinary entries to the real HOME and isolates tool leaves', () => {
    // Real HOME top-level: shared toolchain + agent-CLI login + one isolated tool dir.
    const fs: Record<string, string[]> = {
      '/home/u': ['.nvm', '.bashrc', '.claude', '.claude.json', '.codex', '.lark-cli', '.local', '.config'],
      '/home/u/.local': ['bin', 'share'],
      '/home/u/.local/share': ['bytedcli', 'other-tool'],
      '/home/u/.config': ['kaboo-cli', 'nvim', 'larkdev'],
    };
    const actions = planToolHomeMirror({
      realHome,
      toolHome,
      readdir: (p) => fs[p] ?? [],
    });
    const symlinks = byKind(actions, 'symlink');
    const dirs = byKind(actions, 'dir');

    // Shared: toolchain, rcfile, AND agent CLI login are symlinks to the real HOME.
    expect(symlinks).toContain(`${toolHome}/.nvm`);
    expect(symlinks).toContain(`${toolHome}/.bashrc`);
    expect(symlinks).toContain(`${toolHome}/.claude`);
    expect(symlinks).toContain(`${toolHome}/.claude.json`);
    expect(symlinks).toContain(`${toolHome}/.codex`);
    // Isolated tool leaf: a real per-identity dir, never a symlink.
    expect(dirs).toContain(`${toolHome}/.lark-cli`);
    expect(symlinks).not.toContain(`${toolHome}/.lark-cli`);
    // .local is an ancestor of .local/share/bytedcli → real dir + fine-grained mix.
    expect(dirs).toContain(`${toolHome}/.local`);
    expect(symlinks).toContain(`${toolHome}/.local/bin`);        // shared
    expect(dirs).toContain(`${toolHome}/.local/share`);          // ancestor
    expect(dirs).toContain(`${toolHome}/.local/share/bytedcli`); // isolated leaf
    expect(symlinks).toContain(`${toolHome}/.local/share/other-tool`); // shared sibling
    // .config: kaboo-cli + larkdev isolated, nvim shared.
    expect(dirs).toContain(`${toolHome}/.config/kaboo-cli`);
    expect(dirs).toContain(`${toolHome}/.config/larkdev`);
    expect(symlinks).toContain(`${toolHome}/.config/nvim`);
  });

  it('materializes isolated dirs even when absent from the real HOME', () => {
    const actions = planToolHomeMirror({
      realHome,
      toolHome,
      readdir: () => [], // empty real HOME
    });
    const dirs = byKind(actions, 'dir');
    // Every default isolated relpath's leaf dir is created under the tool home.
    for (const rel of DEFAULT_ISOLATED_TOOL_HOME_RELPATHS) {
      expect(dirs).toContain(`${toolHome}/${rel}`);
    }
    // Nothing to symlink from an empty real HOME.
    expect(byKind(actions, 'symlink')).toEqual([]);
  });

  it('honors extra isolated relpaths', () => {
    const actions = planToolHomeMirror({
      realHome,
      toolHome,
      isolatedRelPaths: ['.mytool'],
      readdir: (p) => (p === realHome ? ['.mytool', '.bashrc'] : []),
    });
    expect(byKind(actions, 'dir')).toContain(`${toolHome}/.mytool`);
    expect(byKind(actions, 'symlink')).toContain(`${toolHome}/.bashrc`);
  });

  it('emits parents before children', () => {
    const fs: Record<string, string[]> = {
      '/home/u': ['.local'],
      '/home/u/.local': ['share'],
      '/home/u/.local/share': ['bytedcli'],
    };
    const actions = planToolHomeMirror({ realHome, toolHome, readdir: (p) => fs[p] ?? [] });
    const idx = (path: string) => actions.findIndex(a => a.path === path);
    expect(idx(`${toolHome}/.local`)).toBeLessThan(idx(`${toolHome}/.local/share`));
    expect(idx(`${toolHome}/.local/share`)).toBeLessThan(idx(`${toolHome}/.local/share/bytedcli`));
  });
});
