# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Antigravity / Grok / Pi 等 20+ 种，完整列表见 README）。

本仓库是面向业务维护的 fork。本文统一记录开发、验证、部署与协作约定。
`AGENTS.md` 是指向 `CLAUDE.md` 的符号链接，两者共享本文；更新指南时编辑正文并保留该链接。

## 本 fork 的环境与分支约定

### 环境清单

| 环境 | ByteBox IPv6 地址 | 运行分支 | 用途 |
|---|---|---|---|
| online | `2605:340:cd52:700:4b1d:5870:1031:4ba0` | `feat/byte_approval/release` | 业务线上部署 |
| preview | `2605:340:cd52:700:bf87:dee0:bd61:d0ef` | `feat/byte_approval/dev` | 日常开发与不稳定改动验证 |

- 代码开发可以在本地进行，但是任何编译和测试都要在 preview 机器上执行，以节约本地资源。
- **默认发布/部署分支是 `feat/byte_approval/release`**，也是本 fork 的 GitHub 默认分支。online 的 Botmux 必须始终从该分支的 checkout 构建、认领全局命令并启动。
- **默认开发分支是 `feat/byte_approval/dev`**。不稳定的功能改动在该分支开发，日常运行与人工验证使用 preview；验证完成后再将准备上线的改动集成到 release。
- 部署前确认目标机器、实际 checkout、当前分支、提交和工作区状态。保护已有未提交改动；不要将 online 切到 dev、临时 review 分支或即将删除的 worktree。
- 远端名称按各机器的 `git remote -v` 确认，不能假设 `origin` 一定指向本 fork；本 fork 的业务部署分支与上游 npm 发版所用的 `master` 是不同约定。

### Preview / Online 远程交互（最小流程）

两台 ByteBox 都通过 `jump.byted.org` 登录，且每天都需要用户人工申请/审批访问权限。此前登录成功不代表当天权限仍有效。

每个任务对每台目标机最多开启一个 interactive SSH Panel；同一任务的所有命令复用这条 PTY，不为每条命令重复登录。Agent 必须在非 Sandbox 的 TTY 中启动 SSH，进入目标机后再把命令逐条作为键盘输入发送，等待提示符返回后再发下一条。

```bash
# preview
ssh -K -tt -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 jump.byted.org ssh -6 root@2605:340:cd52:700:bf87:dee0:bd61:d0ef

# online
ssh -K -tt -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 jump.byted.org ssh -6 root@2605:340:cd52:700:4b1d:5870:1031:4ba0
```

第二跳必须保持 `ssh -6 user@ip` 的简单形态；不要给内层 SSH 添加选项，也不要把构建、测试或部署命令拼在 SSH 命令尾部。keepalive 只减少空闲断线，不会自动重连或绕过每日审批。连接失败时说明是 preview 还是 online、保留原始错误，并提醒用户申请或续期当天权限；不能改去另一台机器继续。

#### 默认：短任务直接使用 SSH

查询 Hash、状态、日志、配置或执行其它分钟级操作时，不进入 tmux：

1. 登录后先确认 `hostname`；只读查询再确认目标路径即可。
2. 写代码、构建、重启或部署前，再确认 `pwd`、分支、`git rev-parse HEAD` 和 `git status --short`，保护已有未提交改动。
3. 在同一 PTY 中逐条执行命令；任务完成后按下文统一收尾。

#### 仅需断线续跑时使用 tmux

全量测试、长构建、迁移或其它必须在 SSH 断开后继续的任务，才进入独立维护 server；普通只读查询和短命令不要使用 tmux。

```bash
# 先查看现状；无 server 时的报错可忽略
tmux -L botmux-maint list-sessions -F '#{session_name} attached=#{session_attached} windows=#{session_windows}'

# preview
tmux -L botmux-maint new-session -A -s preview-dev

# online
tmux -L botmux-maint new-session -A -s online-release
```

- 只使用固定会话名；禁止按日期、任务或重连次数新建 session，也不要触碰 Botmux fleet 的 `-L botmux` server。
- 若固定会话显示 `attached=1`、存在其它名字或用途不明的 pane，停止并先协调；不要用 `-d`、`send-keys`、`kill-session` 或 `kill-server` 猜测处理。
- SSH 断开后重新登录并 attach 同名会话，先确认原 job 状态，不要重复启动。
- 只有在 `list-sessions` 明确无 server、`pgrep -af botmux-maint` 无输出且精确 socket 仍阻塞启动时，才删除 `/tmp/tmux-0/botmux-maint`；禁止 glob。

#### 统一收尾

