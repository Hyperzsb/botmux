# Unified tool identity policy and native host compatibility

Status: proposed implementation plan. No runtime/configuration changes are made by this document.

> **执行进度（2026-11-06 开始实施）**
> - Phase 1（契约层与行为接缝）：已完成并通过 preview 验证。新增
>   `src/services/tool-identity-config.ts`（规范化策略）与
>   `src/core/tool-identity-policy.ts`（纯选择器：`selectTurnExecutionUser` /
>   `selectToolCredential`）；`resolveAutomationIdentity` 与
>   `publishTurnCliIdentity` 两条生产路径已改为经由选择器决策（行为保持不变，
>   provenance 旧行为通过 `provenanceWithoutPerTurn` 迁移开关保留，Phase 3 统一
>   入口时移除）。新增 `test/tool-identity-policy.test.ts`。
>   preview Linux 验证：隔离副本 `/tmp/p1x/verify`（基于 dev canonical
>   `d1ebf9097` + 基线未提交改动 + 本阶段改动），`bun run build` 通过；
>   相关测试文件共 386 + 52 + 6 + 23 + 12 用例全部通过。
> - Phase 2（原生默认与干净的 Worker 切换）：已完成并通过 preview 验证。
>   `larkToolBindingEnabled` 改为显式 opt-in（只有 `larkToolBinding:true` 安装
>   应用绑定；unset/false 均为原生宿主行为，旧的「按人授权反向决定绑定」关系
>   已移除）。规范化策略移除 `effectiveLarkBinding`，可执行性按显式三态判定；
>   respawn 三分态契约同步（unset → null 清除）；`/config set`、Dashboard
>   payload/UI、帮助文案按 opt-in 语义更新；相关 12 个测试文件在 preview
>   隔离副本全部通过（build 通过）。
> - Phase 3（统一轮次契约 + 版本化决策记录）：已完成并通过 preview 验证。
>   移除 `provenanceWithoutPerTurn` 迁移旗标，选择器即为唯一契约（provenance
>   仅在按人鉴权 ON 时准入，OFF+无指派即宿主原生）；新增
>   `src/core/tool-identity-decision.ts`（v1 记录：host/managed/denied 逐轮
>   冻结，不含凭据物质），冻结点（scheduler/trigger-session/recovery/
>   reply-target）全部盖章，daemon 读取走 `toolIdentityDecisionFromReplyTarget`
>   （§9：裸 `automationUser:null` 不猜测）。preview build + 8 个测试文件全绿。
> - Phase 4（toolIdentity 固定执行用户）：已完成并通过 preview 验证。
>   新增 `toolIdentity.defaultUser` 解析（unset/valid/invalid 三态，坏配置
>   失败闭合）、`fixedBotUser` 进入规范化策略与两层选择器（人类轮次按工具
>   基线接管 + 自动轮次最低优先级默认）、worker 包装器「按人鉴权 ∪ 固定
>   用户」传输范围（§12.1）、live worker 缺包装时消毒策略并告警、
>   `/config set toolIdentity` + Dashboard 路由/UI/i18n、两份身份文档按
>   opt-in 语义更新。preview build + 11 个测试文件全绿。
> - Phase 5（验收与集成）：按下文执行中。

## 1. Required outcome

When per-turn user identity for a tool is disabled and no applicable execution user is assigned, Botmux must use that tool's default host credentials directly. This must work for normal user chats, scheduled chats, group entry/invitation, and webhook chats. An upgrade must not implicitly replace native credentials with a managed application identity or reject a request solely because an automatic event has no human sender.

An explicit selection has different semantics: when an applicable user is configured, Botmux must honor that selection or report why it cannot. Invalid, revoked, unsupported, or unauthorized explicit selections must never degrade to another account.

The refactor must preserve queued-turn isolation, delegated grant limits, app-scoped identifiers, existing session ownership, and the host's ability to run its ordinary CLI tools.

## 2. Current implementation and why another abstraction is needed

The working tree already contains several rounds of fixes. Preserve and consolidate their behavioral protections rather than implementing the early review findings again:

- Invalid automation settings retain a distinguishable failure state.
- Explicit task/connector selection outranks the automation default during execution.
- Lifecycle participants are marked as synthetic and require independent human evidence for user selection.
- Managed Lark credential/auth endpoints enforce the execution turn's frozen tool scope.
- Excluded credential material is cleared on publication.
- The latest working tree carries delegated schedule provenance and rejects failed configured webhook identities.

