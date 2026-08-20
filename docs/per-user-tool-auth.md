# 按用户隔离 CLI 工具鉴权（per-user tool auth）

同一个 bot 被多个飞书用户使用时，agent 在会话里跑的辅助 CLI 工具（`bytedcli` / `lark-cli` / `larkdev` 等）默认都读同一份宿主账号的登录态——用户 A 的 `bytedcli auth login` 会被用户 B 的 agent 悄悄复用，反之亦然。本特性给每个会话的 CLI 子进程一个**按会话 owner 身份隔离的 HOME**，让这些工具的鉴权按人分开。

## 一分钟原理

- 工具靠 `$HOME` 定位自己的登录态（`~/.local/share/bytedcli`、`~/.lark-cli`、`~/.larkdev` …）。botmux 给会话 CLI 子进程一个 **per-identity HOME**：`<botmuxHome>/tool-homes/<身份>`。
- 这个 per-identity HOME 是真实 HOME 的**镜像**——每个顶层项都 symlink 回真实 HOME，所以 PATH / rcfile / 工具链（nvm/pnpm/fnm）**和 agent CLI 自己的登录**（`~/.claude`、`~/.codex`、`~/.grok`…）保持**共用不变**；**只有**一小撮工具鉴权目录（见下「隔离清单」）留成**全新的 per-identity 真实目录**。
- 于是工具在 `$HOME/<工具目录>` 下找鉴权时，落到调用者自己的那份：不同用户各自独立，同一用户在自己所有话题间复用一份登录。
- 身份 key = `union_id`（`on_…`，同一个人跨 bot 稳定），无则回退 app 作用域的 `open_id`（`ou_…`）。ownerless / 外部 bot 会话没有可隔离的人 → 保持共用宿主 HOME（行为与开特性前一致）。

> ⚠️ 这是**便利边界，不是安全边界**：agent 有完整 shell，能顺着 symlink 读回真实 HOME。要硬隔离请开[文件沙盒](file-sandbox.md) / [读隔离](isolated-bot-deploy.md)——那两个会设自己的规范 HOME + Seatbelt/bwrap 内核边界，本 HOME 覆盖在它们生效时**自动让路**（互斥，不叠加）。

## 开关

**默认全局开**。三档控制：

- **全局 kill switch**：环境变量 `BOTMUX_PER_USER_TOOL_AUTH=0`（或 `false`/`off`）整机关闭。其它值 / 未设 = 开。
- **per-bot 覆盖**（`bots.json` / dashboard / `/config`）：
  - `"perUserToolAuth": false` — 单独把这个 bot 关掉（该 bot 的所有用户共用一份工具登录）。
  - `"perUserToolAuth": true` / 不设 — 跟随全局默认。
- **追加隔离目录**：`"perUserToolAuthPaths": [".mytool", ".config/foo"]` —— 在内置清单之外再隔离自定义工具的鉴权目录（HOME 相对路径，`~/`、`/` 前缀会被剥掉，禁 `..`）。

```json
{
  "larkAppId": "cli_teamA",
  "cliId": "claude-code",
  "perUserToolAuth": true,
  "perUserToolAuthPaths": [".mytool"]
}
```

也可在 dashboard 的「Bot 配置」或 `/config set perUserToolAuth on|off` / `/config set perUserToolAuthPaths .mytool` 热改（下个新会话生效）。

## 隔离清单（哪些目录 per-identity，其余全共用）

内置 `DEFAULT_ISOLATED_TOOL_HOME_RELPATHS`（见 `src/core/per-user-tool-home.ts`）：

| 工具 | HOME 相对目录 |
|---|---|
| bytedcli | `.local/share/bytedcli` |
| ByteCloud 系（kaboo-cli / aiden-cli / cjadk） | `.config/kaboo-cli`、`.config/aiden-cli`、`.config/cjadk`、`.cjadk`、`.aipaas` |
| lark-cli | `.lark-cli`、`.lark-cli-bots` |
| larkdev | `.larkdev`、`.config/larkdev` |

清单外的一切（含 agent CLI 登录 `~/.claude`/`~/.codex`/`~/.grok`、PATH/rcfile、工具链）都 symlink 回真实 HOME——**共用不变**。新工具用 `perUserToolAuthPaths` 追加。

## 生效范围与后端

- 仅对**非沙盒、非 adopt、有 owner 身份**的会话生效。
- pty 后端：HOME 直接进子进程 env。
- 持久后端（tmux/zellij/zmx）：HOME 经每 pane 的 `/usr/bin/env` 前缀在 rcfile 加载**之后**注入（pane 登录 shell 会用 OS 账号重置 HOME，所以只能后置注入才权威）；worker 用 `BOTMUX_TOOL_HOME` 标记透传，`buildBotmuxEnvAssignments` 末尾再补一记 `HOME=<toolHome>`。

## 验证

```bash
# 让两个不同飞书用户各在同一个 bot 下开一个会话，各自 bytedcli auth login。
# 然后在部署机上看每个会话的 HOME 指向不同的 tool-homes 子目录：
ls -la ~/.botmux/tool-homes/            # 每个用户身份一个目录
ls -la ~/.botmux/tool-homes/on_*/       # 顶层多为 symlink，隔离清单里的是真实目录
# 隔离目录各自独立、其余 symlink 回真实 HOME：
readlink ~/.botmux/tool-homes/on_*/.nvm            # → /home/<user>/.nvm（共用）
readlink ~/.botmux/tool-homes/on_*/.claude         # → /home/<user>/.claude（agent 登录共用）
stat ~/.botmux/tool-homes/on_*/.local/share/bytedcli  # 真实目录（per-identity，不是 symlink）
```

单测：`test/per-user-tool-home.test.ts`（身份推导 / 清洗 / 镜像规划 / 开关）、`test/tmux-backend-env.test.ts`（`HOME=` 注入）、`test/per-bot-env.test.ts`（`HOME` 拒绝进 per-bot env）。

## 回滚

删掉 bot 的 `"perUserToolAuth": false` 恢复跟随默认；或整机 `BOTMUX_PER_USER_TOOL_AUTH=0` 关闭。`tool-homes/` 目录留着无害（下次开特性自愈）。