- 直接 SSH：清理本任务的临时文件和后台 job，然后从目标机 shell 正常 `exit`。
- 使用 tmux：先运行 `jobs -l`。任务已完成时，正常退出本任务创建的 pane/shell；任务仍需续跑时才 `Ctrl-b d`，并在最终答复说明保留原因。只 attach 到既有现场时不得关闭用途不明的 pane。
- 回到外层后 `exit`，等待 JumpServer SSH 与工具 PTY/session 结束。每个任务结束前必须关闭该任务创建的全部 SSH Panel，不能只关闭可见界面或把长运行 exec 留在后台。
- 若工具调用中断或 PTY 丢失，只按本任务记录的精确 session id、PID、JumpServer 和目标地址发送 `TERM`，并确认 SSH 进程及其终端 wrapper 均已消失。禁止模糊 `pkill`，不得关闭 Flux 隧道、其它任务或用户已有连接。

### IPv6 兼容

两台机器对外只有 IPv6。涉及 Dashboard URL、跳转 URL、Web 终端、回调或服务对外地址的配置与改动，都必须支持 IPv6，不能依赖 IPv4 对外地址。

- URL 中的 IPv6 字面地址必须加方括号，例如 `http://[2605:340:cd52:700:4b1d:5870:1031:4ba0]:7891/`；主机地址与端口分别处理，不能用简单的 `split(':')` 解析。
- URL 的构造与解析复用现有工具（例如 `src/core/dashboard-url.ts` 的 `formatUrlHost`）及 `URL` API，避免重复拼接方括号或丢失端口、路径、查询参数。
- 修改相关配置/链接逻辑时，在 preview 验证生成的 IPv6 链接可实际访问，并保留现有 IPv4/域名场景的兼容性。SSH 命令中的裸地址与 URL 的方括号格式应分别处理。

## 影响范围评估（改前必做）

任何改动落地前，先想清楚它波及的**其它平台、其它 CLI、其它会话类型**——本仓库是多 CLI × 多后端 × 多 IM 的横向架构，一处改动很容易踩到共用代码路径。默认「牵一发动全身」，主动排查回归面，别只测自己那条路。

- **跨平台**：改了 macOS 相关逻辑要同时考虑 Linux（daemon 实际跑在 Linux）；涉及路径、shell、进程、PTY、编码的代码尤其要两边都想到
- **跨 CLI**：改某个 CLI 适配器时，确认没动到 `adapters/cli/` 的共用基类/工具（`shared-hints`、`runner-input`、`registry` 等）或 worker 侧共用逻辑，否则可能连带影响其它 20+ 个 CLI。共用改动要在至少一个「别的 CLI」上验证仍可用
- **跨后端 / 跨会话类型**：改动涉及 `PtyBackend` vs `TmuxBackend`、话题会话 vs 群会话 vs adopt/restore、sandbox on vs off、v3 workflow vs 普通会话时，逐一核对受影响的组合
- **改公共层**（`core/`、`config.ts`、`bot-registry.ts`、`im/lark/`）时影响面最大——PR 描述里写清评估结论：动了什么共用路径、哪些平台/CLI/会话类型受影响、各自怎么验证的

## 构建 & 运行

```bash
bun run build                # tsc 编译
bun run daemon:restart       # 重启 daemon（自动恢复 active sessions）
bun run daemon:logs          # 查看日志
```

- 影响运行的代码或配置改动完成后，在目标环境执行 `bun run build`，再执行 `bun run daemon:restart`；日常开发默认在 preview/dev 验证，online 只运行 release。
- 仅文档或开发指南变更不需要为此重启 daemon。重启后检查实际进程和日志，确认预期 Bot 与 Dashboard 在线，不能只依赖 CLI 打印成功。
- `CI=1` 等仅用于构建/测试的临时环境变量不要带入 daemon 或交互式 CLI 的运行环境。

⚠️ **别用裸 `node` 起 daemon —— 用 `bun run daemon:*`。** 会话存储硬依赖 SQLite 引擎
（`node:sqlite` 需 Node ≥ 22.13，或任意 bun 的 `bun:sqlite`），而裸 `node` 由 exec 时的
PATH 解析，那不是写它的环境：2026-09-08 某次 restart 的 PATH 把 `/usr/bin` 排在 fnm shim
之前 ⟹ 解析成 v18.20.4 ⟹ **55 个 bot daemon 全部启动即崩**，飞书里所有话题看似全丢（57 个
SQLite 库其实完好）。**supervisor 自身不需要 SQLite，所以它照常打印「✅ daemon 已重启」**
—— 这个失败形状是记在这里的唯一理由：报成功、孩子全灭，看日志前无从分辨。
现在 preflight 会在**拆掉现有 fleet 之前**按引擎能力拒绝（逃生阀 `BOTMUX_INTERPRETER=<abs>`）。