The remaining architectural mismatch is broader:

| Current area | Responsibility currently mixed into it | Refactor target |
|---|---|---|
| `trigger-user-auth.ts` | Per-tool sender policy and implicit Lark binding default | Normalize sender policy; implicit binding must not select credentials |
| `automation-identity.ts` | Human lookup, policy validation, default precedence, worker compatibility | Separate identity resolution, policy selection, and execution capability |
| `lark-tool-binding.ts` | App selection, user credential delivery, wrapper installation, storage model | Install the transport needed by the selected mode, without deciding the user |
| `daemon.ts`, session manager, trigger session | Entry-specific selection, publication and synthetic caller construction | Adapt trusted event facts into a common admission service |
| Worker initialization and restart | Re-derive settings and mutate wrapper environment | Consume a versioned capability plan and exact-turn credential decision |
| Managed Lark endpoints | Independently reconstruct current user and tool scope | Consume and revalidate the exact admitted decision |

For example, `larkToolBindingEnabled()` currently derives an unset binding from the inverse of per-turn Lark authentication. Thus turning sender authentication off can enable a different authentication mechanism. That relationship must disappear.

## 3. Policy contract

### 3.1 Terms

- **Event actor:** authenticated human, bot, system event, or unknown operator that caused an input. Group inviter and scheduled creator are provenance, not automatically the tool account.
- **Tool execution user:** an explicitly selected or verified user whose credentials are permitted for one tool in one run.
- **Session/task controller:** the principal allowed to manage Botmux resources. Tool identity does not replace this principal.
- **Host mode:** execute the real tool using its ordinary effective host environment and native credential lookup. Botmux does not need to identify or authorize a human account first.
- **Managed user mode:** deliver credentials only for the resolved user; never fall back to a native host account.
- **Application binding:** an explicit choice to bind Lark calls to the bot application. This is independent of the sender-authentication switch.
- **Delegated mode:** execute only under a verified grant. It is not an ordinary unassigned automatic run.

Do not label host mode as `anonymous`, `missing_user`, or `failed_identity`. It is a successful policy decision whose credential owner may be unknown to Botmux.

### 3.2 Four primary combinations, evaluated per tool

Here, “assigned” means a user applicable to that entry type and tool. A task/connector assignment is an automatic-turn override; a fixed bot assignment may apply more broadly.

| Per-turn tool identity | Applicable assignment | Human-triggered chat | Schedule / group entry / webhook |
|---|---|---|---|
| Off | None | Host credentials | Host credentials, without requiring a sender, creator union ID, or login link |
| Off | Configured | Fixed bot user when applicable | Task/connector user, then automatic default, then fixed bot user |
| On | None | Verified current human sender | Verified creator/event principal where supported; otherwise managed-user denial |
| On | Configured | Verified current human sender | Task/connector user, then automatic default, then fixed bot user |

Additional rules:

1. A configured but unusable winning assignment is an error. Never continue to a lower-priority user or host mode.
2. A broken lower-priority setting does not invalidate a valid higher-priority assignment.
3. Evaluate each tool independently: enabling per-turn identity only for Lark does not change native ByteCloud authentication.
4. When a tool is outside an ordinary assignment's scope, continue evaluating its independent per-tool baseline policy. Do not claim that an ungoverned tool executes as the selected user. A delegated grant exclusion, by contrast, means denial, never host fallback.
5. For per-turn-on tool policy, missing personal authorization, provider outage, or missing human provenance never falls back to host credentials.
6. A normal bot-sender message is not a verified human turn. With per-turn-off and no assignment it may use host mode after normal message admission; with per-turn-on it needs valid delegation or another applicable explicit policy.
7. Botmux admission/permission checks still apply before execution. Host credentials do not authorize an otherwise forbidden chat, schedule, webhook, or Botmux management action.

### 3.3 Assignment precedence

Evaluate the authority class first:

1. Verified delegated execution: retain its grant and anonymous/current-actor semantics. Do not consult native/default-user fallback.
2. Ordinary human-triggered turn with per-turn policy enabled for the tool: authenticated sender.
3. Ordinary automatic turn: task/connector override, existing automatic-only bot default, then fixed bot user.
4. Other ordinary turn with per-turn policy off: fixed bot user if applicable; otherwise host.
5. Automatic turn with per-turn policy on and no applicable assignment: validated creator/human event provenance; otherwise managed-user denial.