**包管理器是 bun**，版本以当前分支 `package.json` 的 `packageManager` 为准（当前分支为 `bun@1.4.4`，锁文件 `bun.lock`）。切换分支后先核对版本与依赖，再按下文的 worktree 约束决定安装位置；装依赖用 `bun install --frozen-lockfile`。

⚠️ `trustedDependencies: ["electron","node-pty"]` **不能删**：bun 默认**不跑依赖的生命周期脚本**，而 `node-pty` 要靠它 `node-gyp` 编出 `build/Release/pty.node` —— 少了这个，PTY 全废、编译版二进制也打不出来（`pty.node` 是被嵌进去的）。electron 的 postinstall 负责下载对应平台的二进制。

这个名单**刻意只有两项**（与 pnpm 时代的 `onlyBuiltDependencies` 逐字一致），别照着"顺手补全"往里加 esbuild —— 实测 esbuild 虽然有 postinstall，但它的二进制由 `@esbuild/<platform>` 平台包直接提供：空白目录里 `bun install esbuild` 不跑任何脚本，`esbuild --version` 照样输出 0.28.2。加进白名单只会让 bun 比 pnpm 多跑脚本、扩大两者的行为差异，与迁移目标相反。

注意与「用户怎么装 botmux」区分开：`install-diagnostics.ts` 的 `InstallKind`（含 `'pnpm-global'`）与 `maintenance.ts` 的自动更新说的是**终端用户的安装方式**，线上确实有人 `pnpm i -g botmux`。那些**不是**本仓库的构建工具链，不要跟着一起改。

### Bun 开发链路

daemon / supervisor / dashboard 都能直接跑 TypeScript，不必先 `bun run build`：

```bash
bun run daemon:bun           # bun src/index-daemon.ts
bun run supervisor:bun       # bun src/index-supervisor.ts
bun run dashboard:bun        # bun src/index-dashboard.ts
bun run build:bun            # 打自包含单文件二进制（scripts/build-bun-binary.mjs）
```

发版编译用的 Bun 版本**钉在 1.4.4**，唯一来源是 `package.json` 的 `packageManager`（`.github/workflows/` 各处与它一致，`test/release-darwin-codesign-gate.test.ts` 守着）。本地 bun 与它不一致时，编译产物、bun.lock 重写、`bun test` 的行为可能和 CI 不一致：`bun run build` 与 `scripts/build-bun-binary.mjs` 开头会比对并**告警（不拦截）**，见 `scripts/check-bun-version.mjs`。对齐用告警给出的官方安装命令装指定版本——它解压到同目录再 `mv` 换 inode，fleet 正跑着的 bun 进程不受影响。

**测试里 spawn 子进程必须走 `test/helpers/ts-runner.ts`**，不要写 `spawn(process.execPath, ['--import','tsx', …])`：那是 Node-only 形态，Bun 下 `process.execPath` 是 bun 二进制、`bun --import tsx` 不合法，子进程会全部起不来。helper 按运行时解析（Node 加 tsx loader、Bun 原生跑 TS）。片段里 import 仓库模块（`.js` specifier 实际是 `.ts`）时用 `spawnTsEvalWithRepoImports`，普通 `spawnTsEval` 在 Node 下会 ERR_MODULE_NOT_FOUND。

**临时探针 / 变异脚本 / 自写的 vitest 配置一律套 `bun scripts/fenced-run.ts -- -- <命令>`。** 使用当前钉定的 Bun 运行 `.ts` 脚本时，第一个 `--` 会被 Bun 自己消费，第二个才会进入 `fenced-run`；尤其子命令自己还带 `--`（如 `bun run test -- <files>`）时，少一个分隔符会让围栏报 `unknown option(s)`，并以退出码 2 结束。变异复验不能只看非零退出码，必须检查日志确认子测试实际启动且因预期行为断言失败。仓库的 HOME 围栏和 tmux 围栏只挂在 `vitest.config.ts` 与 `bunfig.toml` 上：`bun /tmp/probe.ts` 直接调真实模块、或自写一个不带 setupFiles 的 vitest 配置，都**没有围栏**，会写真实 `~/.botmux`、`~/.config/systemd/user` 和 fleet 的 `-L botmux` tmux。2026-11-06 一个评审探针不带 HOME 调了 `enableAutostart()`，把真实 botmux.service / watchdog 改成 `ExecStart=/opt/botmux`，崩溃守护静默失效 5 小时。fenced-run 给子进程临时 HOME、私有 TMUX_TMPDIR + 拒绝宿主 socket 的 tmux shim、把 SESSION_DATA_DIR 指到临时 HOME 并清掉继承的会话身份标记和 daemon IPC 端口，并默认去掉 user bus（`systemctl --user` 碰不到真实 user manager；botmux 的 scope 代码看到 `BOTMUX_FENCED_RUN=1` 时只用环境里给出的总线变量、不再从 `/run/user/<uid>/bus` 推导，strict envPolicy 也保留这个标记；确需时加 `--keep-user-bus`）；触到宿主 socket 以退出码 3 失败。围栏只拦住经 PATH 解析的 tmux 和继承来的环境：探针里不要用绝对路径调 tmux（如 `/usr/bin/tmux`）、不要 `env -i` 清空环境后再 spawn tmux——这两种写法绕过 shim，能直达 fleet 的默认 socket；需要碰 tmux 时只用私有 `-L`/`-S` 目标或仓库 test helper。仓库根目录新增 `vitest*.config.ts` 必须挂 tmux 围栏，`test/vitest-config-fences.test.ts` 守着。

**单测里不碰真实 systemd。** vitest unit 项目和 bun 腿另挂 systemd 围栏（`test/helpers/systemd-fence.ts`）：测试进程自己调 `systemd-run`、`busctl`、`systemctl --user`（含 `env …`、`sh -c` 包装和绝对路径）就让该测试失败，被测代码吞掉异常也一样；子进程经 PATH 上的 shim 被拒（退出码 1）。scope / fleet-scope 代码一律注入 `run`、`readlink` 或 `pidNamespace` 假实现，不要为了测它去连真实 user manager——在独立 PID 命名空间里，交出去的 PID 会被宿主 systemd 解释成另一个进程。

**本机测试有整机并发闸**（`scripts/test-concurrency.mjs`，接在 `vitest.config.ts` 的 sequencer 与 `scripts/run-bun-tests.mjs` 上）：vitest 选中 ≥50 个文件、或跑全量 `test:bun` 时，在 `/tmp/botmux-test-slots` 的 flock 名额上排队，整机同时最多 `核数/16` 份（64 核 = 4 份）；vitest 默认 `maxWorkers = min(16, 核数/名额)`。CI（`CI=true`）上两者都不生效，行为不变。看到 `[test-gate] 名额已满` 说明机器忙——别用 `BOTMUX_TEST_GATE=0` 绕过，定向测试（少量文件）本来就不排队；其余覆盖变量见脚本头注释。

worktree 里也能直接用 bun，且**不额外占依赖体积**——只要不跑 install（见下节）。实测在「源码 + `node_modules` symlink 到 canonical」的 worktree 里，`bun src/cli.ts`、`bun run build`、`tsc`、`vitest`、`build:bun`（`pty.node` 经 symlink 解析，不复制）以及编出二进制跑 smoke 六项，全部正常。

### worktree 的 node_modules：共享还是独立（改前必读）

worktree 的 `node_modules` **形态不统一**，是逐个手工决定的，不是包管理器行为：

| 形态 | 体积 | 风险 |
|---|---|---|
| symlink → canonical | 0 字节 | 见下面两条 🔴 |
| 独立 `bun install` | ~800M | 安全，互不影响 |

**🔴 铁律：绝不在 worktree 里跑 `bun install`（历史上是 `pnpm install`，换成 bun 后同样禁止）。** 理由不是「浪费一次重装」，是下面两条实测出来的后果——而且它们**与包管理器无关**，bun 与 pnpm 在「穿透 symlink 写进被指向目录」上逐字同构：

1. **两个 worktree 同时 symlink 到同一个目标时，install 会失败并把共享目录删掉**：
   ```
   ENOTDIR: not a directory, mkdir '<worktree>/node_modules'
   → 目标目录被删除
   ```
   单个 symlink 时 exit 0、目标完好；双 symlink 指同一目标时 **pnpm** exit 236 且目标被清掉（同场景 **bun** exit 0、目标完好——这一项 bun 更稳，但别指望它兜底）。canonical 的 `node_modules` 是 ~50 个 live daemon 的依赖来源——`/proc/<pid>/maps` 里能看到它们 mmap 着 `node-pty` 的 `pty.node`。已在跑的进程靠 inode 存活不会立刻崩，但**任何重启、spawn worker、或新起 CLI 会话都会失败**，等于 fleet 不可恢复。

2. **共享依赖时，后装的 worktree 会静默覆盖先装的版本**：A 要 `ms@2.1.3`、B 要 `ms@2.0.0`、共享同一 `node_modules` → B 装完后 **A 解析到 `2.0.0`**，而 A 的 `package.json` 写的是 `2.1.3`。**exit 0，零报错零警告**，症状会在完全无关的地方冒出来。

所以：**依赖需求与 canonical 完全一致**时才用 symlink（省 750M）；一旦分支动了 `package.json` / lockfile，就该独立 install，并且**在 worktree 之外**做（比如把改动推上去让 CI 装，或在 canonical 上装完再 symlink）。