An explicit user for an automatic turn outranks its creator provenance. A legacy task with only an owner open ID is sufficient to dispatch in host mode; it does not acquire managed human authority merely by being allowed to run natively.

### 3.4 Explicit Lark application binding

- Unset binding must not install an app-bound credential wrapper for an otherwise native tool.
- `larkToolBinding:true` remains an explicit opt-in. It selects bot-app execution for `--as bot`; `--as user` uses a selected/verified managed user when one exists. If none exists, explain that this explicitly bound mode has no user identity.
- `larkToolBinding:false` means no bot-app binding. It must not disable a separately requested managed user policy; use the personal-user wrapper when that is the required capability.
- Explicit application binding and managed user selection are distinct capabilities. Supporting a selected user must not require changing an unrelated global toggle.
- A host-mode `lark-cli --as user` uses native host authorization. A host-mode `--as bot` uses the native CLI's own configured app. Botmux does not append a role, app ID, profile, or token in either case.
- In managed user mode, profile/argument overrides must not bypass the selected principal. Retain explicit native profile behavior only in host mode or an explicitly documented application-binding escape policy; reject conflicting overrides in user-constrained runs.

## 4. Configuration model and compatibility

### 4.1 Keep existing configuration meanings recognizable

Retain these public controls:

- `triggerUserAuth.enabled`, `tools`, and credential source: sender identity for governed tools.
- Task and connector `runAsUser`: explicit automatic-turn override.
- `automationIdentity`: the existing automatic-only bot default, including tools and invalid-state handling.
- `larkToolBinding`: explicit Lark application binding.

Introduce one narrowly scoped public concept to express the agreed fixed bot user for both normal and automatic sessions:

```ts
toolIdentity?: {
  defaultUser: { larkAppId: string; openId: string; unionId: string; name?: string };
  tools: TriggerUserAuthTool[];
  credentialSource?: 'auto' | 'platform' | 'local';
};
```

`bots.json` persists this public `defaultUser` shape. Runtime/API payloads use `user`; the parser accepts both shapes and the store converts normalized values back to `defaultUser`. A save without a credential-source change preserves the fixed assignment's own source.

This field expresses the fixed bot assignment in the primary matrix. Its user applies to human turns only when per-turn policy is off for that tool; it also acts as the lower-priority automatic default. Keep `automationIdentity` automatic-only during migration. Silently broadening its historical meaning to normal human turns would change existing operators' authorization choices.

The final public name can be aligned with repository conventions before implementation; the distinction between fixed bot user and automatic-only override is required. Do not create a second global sender-authentication flag. Do not require any new configuration for the central off/unassigned host-mode case.

### 4.2 Parse configuration into explicit states

Use a discriminated result such as `unset | valid | invalid`; store diagnostics without retaining arbitrary rejected payloads. Avoid parallel optional properties whose combinations can contradict one another.

- Omitted field: unset.
- API clear operation: unset.
- Present malformed/cross-app field: invalid, retained as configured failure.
- Valid field with currently unavailable access/provider: valid configuration plus runtime unavailability.

Separate APIs:

1. Resolve an observed/verified human in the target app.
2. Normalize the scope requested by this save operation.
3. Validate that scope against the target execution capability.
4. Save and read back the normalized configuration.

Do not resolve a new explicit user using the old bot default's scope. A valid task override must be savable when the default is invalid. A default update must validate the newly requested tools, allowing repair in one request.

### 4.3 No implicit upgrade migration to app credentials

For unset binding, off/unassigned selects host mode by code policy; users need not materialize `larkToolBinding:false` to recover pre-upgrade behavior. Keep explicit true/false values intact. Do not guess which saved explicit settings were “really defaults.”

Before rollout, provide a read-only policy preview listing effective mode by bot/tool/entry type. Report changes from the current build without exposing native credential files or values. Configuration repair, if necessary, uses supported configuration/task authority APIs; never edit `schedules.json` alone.

## 5. Internal architecture

### 5.1 One normalized policy and one pure selector

Introduce small modules with no runtime dependency on the live registry:

- `services/tool-identity-config.ts`: normalized schema/types and compatibility parsing.
- `core/tool-identity-policy.ts`: pure per-tool selection from trusted input facts and normalized policy.
- `core/tool-identity-admission.ts`: asynchronous validation, capability checking, and creation of a frozen decision.
- Keep existing provider implementations for local/platform credentials. Adapt them rather than duplicate them.

Illustrative result:

```ts
type ToolCredentialDecision =
  | { mode: 'host'; source: 'native_default' }
  | { mode: 'managed_user'; source: 'sender' | 'task' | 'connector'
      | 'automatic_default' | 'bot_default' | 'provenance'; user: AppScopedUser }
  | { mode: 'bound_app'; appId: string; user?: AppScopedUser }
  | { mode: 'delegated'; grantRef: string; permitted: boolean }
  | { mode: 'denied'; reason: ToolIdentityFailure; source: string };
```

Admission returns a structured outcome with `allow_dispatch`, `restart_required`, or `reject` plus per-tool decisions. Host mode must never be represented as `user:undefined` attached to a managed decision.

Do not reject native requests because the personal identity cache, union-ID service, user picker, platform binding, or OAuth service is unavailable. A tool may still fail through its native authentication behavior; preserve its actual error and exit code.

### 5.2 Freeze decisions, not credentials

Persist an immutable, versioned exact-turn record containing:

- Session ID, logical identity turn ID, and authority class.
- Actual event actor and controller references where independently established.
- Per-tool mode, identity source, app-scoped user or delegated grant reference.
- Explicit scope/exclusion semantics and normalized policy fingerprint.
- Configuration generation/version and admission time.

Do not store access tokens, refresh tokens, device codes, environment dumps, or native login copies in that record.

New automatic-turn records also freeze the independent per-tool baselines (sender tool scope/source and fixed assignment). Assignment exclusion resumes that frozen baseline; a later enabled tool cannot acquire the selected assignment by omission. Worker requirements and publication use the same per-tool selector; a live worker missing a required wrapper refuses the turn until restart.

Preserve the resolved selection through queueing, restart, recovery, model/storage-mode flips, repository selection, auto-worktree completion, and session suspension. Refresh credentials only for the already selected user; revalidation can deny but cannot substitute someone else.

For host decisions, freeze the choice of native mode, not a copy of the host login. Native login changes continue to behave as they do in a normal CLI process.

### 5.3 Keep actor, credential account, and controller separate

Do not replace `TrustedCaller` or session owner just because a tool uses a fixed bot user. Examples:

- Human A starts a normal turn whose selected tool account is B: caller/controller remains A; tools may use B only under the explicit bot policy.
- A system webhook runs with host credentials: it has no fabricated human caller.
- A legacy schedule uses native credentials: missing creator union ID does not block its prompt, and does not give it human management authority.
- A delegated schedule retains its permitted tool grant and anonymous actor, even if the bot has a fixed user or automation default.

`BOTMUX_OWNER_OPEN_ID` and `__OWNER_OPEN_ID` continue to be session-owner metadata enforced by `applySessionOwnerEnv`; they are not host credential selectors or tool execution-user overrides.

### 5.4 Separate worker capability from one turn's policy

At spawn, record capabilities: native execution, managed wrappers per tool, app-binding transport, OS/process attestation, sandbox access, and IPC protocol version.

At dispatch, compare the frozen decision to those capabilities. A worker that cannot enforce an explicit managed selection must restart or reject before receiving the prompt. Never start it in host mode as a substitute.

Allow one capable worker to alternate native and managed turns only when isolation can be demonstrated. Prefer an execution-time gateway that verifies the active execution and then either injects the managed credentials or invokes the tool using a reconstructed native environment. If a backend/CLI can only freeze environment at process spawn, restart between incompatible modes. Do not rewrite a running worker's environment as if that changed existing children.

Keep a genuine host-only session on the simple native path. Installing policy-capable dispatch machinery for mixed sessions must not cause host-only requests to depend on user identity/OAuth services.

## 6. Credential environment and wrapper lifecycle

### 6.1 Define the native baseline precisely

“Host credentials” means the effective native tool environment produced by existing host/bot configuration merge rules, before session-managed credential injection. Respect intentional bot HOME/PATH/profile configuration; do not overwrite it with a guessed root HOME.

Classify variables by ownership:

1. Host/bot-supplied native settings and credentials: retain in host mode.
2. Botmux-managed per-turn tokens, homes, askpass, profile overrides, and binding locators: remove when returning to host mode.
3. Session routing/owner/capability metadata: handle under its existing trusted environment policy, separately from credentials.

Do not clear credentials solely because their variable name can also be used by a managed provider. Track provenance so cleanup removes Botmux's injection without destroying an intentional native setting. Do not log the baseline environment.

### 6.2 Clean transitions must be atomic

Cover host → user A → host → user B, app-bound → host, and policy-off after a restart:

- Remove obsolete Botmux wrappers, `.env` snapshots, temporary homes, shell startup hooks, binding files, and companion Codebase/git state owned by that session.
- Preserve canonical host credentials and unrelated files.
- Preserve or replace delegation data only according to the active grant, not broad wrapper cleanup.
- Existing child processes keep their original execution authority. A process from a native turn must never acquire a later managed user's credentials.
- If native mode cannot be isolated from an active managed execution, serialize or restart; never use an unverified mutable “current user” file.

Reuse `resolveEntrySpawn` and existing standalone-binary helpers. Do not introduce disk paths under `/$bunfs/` or assume `dist/*.js` exists outside compiled binaries.

### 6.3 Storage model is transport, not identity policy

`single` versus `proven` remains a worker-reported storage/attestation fact. It must not select host versus user credentials. The daemon must not independently reconstruct sandbox/network facts.

On a storage-model flip, discard incompatible material and replay the same frozen mode/principal. Host mode needs no managed identity publication. A model flip must not ask the registry to choose a new default.

## 7. Entry-point integration

| Entry | Trusted facts supplied to admission | Special requirements |
|---|---|---|
| New human topic / reply / P2P | Platform sender and exact message turn | Sender wins only when per-turn policy is enabled; off/unassigned is native |
| Scheduled task | Host authority kind, task selection, verified creator if present | Legacy owner-open-ID-only tasks run natively when off/unassigned; grant-only tasks bypass defaults |
| Group entry / invitation | Lifecycle event, operator classification, optional verified human | Bot inviter is never promoted to human; host mode does not need contact lookup to dispatch |
| Webhook / external trigger | Saved connector policy, target, authenticated transport facts | Payload/header/query cannot choose the execution user; failed configured selection rejects; unset/off runs natively |
| Recovery / readonly continuation | Original immutable decision and exact parent execution | Never infer from last human speaker or newly edited defaults |
| CLI-native cron | Proven association with a parent decision or a separately admitted automatic job | Inherit only through authenticated association; otherwise resolve a fresh autonomous policy |
| Adopt / external app-server / remote runner | Actual backend capability and native credential location | Native mode uses that execution environment's native credentials; never copy local host tokens to a remote machine |
| Workflow / delegated dispatch | Existing grant and workflow authority | No implicit native fallback or fixed-user promotion outside the grant |
| Document/comment / meeting / other IM | Source-specific verified actor and transport capabilities | Use the same selector; audit shared worker/environment effects even when these are outside initial rollout |

For native group entry, identity enrichment can happen for display/audit, but avoid making a contact lookup a new execution prerequisite. Retain the existing allowed-member gate and lifecycle deduplication/registration barriers.

For schedule multi-target execution, freeze the selected account consistently and validate each target's access. A partial target failure must be reported without switching account on another target or silently rerunning completed business writes.

## 8. IPC and durable-data changes

1. Add a versioned policy decision reference to turn-carrying init/message/raw-input IPC and activation/recovery records. Ensure cold and live dispatch use the same representation.
2. Replace growing collections of partially overlapping `automationUser`, source, tools, and sender fallbacks with the normalized record. During migration, retain a read adapter for existing persisted fields.
3. Make worker-generation/attempt and logical identity-turn joins authoritative. Preserve explicit callerless managed/delegated state; native mode must be distinguishable from it.
4. At managed credential/auth endpoints, verify decision mode, tool, selected app/user, grant, current execution, and permission state before and after asynchronous credential work.
5. Host invocations should use the native branch without requesting managed user tokens. Host admission must not require `managedTurnOrigin.callerOpenId` merely to call a native tool.
6. Mixed-version daemon/worker pairs must negotiate capabilities. If the worker cannot distinguish native from denied-managed mode, do not activate managed-user execution through it; restart that session under the new protocol. Do not weaken attestation to make mixed versions appear functional.