### 编译态（单文件二进制）注意

编译版里没有 `dist/` 落在磁盘上——模块图在虚拟只读的 `/$bunfs/` 下，`__dirname` 是 `/$bunfs/root`。所以**任何把 `__dirname` 拼出的路径写到磁盘、或交给别的进程用的代码，在编译态都是坏的**（那个路径进程外不存在，且 sh 里未转义的 `$bunfs` 还会被展开成空串）。曾因此把 install.sh 装在 `~/.botmux/bin/botmux` 的二进制**覆盖成 47 字节的壳**。判断运行形态用 `isStandaloneBinary()`（`src/core/self-spawn.ts`），子进程一律走 `resolveEntrySpawn` / `spawnWorker` re-exec `process.execPath`，不要拼 `dist/*.js` 路径。

注意 CI 的 smoke（`scripts/smoke-bun-binary.mjs`）用空 `bots.json`，而 daemon 在 0 个 bot 时会直接以 `Invalid BOTMUX_BOT_INDEX=0` 拒绝启动——**daemon 内的代码路径在前几项检查里结构上不可达**，别把「smoke 绿」当成 daemon 编译态已验证。

### 多 checkout：全局 `botmux` 指向谁

全局 `botmux` 命令走 `~/.botmux/bin/botmux` 瘦 wrapper，指向「最后认领的 checkout」的 `dist/cli.js`（daemon 启动时也会写；编译态下则改为 `exec` 二进制自身，且当该路径就是正在运行的二进制时会跳过写入，不再自毁）：

```bash
bun run use:here             # 把全局 botmux 指向当前 checkout（仅改指向，不重启 daemon）
bun run switch:here          # = build + use:here 一步到位
BOTMUX_NO_CLAIM=1 bun run use:here   # 逃生阀：本次不认领
```

纯 `bun run build` 故意不认领——review/验证别人 PR 时不会悄悄抢走全局指向。实现见 `scripts/claim-botmux-bin.mjs`。

### 人工验证与部署到目标 daemon

当改动需要用户在飞书里**手动验证**（而非纯单测能覆盖），改完自测绿后，在 preview 的 dev checkout 执行下列命令。部署到 online 时，必须先确认其 checkout 是 release，使用已集成并验证的提交：

```bash
bun run switch:here && bun run daemon:restart
```

这里故意用 `bun run daemon:restart`，确保从当前 checkout 的 `dist/cli.js` 重启；不要依赖裸 `botmux restart`，它可能被 PATH 中更靠前的 npm 全局安装抢先。否则用户测的还是旧代码（典型症状：新加的命令/配置「找不到」）。⚠️ 这会让**目标机器上的所有 bot** 都跑本 checkout 的 build。preview 的临时 review/worktree 验证完成后，切回 dev 的 canonical checkout 并恢复其全局指向，避免 worktree 删除后 shim 失效；online 始终保持 release 的 canonical checkout。

## 模块结构

- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器，每种 CLI 一个文件（新增适配器的完整步骤见 `src/adapters/cli/CLAUDE.md`）
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `skills/` — 开箱即用的 Skill 定义 + installer
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`
- `core/command-schema.ts` / `command-router.ts` / `session-phase.ts` / `cli-idle-wait.ts` — 斜杠命令的**分类层**（见下节「命令路由」）
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## 命令路由（改斜杠命令判定必读）

daemon 两条入口（`handleNewTopicAdmitted` / `handleThreadReplyAdmitted`）对斜杠命令只做一次
`classifySlash(...)`（`src/core/command-router.ts`，纯函数），之后按决策执行；设计与决策记录见
`docs/design/2026-09-11-command-router.md`（§15 是逐期的执行记录）。改动时守住三件事：

- **命令注册只在 `src/core/command-schema.ts`**：名字/别名、会话政策（无会话时预建 / 不建 / 只对已有会话）、两条入口的前置特判位置、多行豁免、help 键。`DAEMON_COMMANDS` 等五个集合都从这张表推导，别再手写集合或在入口里加 `if (cmd === '/xxx')`。加命令 = 加一行 + `handleCommand` 加 case，`test/command-schema.test.ts` 会红到两边对齐。
- **路由判定的任何变化都会让 `test/command-router-oracle-diff.test.ts` 变红**：它把 `test/legacy-oracle/` 里冻结的老判定（零 src import）与新路由器在 ≈269 万组输入上逐字差分。红了先判断是回归还是有意变化；有意变化要同时登记到差分测试的 `INTENTIONAL` 名单和设计文档 §9 的有意变化表，别去改 oracle。
- **话题指令头也只在 `src/core/topic-header.ts` 解析**：`/t` `/topic` 与生命周期别名 `/th` `/tw`（= `/t here|worktree`）、`/repo wt <目标> [分支]` 都由它给出 `TopicHeader`，入口不做正则预判；相斥组合（生命周期变体 + `/repo`）由 `topic-spec.ts` 拒绝，不做静默优先级。
- **会话相位**（`session-phase.ts`）由现有旗标推导，`ds.cliReady` / `cliReadyGeneration` 只由 worker 的 `prompt_ready` 置位、不由 `ready` 清零；runtime 级联（`cli-idle-wait.ts` + daemon 的 `runPassthroughCascade`）只在 PTY 家族后端、非 adopt 会话上跑。

## 飞书 owner 身份边界（setup/onboarding 改动必读）

这里曾发生过一次路径回归：Dashboard onboarding 已经防住跨应用复制 owner，后来新增的 scripted `setup add --create-app` 只做格式校验，又绕过了同一条身份边界。以后新增或修改创建 Bot 的入口时，必须遵守以下不变量：

- `ou_`（`open_id`）是 **app-scoped**：只对签发/观察它的飞书应用有效，绝不能从来源 Bot 复制到另一个 Bot。`BOTMUX_OWNER_OPEN_ID` 也只是 `BOTMUX_LARK_APP_ID` 视角下的 session owner，不是当前 turn 的发送者，更不是可跨应用复用的 owner 配置。
- 跨应用/新建应用的 owner 优先使用完整邮箱、手机号或 `on_`（`union_id`；仍需满足同租户/开发者条件）。新应用创建前，只能通过来源应用转换 daemon 已认证的当前 owner；任意其它 `ou_` 必须在创建应用前拒绝。
- Dashboard onboarding、交互式 setup、scripted `setup add` 以及后续任何新增入口，都必须复用 `src/setup/owner-identity.ts`，不要只校验格式后直接写 `allowedUsers`。在创建应用前归一化来源 owner，在写 `bots.json` 前用目标应用校验；暂时性网络/scope 错误保持 inconclusive，目标应用明确判定不可用时 fail closed。
- `BOTMUX_OWNER_OPEN_ID` / `__OWNER_OPEN_ID` 是 daemon 认证的 session 身份。新增 backend / runner / RPC 子进程时，必须通过 `applySessionOwnerEnv` 在可配置 env 合并完成后注入并冻结，不能让 bot/backend 配置覆盖它；ownerless session 必须同时删除两个变量。
- 回归测试必须覆盖 managed-Agent 场景（source app 的 `BOTMUX_OWNER_OPEN_ID=ou_*` 创建 target app），并验证真人 owner 在目标 Bot 下的 `canOperate`；Bot-to-Bot 消息通、权限 scope 通或参数格式合法，都不能证明 owner 身份正确。

## 测试原则（写/改测试必读）

**所有测试必须在 preview 机器执行，包括单元测试。** 集成测试、端到端测试、浏览器测试、回归测试、smoke 以及失败用例的重跑也遵守此规则；不要在本地开发机或 online 上运行测试，也不要把本地测试结果作为验收依据。

- 测试前按上文登录 preview，确认机器、dev checkout、待测提交和工作区状态；本地未提交的待测改动也必须同步到 preview 的隔离目录后验证，保护远端已有改动。
- 测试进程使用隔离的配置、数据目录与临时环境变量，避免污染 preview 的运行中 Bot；遵守下文共享依赖与 worktree 的安装限制。
- preview 当天访问权限不可用时，停止依赖测试的验收，报告连接错误并提醒用户申请或续期权限；不能改在本地或 online 补跑。
- 验证记录注明 preview 环境、实际待测提交及未提交改动、命令和结果。缺少依赖、凭据或浏览器状态的用例应明确记录为未完成，不得宣称全量测试通过。

### Preview 测试的最小执行协议

测试统一按“需断线续跑”的任务处理：进入 `-L botmux-maint` 的固定 `preview-dev` 会话，在单一 pane 中串行执行；不要为不同测试新建 session，也不要并行跑全量 Vitest、Bun runner 或 e2e。

会 spawn CLI / PTY / watcher 的测试和所有全量测试统一使用下面的模板，避免子进程读取控制终端后收到 `SIGTTIN`：

```bash
test_log=/tmp/botmux-test-<task>.log
setsid --wait env NO_COLOR=1 bun run test </dev/null >"$test_log" 2>&1
test_rc=$?
tail -n 200 "$test_log"
printf 'test exit=%s log=%s\n' "$test_rc" "$test_log"
```

将 `bun run test` 替换为本次所需的定向命令即可。`setsid --wait`、`/dev/null` 和明确日志缺一不可；命令保持前台运行，不加 `&` / `nohup`。需要暂离时 detach tmux，重连后恢复同一 job，不要重启一套。

全量测试前只做两个快速资源检查：当前维护 shell 执行 `ulimit -n 8192`，再运行一次 `bun scripts/fenced-run.ts -- -- bun -e 'const fs=require("node:fs"); const w=fs.watch("."); w.close()'`。任一步失败或出现 `EMFILE` 就停止并报告 Preview 资源不足；不要设置 `CI=1`、`BOTMUX_TEST_GATE=0`、降低 worker 或绕过仓库并发闸。

退出码为 0 且日志包含完整汇总才算通过；`Stopped (tty input)`、SSH 中断、部分文件计数或缺少最终汇总都算未完成。结束后删除本任务的精确日志路径，并按远程交互的统一收尾规则关闭 SSH Panel。

#### 按影响面选择命令

`test:all` 不是默认验收命令；它包含可能需要浏览器、外部服务或凭据的其它 project。选择覆盖当前改动的最小完整集合：

| 变更范围 | 必跑命令 |
| --- | --- |
| 任意 TypeScript / 构建产物改动 | `bun run build` |
| 已修改模块及直接回归路径 | 对应 `vitest run --project unit <files...>` |
| 公共层、daemon、worker、身份/授权、调度、IM、适配器或跨 CLI 改动 | `bun run test` 与 `bun run test:bun`，串行执行 |
| e2e 覆盖的行为或用户明确要求 e2e | 对应 e2e 文件；先确认真实 CLI、PostgreSQL URL、Chrome 等前置条件 |
| 新增或修改持久状态语义 | 前述集合 + fenced mutation / 探针 + 独立对抗复核 |

- e2e 前先用显式文件 allowlist 对账并运行可满足依赖的文件；缺少前置条件的用例如实记录为未完成，不用重复 `--exclude` 或伪称通过。
- 涉及 user namespace、Bubblewrap、mount namespace 或 sandbox bind 的隔离 checkout 放在 `/root/<task-worktree>`，不要放 `/tmp`；继续复用 canonical `node_modules`，禁止在 worktree 中 install。新增未跟踪源码/fixture 在测试 worktree 中只按精确路径 `git add`，避免被 sandbox mask。
- 失败时先从完整日志定位并定向重跑；本次改动相关失败必须修复，独立环境或历史失败要记录命令、日志和与当前 diff 的关系。

测试要证明**行为**，不是给实现拍照。下面几类已经集中治理过，不要再新增：

- **不读 `src/` 源码文本做断言。** `readFileSync('src/worker.ts')` 后 `toContain` 某行代码、或比 `indexOf` 先后，钉的是实现文本：改名、重构就红，代码还在但已经走不到时照样绿。git 历史里这类文件几乎每次改 `worker.ts` / `daemon.ts` 都得跟着改字符串。被测逻辑埋在闭包里时，**把它抽成可导出的纯函数再测**，而不是 grep；治理时因为没有 seam 而删掉的绊线记在 `docs/plans/2026-10-20-test-seam-backlog.md`，动到对应代码时顺手补上。只有真正的结构约束才保留这种写法：K1 import 边界与编译态限制、K2 没有行为 seam 的安全护栏、K3 高危回归绊线（数据丢失、fleet 崩溃、消息丢失或重复）、K4 机器可校验的一致性。保留时在用例或外层 `describe` 上方写 `// 源码结构护栏(Kx)：<为什么只能读源码、守的是什么不变量>`；只是把 src 下的 HTML/CSS 当夹具或交给浏览器、并不断言其文本的，写 `// 非文本断言：<说明>`。`test/test-hygiene.test.ts` 会拒绝没有标注的读源码用例。从 `worker.ts` / `daemon.ts` 切出真实函数执行再断言结果（`test/helpers/worker-function-harness.ts`）是没有 seam 时的过渡写法，扫描器不拦，但它依赖函数名和自由变量名，能导出时就直接 import。
- **不钉文案和文档措辞。** 断言 docs / README / 卡片文案里有某句话，或断言另一个测试文件里有某个用例标题，都证明不了行为。文档由代码生成时，用 `--check` 式的漂移检查；需要「文档覆盖全部枚举值」这类一致性时，两侧都从真实数据取，不要抄字符串。
- **不钉内部常量。** `expect(TIMEOUT_MS).toBe(60_000)` 只是把字面量再抄一遍。外部协议值（飞书错误码、终端转义序列、跨进程退出码、HTTP 路由、wire format）可以钉；常量之间的关系（`A >= B + C`）写成关系断言。
- **不为死代码写测试。** 一个导出如果只有测试在调用，要么接进生产路径，要么连同测试一起删掉。测试隔离用的 `reset*` / `clear*Cache` 钩子不在此列。
- 落笔前自问两句：这条测试会在**真实的行为回归**时变红吗？会在**无害的重构、改文案、调参数**时变红吗？前一问答「会」、后一问答「不会」，才值得写。

## 独立对抗复核（改持久状态语义必做）

改动**新增或修改持久状态的行为语义**——任务认领/结算、暂停恢复、通知投递、账本计数、重试窗口、会话生命周期——push 前做一次**独立对抗复核**。动机：同一心智模型既写实现又写测试，**「交叠」类缺陷（状态语义与时序/并发交叉处）靠读代码和自查发现不了**；由未参与实现的独立上下文在提交前从异常场景攻一遍，能把问题留在提交侧，减少外部评审往返。#2237（有状态定时任务）的复盘显示，这类「交叠」缺陷集中在下面三类通用场景（另有一类是测试覆盖缺失，见下「变异复验」）；其中五处旁路由提交前的一次独立复核发现并随修复一并提交。

- **触发条件**：持久状态的**行为语义**变了（纯重构、只读展示、纯文案不算）。拿不准就按触发处理——复核成本远低于一轮外部评审往返。
- **做法**：由**未参与实现的独立上下文**（另一会话/另一 agent）执行，只提供 diff、设计文档与现有测试环境，不传达实现者自己的解读。本条面向 agent 贡献流程（AGENTS.md 转发至此），**不设 CI 门禁**，不约束人类贡献者。
- **攻击面至少覆盖三类通用场景**（与具体功能无关）：①**人工中途干预**——操作进行到一半人介入（暂停/取消/改配置），流程转回来时状态是否自洽；②**多步写入只完成一半**——前半步落盘、后半步失败，重启或下一轮是否永久静默/永久重复；③**周期循环 × 长操作/等待窗口交叠**——tick、重试窗口、超时与下一次常规运行在时间上穿插时，先后与重入是否成立。
- **探针证据**：每个怀疑用**真实组件 + 假时钟**（可控 timer）跑出复现序列才算数，**不接受仅读代码得出的「应该没问题」**。
- **变异复验**：对本次新增的测试，摘掉被测守卫（或把条件写反）必须**咬红**；照旧绿说明测试没钉住行为，按「测试原则」修。
- **产出**：问题清单（**级别/场景/探针证据/建议修法**）连同修法、回归用例写进 PR 描述（**只写问题清单与探针证据，不写由谁执行的复核编排**）；复核未发现问题的，注明攻过哪些场景即可。