## 9. Existing session and legacy record migration

Classify separately:

- **New turns in newly spawned workers:** use the new policy immediately.
- **New turns in live old workers:** require capability reconciliation/restart when the wrapper mode would differ.
- **Accepted queued turns:** preserve the admission policy; do not grant a new configured user retroactively. Legacy native turns with trustworthy pre-binding evidence can be marked native. Ambiguous managed turns need restart/re-admission, not guessed credentials.
- **In-flight managed/delegated turns:** preserve their original principal and scope through terminal settlement.
- **Old records with only `automationUser:null`:** infer neither native nor denial from null alone. Use recorded policy/configuration provenance where available; otherwise flag the ambiguous execution for controlled restart. Future records must encode the mode explicitly.
- **Legacy schedules:** leave owner/controller records intact. Off/unassigned does not require union-ID backfill. Managed creator mode requires verified same-app human evidence or explicit user selection.

Never infer a native host user's union ID by reading token contents and turn it into a trusted Botmux caller. Host credential account discovery is not an authorization migration.

## 10. User-facing settings and diagnostics

Dashboard should show an effective mode per tool: **Host credentials**, **Current sender**, **Assigned user**, **Bot application**, or **Delegated scope**. Show the actual source of the choice and whether a session restart is needed.

- Off + no assignment displays “Use this execution environment's existing CLI credentials.” It does not request a user selection or OAuth login.
- Use separate labels for a fixed bot user and an automatic-only default.
- Show task/connector override precedence and scope before saving.
- Explicit binding is independently visible; unset must display native/inherited behavior rather than a checked default-on toggle.
- Invalid configuration displays a repairable error while keeping unrelated bot functionality online.
- Missing native login preserves the tool's native login/error flow. Managed authorization guidance is offered only for an identified managed user.
- Reports distinguish admission failure, model dispatch, business completion, and delivery failure. A successful dispatch does not prove a Base write completed.

Audit mode/source and redacted identity references. Do not claim the host credential owner is the event actor. Do not return union IDs, user-token material, native homes, or private credential paths to anonymous dashboard audiences.

## 11. Implementation sequence

### Phase 1 — lock the contract and establish behavioral seams

- Add normalized parser/types and a pure per-tool selector.
- Encode the four combinations plus explicit binding, automatic-only compatibility, scope inheritance, invalid states, and delegated authority.
- Route at least one production admission path through the new selector before retaining exported functions; avoid test-only dead code.
- Add regression tests that demonstrate off/unassigned host execution under missing identity services and missing union IDs.

Exit: policy tests exercise actual production functions; no existing entry point silently changes mode yet.

### Phase 2 — native default and clean worker transitions

- Remove the implicit default-on relationship in `larkToolBindingEnabled`.
- Introduce explicit host/user/bound/delegated mode handling in worker spawn, shell execution, restart, and credential publication.
- Preserve existing explicit binding settings and personal-policy settings.
- Add native-baseline provenance and atomic session-artifact cleanup.
- Verify Linux PTY/Tmux and a second CLI before moving shared worker logic further.

Exit: native → managed → native behaves correctly, with stale processes denied access to later managed identities.

### Phase 3 — unify entry admission and persistence

- Integrate human input, scheduler, webhook, and group entry with one admission service.
- Pass host authority kind explicitly; retain delegated handling ahead of default resolution.
- Freeze the versioned decision across queue/recovery/restart.
- Retain exact-turn publication fixes and lifecycle synthetic evidence rules.

Exit: all four primary entry types implement the same off/unassigned behavior and explicit-selection error semantics.

### Phase 4 — configuration/API/UI migration

- Separate user lookup from requested-scope capability checks.
- Add the fixed bot assignment for the broader assigned-user contract; retain automatic-only compatibility.
- Update config schema, bot serialization/projections, dashboard controls, localized text, CLI help, and policy preview.
- Update both identity documents to remove outdated instructions requiring manual binding-off migration for ordinary unconfigured native bots.
- Add UI screenshots from preview using synthetic accounts.

Exit: settings and saved values match actual execution; repair and clear operations work without temporary configuration workarounds.

### Phase 5 — preview acceptance and release integration