## PR 规范

- 标题与 commit message 同格式：`type(scope): 中文描述`
- 描述用**中文说明**：改了什么、为什么、影响面（涉及哪些模块/会话类型）
- 附**实际测试验证**：贴出跑过的命令和关键结果（`bun run build`、`bun run test`、相关 e2e），不要只写「应该没问题」；需要 live 验证的按「人工验证与部署到目标 daemon」在 preview/dev 执行 `bun run switch:here && bun run daemon:restart`，在飞书里实测并注明环境与结果；online 的部署验证只能使用 release
- UI 类改动（飞书卡片 / dashboard / web 终端）附**截图示意**，让 reviewer 不用跑代码就能看到效果
- **不写飞书群内真人名字，也不写机器人协作花名/内部 review 编排**：commit message 与 PR 标题/描述进的是**公开 git 历史**，读者不需要知道群里谁参与、谁审的。① 不出现群成员真名——验证描述用中性客观表述（如「矮视口下成员/机器人行都能滚动可见」，而不是「某某/某某两行成员」）；② 不出现 `@Codex`、`Codex 复审`、`双审`、`首审`、`双审收敛` 这类多 bot 协作花名，验证只陈述**做了什么验证、结果如何**的客观事实，不写「谁审的」。（`Co-authored-by` git 署名 trailer 属正常署名规范，不在此列。）

## Git 提交 & npm 发版规范

- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文；同样**不带飞书真人名字与机器人协作花名**（见上「PR 规范」）
- 日常 `git commit` + `git push` 不会触发发版；打 `v*` annotated tag 并 push 才发版（**仅在用户明确要求时**），CI 自动从 tag 提取版本号发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段；tag message 用中文撰写，CI 会用作 Release body
- 以下 npm 发版约束沿用上游 CI；本 fork 的业务部署以 release 为准，部署分支的改变不等于修改 npm 发版流程。
- **npm 正式版（latest）必须从 master 出**：CI 校验被打 tag 的 commit 含最新 `origin/master`。非 master 分支灰度用 `-canary.N`/`-beta.N`/`-rc.N` 后缀（CI 自动路由到对应 npm dist-tag，其它 `-` 后缀兜底到 `next`，都不污染 latest）；验证 canary：`botmux update canary`（或 `npm i -g botmux@canary`）