- Run focused tests and build on an isolated preview copy; then compare exact file hashes with the candidate being integrated.
- Integrate validated changes into preview/dev canonical and perform live validation as described below.
- Prepare a Chinese PR describing shared paths, affected platforms/CLIs/session types, actual test results, migration, and screenshots.
- Integrate into release only after acceptance; online remains on its release canonical checkout.

Each phase should be a reviewable change with behavioral checks. Do not combine unrelated CLI/model/provider updates or dependency migrations into this refactor.

## 12. Verification plan

All builds and tests run on preview, with isolated configuration/data and temporary test-only variables. Do not install dependencies in a worktree. Reuse canonical dependencies only when package/lock requirements match.

### 12.1 Policy and configuration tests

Test per tool, not just a global switch:

- Per-turn off/unassigned selects host for all four entry types, with identity cache, union lookup, OAuth, and platform service unavailable.
- Per-turn on selects the human sender; absent verified identity denies only the managed requirement.
- Assigned user without per-turn auth works through an enforceable selected-user wrapper, including tools other than Lark when supported. Do not require globally enabling sender mode to support a fixed personal account.
- Task/connector override wins over valid, invalid, revoked, or unsupported lower-priority defaults.
- Invalid winning selection does not become host or another user.
- Fixed bot assignment versus automatic-only compatibility has explicit tests for human turns.
- Binding unset/true/false, P tools empty/subset, missing optional fields, invalid tools, cross-app users, API clear versus malformed input.
- Save-time requested scope and run-time effective scope agree.

### 12.2 Real child-tool behavior with fake providers

Use fake binaries/credential providers and actual wrapper/runner processes. Assert observable execution identity and exit behavior:

- Host environment contains synthetic native credentials and custom native HOME/profile; off/unassigned command sees them unchanged.
- Managed user A sees A's synthetic credentials and cannot obtain the native account or user B.
- Switching back to host removes only Botmux-injected state and restores the original synthetic native settings.
- Lark/codebase/bytedcli/larkdev and configured git askpass behavior remain consistent with tool scope.
- Bound-app credentials do not leak into subsequent native turns.
- Missing native login produces the fake tool's ordinary authentication error, not Botmux missing-requester errors.
- Native profile overrides work in host mode; conflicting overrides in constrained managed mode are refused.
- Late child/background processes cannot borrow a later managed turn's credentials.

Use `test/helpers/ts-runner.ts` for spawned TypeScript tests and the repository import helper when importing repo `.js` specifiers. Do not assert source strings except documented structural invariants.

### 12.3 Entry and lifecycle matrix

| Dimension | Required cases |
|---|---|
| Human chat | New topic, reply, P2P, chat-scope, thread-scope, bot sender |
| Schedule | Legacy owner-only, verified creator, selected user, silent, new-topic, retained live/cold session, multi-target, delegated empty/nonempty scope |
| Group entry | Bot/human/unknown inviter; gate on/off; shared/plain/new-topic; repo picker and auto-worktree |
| Webhook | Default unset/valid/invalid/revoked/unsupported; explicit override; payload spoofing; idempotent retry; existing/new session |
| Lifecycle | Queue A/B, native → A → native → B, restart, suspend/restore, config edits, storage flip, continuation, native cron association |
| Backend | Linux PTY/Tmux; managed RPC; remote/adopt/external-server native behavior and managed capability rejection |
| CLI | TraeX plus at least Claude Code and Codex where affected shared paths differ |
| Platform | Linux runtime; macOS native paths and cleanup semantics without claiming Linux attestation guarantees |
| Sandbox | Off/on/scratch, host loopback available/unavailable, custom HOME/PATH, explicit credential file access |
| Packaging | Source/dist execution and standalone binary self-spawn |

For sandboxed native execution, validate access to the configured native credential locations under the existing sandbox policy. If native credential access requires a new carve-out, make that requirement visible and bounded; do not disable sandboxing or copy every account store. Remote native mode uses the remote environment's stores.

### 12.4 Existing suites to adapt and retain

Start with `automation-identity`, `ipc-lark-tool-identity`, `turn-cli-identity`, `scheduler-silent-execute`, `schedule-delegated-runtime`, `trigger-session-root-message`, `group-join-shared-routing`, `group-join-owner`, `identity-spawn-matrix`, `identity-storage-model`, `identity-decision-flip`, worker Lark integration/restart tests, child-env tests, and dashboard config/serialization/redaction tests.

Run appropriate repository test scripts and `bun run build`. Broaden checks where new shared worker/env/IPC changes justify it. Record failures and baseline comparison explicitly; do not call a run with failures “fully green.”

### 12.5 Live preview acceptance

Use dedicated preview bot/test resources and synthetic test instructions; do not replay production incident handling.

1. With per-turn identity off, no assignment, and binding unset, perform harmless reads in a human chat, an actual scheduled fire, an actual bot invitation/group entry, and a webhook. Verify native host account behavior for each.
2. Repeat with an assigned user and with per-turn sender mode. Use two authorized test principals to prove the choice changes as specified.
3. Exercise one queued native/user transition and a session restart; verify no credential carryover.
4. Verify an invalid explicit assignment blocks before business side effects and can be repaired through the UI in one operation.
5. Verify a delegated run with no personal grant remains unable to gain a human actor through defaults.
6. Confirm real OAuth/resource scopes separately from policy selection. Existing grants can expire; do not attribute every native/provider error to Botmux.
7. Check actual supervisor/daemon/dashboard processes and logs after deployment. Verify IPv6 URLs using bracketed literal hosts and existing URL helpers.

These live checks are required before claiming the original incident is resolved end to end. Unit tests with fake tokens prove policy/transport behavior, not real provider authorization.

## 13. Rollout and rollback

### Preview

Confirm machine, checkout, branch, baseline, and dirty state. Preserve existing work. Build/test in isolation, then integrate into preview/dev canonical. For live verification use `bun run switch:here && bun run daemon:restart`; confirm actual processes and logs. Never use bare node or propagate build-only `CI` into daemon startup.

### Online

After acceptance, integrate the reviewed changes into `feat/byte_approval/release`. Confirm online's canonical checkout, branch, commit, worktree state, dependency version, configuration, and global wrapper target before deployment. Back up configuration and relevant authority/session metadata with secret-safe handling.

Newly native behavior for off/unassigned is intentional compatibility restoration. Existing explicitly bound or managed runs keep their chosen behavior. Drain or restart incompatible live sessions before new decisions are admitted; do not rewrite their active identity in place.

### Rollback

Rollback code and protocol-aware session state together. An older build may re-enable implicit binding, so a code-only rollback can recreate the incident. Prepare explicit per-bot binding settings for affected native bots in the rollback procedure, and preserve newer managed/delegated decisions or stop/re-admit those sessions rather than letting an older reader guess their mode.

Do not remove native host login stores. Do not roll back by deleting shared dependencies. Reconcile missed business writes separately with deduplication and readback; do not automatically replay incident lifecycle actions.

## 14. Acceptance checklist

- [ ] Off/unassigned runs with host credentials across normal chats, schedules, group entry, and webhooks without extra configuration.
- [ ] Unset Lark binding no longer changes native authentication implicitly.
- [ ] Explicit assignments and per-turn sender policy obey the documented precedence per tool.
- [ ] No configured managed failure silently becomes native execution or another user.
- [ ] Native mode does not fabricate a human caller/controller or require creator union-ID backfill.
- [ ] Delegated runs cannot acquire host credentials, fixed users, or wider actor permissions outside their grants.
- [ ] Worker capability and frozen decisions survive all queue/recovery/restart paths.
- [ ] Managed → native transitions preserve native settings and clear only managed artifacts.
- [ ] Save-time validation uses the requested scope, not a stale lower-priority policy.
- [ ] Old persisted states have an explicit migration/restart treatment; no null-based guessing remains.
- [ ] Tests execute real policy/runner behavior and cover another CLI on shared paths.
- [ ] Live preview checks pass for every incident entry type, including real user authorization/resource access.
- [ ] Documentation/UI/config defaults agree; screenshots and actual validation accompany the PR.
- [ ] Release deployment and rollback preserve online's canonical branch, IPv6 access, and fleet recoverability.

## 15. Boundaries of this plan

This is a policy refactor, not an OS-account switch, model-account migration, or independent MCP credential redesign. It does not promise cross-user isolation for arbitrary native tools whose credentials are intentionally shared by the operator. It must preserve the managed-user isolation guarantees whenever managed mode is selected.

The current working tree remains the implementation baseline for subsequent work; this plan does not assert that its earlier test results validate the new native-default contract. Implementation and preview verification are still required.
