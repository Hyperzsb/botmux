# Fix Plan: `feat/byte_approval/dev` Code & Runtime Review Findings

- **Date**: 2026-11-20
- **Reviewed Baseline**: `master` (`2c41ebe61`) → `feat/byte_approval/dev` (`bb64bf932`, 13 commits) + uncommitted ordinary-IM contract admission patch (`src/core/worker-pool.ts`, `src/types.ts`, `src/worker.ts`, `test/ordinary-im-contract-admission.test.ts`).
- **Live Validation Source**: `preview` (`2605:340:cd52:700:bf87:dee0:bd61:d0ef`) runtime stores (`schedule-authority.sqlite`, `sessions.db`, `bots.json`, `connectors.json`), daemon logs (`daemon-0-out.log`, `daemon-0-err.log`), and Nov 17–20 TRAE rollouts.
- **Scope**: Concrete fix specifications, regression-impact checks, and test/verification plan for **every** finding (10 High, 9 Medium, 6 Low, 3 Design-Doc Gaps).

---

## Cross-Cutting Impact Summary (`AGENTS.md` Pre-Change Check)

Most fixes below touch shared layers (`src/core/`, `src/services/`, `src/daemon.ts`, `src/dashboard/`):

| Dimension | Affected Surface | Required Regression Check |
|---|---|---|
| **Cross-Platform** | Linux (daemon/preview/online) vs macOS (local dev): Linux-only process attestation (`/proc` in `detached-scheduled-identity.ts`, `background-execution-policy.ts`) and POSIX shell scripts (`cli-identity.ts` wrapper guards). | Run build and tests on `preview` (Linux); keep `cli-identity.ts` POSIX `sh`-compatible (no bashisms). |
| **Cross-CLI** | `traex`, `claude-code`, `codex` (including `codex-app`), `pi`, etc. All share `turn-cli-identity.ts`, `cli-identity.ts`, `worker-pool.ts`, and `dashboard-ipc-server.ts`. | Verify at least `traex` + one non-TRAE CLI (`codex` or `claude-code`) in unit/integration tests and live preview. |
| **Cross-Backend & Session Type** | `PtyBackend` vs `TmuxBackend`; thread vs chat vs `headless` vs `adopted`; scheduled vs webhook (`trg_*`) vs group-join (`join_*`) vs ordinary IM vs delegated vs detached background jobs; sandbox on vs off; `larkToolBinding` on vs off. | Cover every touched combination in targeted tests below; verify `triggerUserAuth` off/on × `larkToolBinding` off/on × `toolIdentity` / `automationIdentity` / `runAsUser` matrix. |

---

## Phase 0 — Land Verified Patch & Restore Skipped Regression Test

### P0.1 — Commit Uncommitted Ordinary-IM Contract Admission Patch
- **Files**: `src/core/worker-pool.ts`, `src/types.ts`, `src/worker.ts`, `test/ordinary-im-contract-admission.test.ts`
- **Status**: Already verified live on `preview` (resolved Nov 17/20 `current_execution_unverified` exit 77 failures on follow-up turns after scheduled Turn 1, e.g., session `f9ebd21d`).
- **Action**:
  1. Run `test/ordinary-im-contract-admission.test.ts` and `test/session-contract.test.ts` on `preview`.
  2. Commit these 4 files as a clean standalone commit on `feat/byte_approval/dev` before starting Phase 1 so the baseline is reproducible.

### H10 — Re-enable Skipped Refusal-Recovery Test Broken by `1fef331d9`
- **Files**:
  - `test/session-contract-recovery.test.ts:70-75, 220-237`
  - Reference: `src/worker.ts:34637`
- **Root Cause**: Commit `1fef331d9` added a call to `retryObservedRuntimeBindingAfterRefusal(msg.bindingId)` inside `handleContractDaemonMessage`, without injecting it into `workerHostPair`'s mocked `env`. Commit `5d29482df` skipped the test as `BASELINE_FAILURE(1fef331d)` instead of fixing the harness.
- **Fix Plan**:
  1. In `test/session-contract-recovery.test.ts` (`workerHostPair`), add `retryObservedRuntimeBindingAfterRefusal` to the mocked `env` (recording calls and/or invoking the binding retry callback to assert refusal triggers a re-bind attempt).
  2. Remove `it.skip` and the `BASELINE_FAILURE(1fef331d)` comment at lines 220–237.
  3. Add an assertion verifying `retryObservedRuntimeBindingAfterRefusal` is called with the refused `bindingId`.
- **Verification**: Run `vitest` and `bun test` on `test/session-contract-recovery.test.ts` on `preview`.

---

## Phase 1 — Live Bugs Confirmed on `preview`

### H1 — Stop Firing Spurious Schedule Identity Claim Cards (`no_creator`) When Explicit `runAsUser` / `automationIdentity` / Host Mode Applies
- **Files**:
  - `src/daemon.ts:4693-4760` (`prepareScheduledTurnCliIdentity`)
  - `src/core/schedule-identity-claim.ts:59-79` (`resolveScheduledRunIdentity`)
- **Live Evidence**: On `preview`, task `d4813a6e` ran with valid explicit `runAsUser` (`ou_06308430...`), yet `schedule_identity_claim_cards` recorded `status="pending", reason="no_creator"` 24s later for that same turn because the task's creator lacked `ownerUnionId`.
- **Root Cause**: `prepareScheduledTurnCliIdentity` unconditionally calls `resolveScheduledRunIdentity(task, ds.larkAppId, ...)` — which only inspects creator/claim (`scheduledTaskRunAs`) — and calls `noteScheduledIdentityGap` on failure even when:
  - `task.runAsUser` (or `frozenDecision` with `user` from `task`/`bot_default`/`automatic_default`) already supplies the execution user, OR
  - `publicationPolicy.perTurnTools.length === 0` (host mode; no user identity is required at all).
- **Fix Plan**:
  1. Determine whether the turn actually relies on creator/claim provenance before resolving or emitting a claim gap:
     - Check whether `task.runAsUser` is set (after applying `snapshot`), OR `frozenDecision?.user` is present, OR `frozenDecision?.source` is `'task' | 'bot_default' | 'automatic_default'`.
     - Check whether `publicationPolicy.perTurnTools.length === 0` (no per-turn-governed tool requires a creator provenance).
  2. Only invoke `resolveScheduledRunIdentity` + `noteScheduledIdentityGap` when the turn actually needs creator/claim provenance (`!task.runAsUser && !frozenDecision?.user && publicationPolicy.perTurnTools.length > 0`).
  3. When `task.runAsUser` is present, still call `noteSenderUnionId(ds.larkAppId, task.runAsUser.openId, task.runAsUser.unionId)` (already done via `assertTurnIdentitySession` when `managed_user`, and explicitly guard for `bound_app` as well) so unionId cache stays warm without consulting `scheduledTaskRunAs`.
  4. On `preview`, after deploying, inspect existing pending spurious rows in `schedule_identity_claim_cards` for tasks that now have explicit `runAsUser` (optionally dismiss/mark resolved when a task runs successfully with `runAsUser`, or document manual cleanup).
- **Tests**:
  - Update `test/schedule-identity-claim.test.ts` and `test/schedule-identity-claim-card-route.test.ts`:
    - Task with explicit `runAsUser` and missing `ownerUnionId` does **not** emit a claim card or call `noteScheduledIdentityGap`.
    - Task with bot `automationIdentity` / `toolIdentity` and missing `ownerUnionId` does **not** emit a claim card.
    - Host-mode bot (`triggerUserAuth` off) legacy task without `ownerUnionId` does **not** emit a claim card.
    - Per-turn-auth-on task with no `runAsUser` / `automationIdentity` and missing `ownerUnionId` **still** emits the `no_creator` claim card.

### H2 — Fix `bytedcli-renewal` Unbounded Leak on Completed Turns, Partial-Site Failure Spin, Dropped `regionalCloudJwts`, and `larkdev` Parity
- **Files**:
  - `src/core/bytedcli-identity-renewal.ts:1-175`
  - `src/core/worker-pool.ts:22065-22080` (turn terminal authority release)
  - `src/core/active-identity-turns.ts:43-74`
  - `src/core/turn-cli-identity.ts:544, 607, 1066`
  - `src/daemon.ts` (session close / teardown cleanup)
- **Live Evidence**: On `preview`, completed turns on sessions `cddbf5de` and `db78e7a9` (`schedule:d48`) were renewed 16+ times over 21+ hours after turn retirement until daemon restart.
- **Root Cause**:
  1. `stillPublished(entry)` only checks `recallProvenIdentityContent(...)`, which is not cleared on turn completion (`releaseActiveIdentityTurn` is called at `worker-pool.ts:22069`, but proven content stays cached in memory/disk until GC or session close).
  2. In `renewPublishedIdentity` (`bytedcli-identity-renewal.ts:90-113`), when `siteEntries.length > 0`, merging `{ ...entry.identity.cloudJwts, ...jwts.cloudJwts }` leaves any failed site's expired JWT inside `cloudJwts`; `bytedcliIdentityExpiryMs` takes `Math.min(...)`, which remains `< now()`, causing a renewal attempt on **every** 5-minute sweep forever.
  3. The `siteEntries.length > 0` branch omits `regionalCloudJwts` from the returned object, so regional JWTs are never refreshed in multi-site setups.
  4. `larkdev` identities are never tracked or renewed (if a long turn uses `larkdev` beyond ~2h, its ByteCloud JWT expires without renewal).
- **Fix Plan**:
  1. **Stop renewing completed/retired turns**:
     - Export `untrackBytedcliIdentityRenewal(sessionDataDir, sessionId, turnId)` and `untrackSessionBytedcliIdentityRenewals(sessionDataDir, sessionId)` from `src/core/bytedcli-identity-renewal.ts`.
     - Call `untrackBytedcliIdentityRenewal` wherever `releaseActiveIdentityTurn` is called (`src/core/worker-pool.ts:22069-22072`, `src/core/detached-scheduled-identity.ts:211`), and call `untrackSessionBytedcliIdentityRenewals` on session close (`clearActiveIdentityTurns` / `forgetProvenIdentityContent(sessionDataDir, sessionId)` in `src/daemon.ts:4633`).
     - In `stillPublished(entry)`, ALSO check active turn membership via `activeIdentityTurns(entry.sessionDataDir, entry.sessionId)` (returning `false` if `turns !== null && !turns.includes(entry.identity.turnId)`), as defense-in-depth so even missed release paths cannot leak forever.
  2. **Preserve `regionalCloudJwts` & prevent partial-site spin**:
     - In `renewPublishedIdentity` (`siteEntries.length > 0` loop): accumulate `regionalCloudJwts` across sites (`Object.assign(regionalCloudJwts, jwts.regionalCloudJwts)`), and return it when non-empty.
     - Track per-entry/per-site `failedSites: Map<string, number>` (next-retry timestamp with exponential backoff, e.g., 5m → 15m → 30m, capped, cleared on success) and exclude sites in backoff from triggering immediate sweep retries (or compute sweep trigger from the soonest *eligible* JWT expiry).
  3. **Support `larkdev` renewal (or make scope explicit)**:
     - Generalize `RenewalEntry` to carry `tool: 'bytedcli' | 'larkdev'` (default `'bytedcli'`), keying on `[sessionDataDir, sessionId, turnId, tool]`, and call `trackBytedcliIdentityRenewal` for locally minted `larkdev` turns in `turn-cli-identity.ts` as well, writing back with `tool: entry.tool`. (Check `cli-identity.ts` so `writeSessionIdentity` for `bytedcli` also keeps `codebase` companion refreshed when `codeJwt` changes.)
- **Tests**:
  - Update `test/bytedcli-identity-renewal.test.ts`:
    - Completed/released turn is evicted and never renewed on subsequent sweeps.
    - Partial site renewal failure backs off instead of spinning every sweep; `regionalCloudJwts` are preserved and renewed in multi-site mode.
    - `larkdev` locally-minted turn is renewed and evicted on release.

### H3 — Stop Webhook Triggers from Polluting `session.ownerOpenId`, `senderOpenId`, and `pendingSender` with `executionUser`
- **Files**:
  - `src/core/trigger-session.ts:866-885` (`prepareExecutionIdentity`)
  - `src/core/trigger-session.ts:1495-1500, 1984, 2053-2057, 2104-2106`
- **Live Evidence**: In `preview`'s `sessions.db`, webhook turns (`trg_*`) store `sender: "ou_1d86229a..."`, causing `botmux send --mention-back` in rollout transcripts to emit `@ou_1d86229a...（未知）`.
- **Root Cause**:
  1. `trigger-session.ts:1984` sets `session.ownerOpenId = executionUser.openId; session.ownerUnionId = executionUser.unionId;` — promoting the tool-credential account (`runAsUser` / `automationIdentity` / `toolIdentity`) into the **session controller/owner** (`BOTMUX_OWNER_OPEN_ID`), violating `docs/plans/2026-11-06-tool-identity-policy-refactor.md` §5.3.
  2. `trigger-session.ts:873` sets `senderOpenId: executionUser.openId` on `replyTargets[triggerId]`, and line `2055` sets `newDs.pendingSender = { openId: executionUser.openId, name: executionUser.name, type: 'user' }`, fabricating a fake human IM sender on an automatic webhook turn.
  3. `trigger-session.ts:867` returns early when `!executionUser`, so host-mode webhooks never freeze `toolIdentityDecision` on `replyTargets[triggerId]` (a later bot config change can retroactively alter an in-flight/recovered webhook turn).
- **Fix Plan**:
  1. Remove `session.ownerOpenId = executionUser.openId; session.ownerUnionId = executionUser.unionId;` at `trigger-session.ts:1984`. Keep `session.ownerOpenId` unset on non-human webhook sessions (matching scheduled tasks).
  2. Remove `senderOpenId: executionUser.openId` from `replyTargets[triggerId]` at `trigger-session.ts:873` and remove `newDs.pendingSender = ...` at `trigger-session.ts:2055` (keep `newDs.pendingTrustedCaller = trustedCaller` and `newDs.pendingTurnId = triggerId` so `managedTurnOrigin.callerOpenId` still receives the verified `executionUser.openId` via `trustedCaller`, without pretending an IM human sent the message).
  3. Verify all readers of `replyTargets[triggerId]` for webhook turns:
     - `turn-cli-identity.ts` / `daemon.ts` / `dashboard-ipc-server.ts` already read `automationUser` / `toolIdentityDecision` / `trustedCaller`, NOT `senderOpenId`, for automatic turns.
     - Verify `botmux send --mention-back` gracefully skips `@mention` when `senderOpenId` is absent (same as scheduled turns).
  4. Always run `prepareExecutionIdentity` (remove `if (!executionUser) return;` early exit for the freeze step; guard only `assertAutomationSession` and `automationUser` attachment on `if (executionUser)`) so host-mode webhooks still freeze `toolIdentityDecision` with `{ authority: 'automatic', source: 'none', user: undefined, baseline: ... }` on `replyTargets[triggerId]`.
- **Tests**:
  - Update `test/automation-identity.test.ts` and `test/trigger-api.test.ts`:
    - Webhook with `runAsUser` / `automationIdentity` / `toolIdentity` does **not** set `session.ownerOpenId`, `replyTargets[triggerId].senderOpenId`, or `pendingSender`, while **still** setting `automationUser`, `toolIdentityDecision`, `pendingTrustedCaller`, and publishing tool credentials for `executionUser`.
    - Host-mode webhook (`executionUser` undefined) still freezes `toolIdentityDecision` on `replyTargets[triggerId]`.

---

## Phase 2 — Tool-Identity Policy, Authorization & Provenance Correctness

### H4 — Fix `selectToolCredential` `bindingInstalled` Short-Circuit & `/lark-tool-identity` `fixedBotUser` Resolution
- **Files**:
  - `src/core/tool-identity-policy.ts:258-334` (`selectToolCredential`)
  - `src/daemon.ts:4665-4691` (`assertTurnIdentitySession`)
  - `src/core/turn-cli-identity.ts:285-315`
  - `src/core/dashboard-ipc-server.ts:3640-3690` (`POST /api/sessions/:sessionId/lark-tool-identity`)
- **Root Cause**:
  1. `selectToolCredential` checks `if (tool === 'lark-cli' && input.bindingInstalled) return { mode: 'bound_app', ... }` at the very top, **before**:
     - Checking `assignmentApplies && input.turn?.failure` (so a frozen `invalid_identity` / `access_denied` / `config_invalid` turn returns `bound_app` instead of `denied`, bypassing `assertTurnIdentitySession` at `daemon.ts:4678`).
     - Checking `assignmentApplies` (`!input.turn?.tools || input.turn.tools.includes('lark-cli')`), so `input.turn.user` is attached to `{ mode: 'bound_app', user }` even when `lark-cli` is excluded from `turn.tools`.
     - Checking `policy.fixedBotUser` / `isInvalidToolIdentity(policy.fixedBotUser)` on human turns when `triggerUserAuth` is off.
  2. In `dashboard-ipc-server.ts:3646-3672`, when `larkToolBinding: true`, `triggerUserAuth` is off, and `bot.toolIdentity` (`fixedBotUser`) is configured for `lark-cli`, `--as user` resolves `sender` from `liveOrigin.callerOpenId` (the chat sender) instead of `bot.toolIdentity.user.openId` (violating Plan §3.2 Row 2 & §3.4).
- **Fix Plan**:
  1. In `selectToolCredential` (`src/core/tool-identity-policy.ts`):
     - Compute `assignmentApplies` first (with explicit empty-array semantics — see M3 below).
     - Evaluate failure gates BEFORE `bindingInstalled`:
       - If `assignmentApplies && input.turn?.failure`, return `{ mode: 'denied', reason: input.turn.failure, source: input.turn.source ?? 'automatic_default' }`.
       - If `!input.turn && policy.fixedBotUser && isInvalidToolIdentity(policy.fixedBotUser)` (and `tool` is subject to it / no narrower tools known), return `{ mode: 'denied', reason: 'config_invalid', source: 'automatic_default' }`.
     - Inside `if (tool === 'lark-cli' && input.bindingInstalled)`:
       - Only attach `user` when `lark-cli` is actually mapped to a managed user:
         - `assignmentApplies && input.turn?.user` → `user: input.turn.user`
         - else if human turn & `!policy.perTurnTools.includes('lark-cli')` & valid `policy.fixedBotUser` covering `'lark-cli'` → `user: policy.fixedBotUser.user`
         - else omit `user`.
  2. In `dashboard-ipc-server.ts:3640-3690` (`POST /api/sessions/:sessionId/lark-tool-identity` `--as user` path):
     - Evaluate `selectToolCredential` (or read frozen `toolIdentityDecision` + `bot.toolIdentity`) for `tool: 'lark-cli'` with `bindingInstalled: true`:
       - If `decision.mode === 'denied'`, return `403` with the denial reason.
       - If `decision.mode === 'bound_app' && decision.user`, use `decision.user.openId` (and `decision.user.unionId`) as the target user instead of `liveOrigin.callerOpenId` (while still honoring `delegated?.targetOpenId` first when delegated).
- **Tests**:
  - `test/tool-identity-policy.test.ts`:
    - `bindingInstalled: true` + `turn.failure = 'invalid_identity'` returns `denied`, not `bound_app`.
    - `bindingInstalled: true` + `turn.tools = ['bytedcli']` returns `bound_app` **without** `user`.
    - `bindingInstalled: true` + human turn + `triggerUserAuth` off + `fixedBotUser` covering `lark-cli` returns `bound_app` with `user = fixedBotUser.user` (and `denied` if `fixedBotUser` is invalid).
  - `test/ipc-lark-tool-identity.test.ts`:
    - Bound app + `triggerUserAuth` off + `toolIdentity` covering `lark-cli` resolves `--as user` to `toolIdentity.user`, not the chat sender.

### H5 — Preserve `automationIdentity.tools` in `executeScheduledTask`
- **Files**: `src/core/session-manager.ts:4640-4647`
- **Root Cause**: `resolveAutomationIdentity` returns the winning `tools` (`[...fixed.tools]` when `toolIdentity` wins), but `executeScheduledTask` throws `automationIdentity.tools` away and recomputes `automationIdentityTools(bot.config)` (which ignores `toolIdentity`).
- **Fix Plan**:
  1. Replace lines 4643–4646:
     ```ts
     const automationTools = delegatedRun ? undefined : automationIdentity?.tools;
     ```
  2. Audit all other callers of `resolveAutomationIdentity` (`src/core/trigger-session.ts`, `src/daemon.ts` group-join) to verify they already use `resolved.tools` directly (confirmed: `trigger-session.ts:1366` and `daemon.ts:28345` already use `.tools`).
- **Tests**:
  - `test/automation-identity.test.ts` + `test/scheduler-execution-context.test.ts`:
    - Scheduled task on bot with `triggerUserAuth` off and `toolIdentity = { defaultUser: U, tools: ['bytedcli'] }` freezes `automationIdentityTools = ['bytedcli']` and succeeds without `run_as_requires_managed_tool:lark-cli`.
    - Same setup with `larkToolBinding: true` preserves `['bytedcli']` instead of overwriting with `['lark-cli']`.

### H6 — Reconcile Group-Entry Auto-Start Host-Credential Strip (`joinIdentityConfig`)
- **Files**:
  - `src/daemon.ts:28187-28226, 28342-28358`
  - `docs/automation-execution-identity.md:28`
  - `docs/plans/2026-11-06-tool-identity-policy-refactor.md` §3.2 Row 3, §3.2 Rule 5, §3.3 Class 5
- **Root Cause**: When no `automationIdentity` / `toolIdentity` is configured, `daemon.ts:28193-28194` strips `triggerUserAuth: undefined` from `joinIdentityConfig`, forcing `mode: 'host'` on an automatic group-join turn even when `triggerUserAuth.enabled` is true and even when invited by another bot.
- **Decision Gate (Confirm Before Implementing)**:
  - **Option A (Recommended — matches Plan §3.2 Row 3 & Rule 5, fail-closed)**: Remove the `triggerUserAuth: undefined` strip; pass `botCfg` directly to `resolveAutomationIdentity` (and pass `provenance` only when `operatorIsHuman && operatorOpenId` is verified with unionId, or let per-turn auth deny managed tools with `missing_provenance` while keeping unmanaged tools working / allowing the session to open cleanly without leaking host credentials). Update `docs/automation-execution-identity.md:28` to match.
  - **Option B (If business explicitly wants host fallback on unassigned group join)**: Document it as an explicit exception in Plan §3.2, AND restrict it strictly to non-bot-invited joins (or explicitly audit-log it) so a bot-to-bot group invite can never escalate to host credentials.
- **Tests**:
  - Add unit test in `test/automation-identity.test.ts` (or group-join auto-start test) asserting that when `triggerUserAuth.enabled === true` and no `automationIdentity` is set, a bot-triggered group join never freezes `{ mode: 'host' }` for governed tools.

### H7 — Validate Same-App `larkAppId` for `/config set automationIdentity`
- **Files**:
  - `src/services/bot-config-store.ts:471-478` (`applyConfigFieldInternal`)
  - `src/services/bot-config-store.ts:1217-1225` (`coerceConfigValue`)
- **Root Cause**: `coerceConfigValue` parses `automationIdentity` without `larkAppId`, and unlike `toolIdentity` (`L471-477`), `applyConfigFieldInternal` never re-parses `automationIdentity` with `larkAppId`. Foreign-app `automationIdentity` is accepted and clears `automationIdentityInvalid`.
- **Fix Plan**:
  1. Right next to the `toolIdentity` block in `applyConfigFieldInternal` (`src/services/bot-config-store.ts:471-477`), add:
     ```ts
     if (spec.configKey === 'automationIdentity' && value !== null) {
       const parsed = parseAutomationIdentityConfig(value, larkAppId);
       if (!parsed.value || isInvalidAutomationIdentity(parsed.value)) {
         return { ok: false, reason: `invalid_automation_identity: ${parsed.warning ?? 'invalid_json'}` };
       }
       value = parsed.value;
     }
     ```
  2. Also check whether `automationIdentity` / `toolIdentity` policy eligibility (`assertAutomationUserPolicy` or `canUse`) should be validated on `/config set` consistently with the Dashboard `PUT /api/bot-automation-identity` route (note: preserve ability to configure for offline/valid same-app user, rejecting foreign-app immediately).
- **Tests**:
  - Update `test/automation-identity.test.ts` (or `test/config-allow-owner-identity.test.ts`): `/config set automationIdentity` with a `larkAppId` belonging to another bot fails with `invalid_automation_identity` and does not clear `automationIdentityInvalid`.

### H8 — Include `runAsUser` / `automationIdentity` / `toolIdentity` in Background Keys, Fix Detached Scheduled `runAsUser` Resolution, and Enforce `automationExecutionToolScope` on Closed Detached Sessions
- **Files**:
  - `src/core/background-execution-policy.ts:28-48`
  - `src/core/detached-scheduled-identity.ts:45-133`
  - `src/core/dashboard-ipc-server.ts:3640-3665` (and `automationExecutionToolScope` definition)
- **Root Cause**:
  1. `backgroundAuthorityKey(task)` omits `task.runAsUser` → editing `task.runAsUser` does not invalidate active background jobs or trigger `assertScheduledAuthorityCurrent` drift detection.
  2. `backgroundCredentialPolicyKey(bot)` omits `bot.automationIdentity` and `bot.toolIdentity` (and their invalid markers).
  3. `detached-scheduled-identity.ts:69` uses `resolveScheduledRunIdentity(authority.task, ...)`, which ignores `task.runAsUser` (and frozen `automationUser`), breaking detached jobs started by a `runAsUser`-configured scheduled task.
  4. `dashboard-ipc-server.ts:3659` calls `automationExecutionToolScope(ds, identityTurn)` where `ds` is `undefined` for an automatically-closed session with a valid `detachedForUser`, returning `undefined` and bypassing frozen tool scope restrictions.
- **Fix Plan**:
  1. In `src/core/background-execution-policy.ts`:
     - Add `runAsUser: task.runAsUser ?? null` to `backgroundAuthorityKey(task)`.
     - Add `automationIdentity: bot.automationIdentity ?? null`, `automationIdentityInvalid: bot.automationIdentityInvalid ?? null`, `toolIdentity: bot.toolIdentity ?? null`, `toolIdentityInvalid: bot.toolIdentityInvalid ?? null` to `backgroundCredentialPolicyKey(bot)`.
  2. In `src/core/detached-scheduled-identity.ts` (`resolveAuthorizedScheduledSession`):
     - Resolve the effective execution user from the frozen turn snapshot (`session.replyTargets?.[scheduledTurnId]?.automationUser`) first, then `authority.task.runAsUser`, then `resolveScheduledRunIdentity(authority.task, larkAppId, canOperate)` (preserving `canOperate` / `assertAutomationUserAllowed` checks and `larkAppId` match for every source!).
  3. In `src/core/dashboard-ipc-server.ts`:
     - Change `automationExecutionToolScope` to accept `session: Session | undefined` (instead of requiring active `DaemonSession`) and call it with `ds?.session ?? detachedForUser?.session` at line 3659 so automatically-closed detached sessions still enforce their frozen tool scope.
- **Tests**:
  - `test/registered-background-identity.test.ts`, `test/schedule-authority-store.test.ts`, `test/ipc-lark-tool-identity.test.ts`:
    - Editing `task.runAsUser` or `bot.automationIdentity` / `bot.toolIdentity` changes `backgroundAuthorityKey` / `backgroundCredentialPolicyKey` and revokes existing detached jobs.
    - Detached job from a `runAsUser` scheduled task (where creator lacks `ownerUnionId`) registers and resolves credentials cleanly.
    - Automatically-closed detached session whose frozen scope excludes `lark-cli` is denied with `automationToolScopeExcluded`.

### H9 — Honor Explicit `executionUser === null` in `trustedCallerForScheduledTask` & `authorizeScheduledTurn`
- **Files**:
  - `src/core/scheduled-turn-provenance.ts:131-163` (`trustedCallerForScheduledTask`)
  - `src/core/scheduled-turn-provenance.ts:244-305` (`authorizeScheduledTurn`)
- **Root Cause**: `if (executionUser !== undefined) task = { ...task, runAsUser: executionUser ?? undefined };` deletes `task.runAsUser` when `executionUser === null` (explicitly frozen "no execution user"), causing both functions to fall through to `scheduledTaskRunAs(task, larkAppId)` (creator/claim).
- **Fix Plan**:
  1. In `trustedCallerForScheduledTask`:
     - If `executionUser === null`: return `undefined` immediately (do **not** fall through to `scheduledTaskRunAs`).
  2. In `authorizeScheduledTurn`:
     - If `input.executionUser === null`: do **not** fall through to `scheduledTaskRunAs` or `task.ownerOpenId`; return `{ error: 'task_owner_missing' }` (or verify whether any host-mode caller expects `authorizeScheduledTurn` to succeed when `executionUser === null` — check all callers of `authorizeScheduledTurn` with `rg` before editing!).
- **Tests**:
  - Update `test/scheduled-turn-provenance.test.ts` and `test/schedule-creator-authorization.test.ts`: passing `executionUser: null` never substitutes creator/claim identity.

---

## Phase 3 — Medium-Severity Fixes

### M1 — Fix Offline Bot Recovery Rows for Invalid `toolIdentity` & `automationIdentity`
- **Files**: `src/dashboard/bot-payload.ts:249-254, 366-369`
- **Fix Plan**:
  1. Run both `parseToolIdentityConfig(raw.toolIdentity, raw.larkAppId)` and `parseAutomationIdentityConfig(raw.automationIdentity, raw.larkAppId)` on offline recovery rows, matching the online bot payload mapper.
  2. When invalid, set `toolIdentity: null` + `toolIdentityInvalid: parsed.value.invalid` (and same for `automationIdentity` / `automationIdentityInvalid`), never leaking `{ invalid: "..." }` sentinel objects into the valid field.
- **Tests**: Add offline-row test cases in `test/automation-identity.test.ts` or dashboard bot-payload tests.

### M2 — Align Explicit `Run as` Tool Scope with `toolIdentity.tools` When `triggerUserAuth` Is Off
- **Files**:
  - `src/core/tool-identity-policy.ts:150-157`
  - `src/services/automation-identity-config.ts:150-155`
  - `src/services/automation-identity.ts:186`
- **Root Cause**: `explicitTools` computes `policy.perTurnTools.length ? [...policy.perTurnTools] : ['lark-cli']`, ignoring `policy.fixedBotUser.tools`. When `triggerUserAuth` is off and `toolIdentity.tools = ['bytedcli']`, an explicit task/connector `runAsUser` either fails with `run_as_requires_managed_tool:lark-cli` or splits one turn across two different users (`runAsUser` for `lark-cli` and `fixedBotUser` for `bytedcli`).
- **Fix Plan**:
  1. Derive `explicitTools` from the union of configured managed tools when `perTurnTools` is empty:
     - If `policy.perTurnTools.length > 0` → `[...policy.perTurnTools]`
     - Else if valid `policy.fixedBotUser?.tools?.length` → `[...policy.fixedBotUser.tools]` (plus `'lark-cli'` if `larkToolBinding === true`, deduplicated)
     - Else `['lark-cli']`.
  2. Mirror the exact same helper in `explicitAutomationIdentityTools(botConfig)` (`src/services/automation-identity-config.ts`) so scheduler/trigger/policy cannot drift apart.
- **Tests**: Add tests in `test/tool-identity-policy.test.ts` and `test/automation-identity.test.ts` for `triggerUserAuth` off + `toolIdentity.tools = ['bytedcli']` + task `runAsUser = UserA` (asserting single principal `UserA` for `bytedcli`, no split principal).

### M3 — Eliminate Contradictory Handling of Empty `tools: []` vs Omitted `tools: undefined`
- **Files**:
  - `src/core/tool-identity-decision.ts:80, 119`
  - `src/core/tool-identity-policy.ts:292`
  - `src/core/dashboard-ipc-server.ts` (`automationExecutionToolScope`)
- **Root Cause**: `tool-identity-decision.ts` drops `tools: []` to `undefined`; `selectToolCredential` treats `undefined` as *all* tools (`!input.turn?.tools || ...`), whereas `automationExecutionToolScope` treats `undefined` on a frozen automatic decision as *no* tools (`[]`).
- **Fix Plan**:
  1. Preserve `tools: []` explicitly in `tool-identity-decision.ts` (only omit when input was genuinely `undefined`, NOT when `tools.length === 0`).
  2. Document and enforce a single contract across `selectToolCredential`, `tool-identity-decision.ts`, and `automationExecutionToolScope`:
     - `tools: undefined` = legacy/unscoped record (no tool restriction recorded; falls back to legacy handling).
     - `tools: []` = explicitly zero managed tools (no tool matches `tools.includes(tool)`).
- **Tests**: Add round-trip serialization + evaluation tests for `tools: []` vs `tools: undefined` in `test/tool-identity-policy.test.ts` and `test/identity-decision-wiring.test.ts`.

### M4 — Preserve Frozen Identity on Ordinary-Turn Recovery for Webhook (`trg_*`) Turns and Non-`automationUser` Decisions
- **Files**: `src/core/worker-pool.ts:3056-3078` (`ensureOrdinaryTurnRecoveryAttached`)
- **Root Cause**:
  1. Line 3059 (`if (!scheduledTaskId) return;`) exits early for webhook (`trg_*`) and group-join (`join_*`) recovery continuations, dropping their frozen `automationUser`, `toolIdentityDecision`, `automationIdentitySource`, and `automationIdentityTools` and skipping `prepareRawInputTurn`.
  2. Line 3062 (`if (snapshot !== undefined)`) skips copying `toolIdentityDecision` when `automationUser` is absent (e.g., host-mode or fixed-user decisions).
- **Fix Plan**:
  1. Check `const prior = ds.session.replyTargets?.[dispatch.logicalTurnId];` for **any** automatic/frozen turn (`scheduledTaskId || prior?.automationUser !== undefined || prior?.toolIdentityDecision !== undefined`).
  2. Copy `automationUser`, `toolIdentityDecision`, `automationIdentitySource`, and `automationIdentityTools` whenever ANY of them is defined on `prior`, persist `sessionStore.updateSession(ds.session)`, and call `callbacks?.prepareRawInputTurn?.(ds, dispatch.turnId)`.
  3. On `enqueue` (`worker-pool.ts:3088-3090`), also preserve `trustedCaller` for recovered webhook/group-join turns from `prior?.automationUser` via `automationTrustedCaller(prior.automationUser)` when `!scheduledTaskId && !appRecovery && prior?.automationUser`.
- **Tests**: Add recovery continuation test for webhook (`trg_*`) turn with `runAsUser` and for host-mode scheduled turn with `toolIdentityDecision` in `test/automation-identity.test.ts` (or ordinary-turn recovery test suite).

### M5 — Honor `toolIdentity.credentialSource` in `lark-tool-platform-credential.ts`
- **Files**: `src/core/lark-tool-platform-credential.ts:37-42`
- **Root Cause**: `boundLarkPlatformPolicy` only inspects `triggerUserAuthApplies(bot.triggerUserAuth, 'lark-cli')`, ignoring `bot.toolIdentity.credentialSource` when `triggerUserAuth` is off and `larkToolBinding: true`.
- **Fix Plan**:
  1. Check `triggerUserAuthApplies(bot.triggerUserAuth, 'lark-cli')` first; if false, check whether `bot.toolIdentity` is valid and covers `'lark-cli'`, and use `bot.toolIdentity.credentialSource` (default `'auto'`).
- **Tests**: Update `test/lark-tool-platform-credential.test.ts` with `triggerUserAuth` off + `larkToolBinding: true` + `toolIdentity: { user, tools: ['lark-cli'], credentialSource: 'platform' | 'bot-app' }`.

### M6 — Fix Auth Login/Logout Races in `lark-cli-auth.ts`
- **Files**: `src/services/lark-cli-auth.ts:511, 586-635, 671-730`
- **Root Cause**:
  1. `completeLarkCliLogin` calls unconditional `clearChallenge(openId)` instead of `clearChallengeIfCurrent(openId, code)`, allowing an expiring old poll to delete a freshly started login challenge.
  2. `materializeLarkCliHomeForSession` runs `await runAsUser(openId, ['auth', 'status', '--json', '--verify'])` without capturing and re-checking `readCliAuthEpoch(openId)` before `cpSync`, racing with a concurrent `/logout`.
- **Fix Plan**:
  1. Restore `clearChallengeIfCurrent(openId, expectedChallengeIdOrCode)` in `completeLarkCliLogin` so an older poll only clears its own challenge record.
  2. In `materializeLarkCliHomeForSession`, capture `const epochBefore = readCliAuthEpoch(openId)` before `runAsUser(...)`, re-verify `readCliAuthEpoch(openId) === epochBefore` immediately before `cpSync` (and again after `cpSync` before returning; if changed, clean up the temp copy and return unauthenticated/`null`).
- **Tests**: Update `test/lark-cli-auth.test.ts` to cover concurrent re-login during old challenge expiry and concurrent `/logout` during `materializeLarkCliHomeForSession`.

### M7 — Harden `larkdevSiteGuard` (`--` Terminator & Case/Whitespace Normalization)
- **Files**: `src/core/cli-identity.ts:1322-1360`
- **Root Cause**: Unlike `bytedcliSiteGuard`, `larkdevSiteGuard` does not stop scanning flags at `--` and does not trim/lowercase `$__botmux_site`.
- **Fix Plan**:
  1. Add `--) break ;;` inside the argument loop before matching `--plane` / `--plane=*`.
  2. Normalize `$__botmux_site` using `tr '[:upper:]' '[:lower:]'` and whitespace trimming (matching `bytedcliSiteGuard` verbatim).
- **Tests**: Update `test/cli-identity.test.ts` with `larkdev --plane EU-TTP ...` (accepted) and `larkdev cmd -- --plane invalid` (not rejected as flag).

### M8 — Enforce Non-Empty Required Variables for `larkdev` in `credential-grant-client.ts`
- **Files**: `src/services/credential-grant-client.ts:75-78`
- **Root Cause**: `GRANT_VARIABLE_KEYS.larkdev` sets `required: []`, so `pickVariables` accepts an empty `{}` response from the grant platform as a valid grant.
- **Fix Plan**:
  1. Require at least one valid site/cloud JWT variable (e.g., support `requiredAnyOf` in `GRANT_VARIABLE_KEYS` for `larkdev`, or check after `pickVariables` that at least one recognized `larkdev` token key is non-empty, returning invalid/missing grant if zero keys matched).
- **Tests**: Update `test/turn-cli-identity-platform.test.ts` to assert `{}` platform grant for `larkdev` is rejected at the grant client boundary.

### M9 — Fix Dashboard UI State Reset, `ToolIdentitySection` Controls/Copy, and `CONFIG_FIELDS` Effect Metadata
- **Files**:
  - `src/dashboard/web/bot-defaults-page.tsx:4119, 4493, 4503-4507`
  - `src/services/bot-config-store.ts:210`
  - `src/dashboard/web/i18n` (associated copy keys)
- **Fix Plan**:
  1. On successful save/clear of `automationIdentity` or `toolIdentity`, clear `automationIdentityInvalid: null` / `toolIdentityInvalid: null` in local React state (or replace from the returned bot payload).
  2. In `ToolIdentitySection`:
     - Remove duplicate/conflicting help text.
     - Use a dedicated `botDefaults.toolIdentityInvalid` i18n key instead of reusing `botDefaults.automationIdentityInvalid`.
     - Add UI controls for `tools` (checkbox group over `TRIGGER_USER_AUTH_TOOLS`) and `credentialSource` (`auto` / `local` / `platform`), preserving existing values rather than hardcoding `['lark-cli']` / `'auto'`.
  3. In `src/services/bot-config-store.ts:210`, change `toolIdentity` metadata from `effect: 'immediate'` to `effect: 'next-session'` (wrappers are installed at worker spawn).
- **Tests**: Update Dashboard UI tests (`test/automation-user-picker.e2e.ts` / `test/dashboard-ipc-trigger-user-auth-status.test.ts`) to assert invalid banners clear on save and `tools`/`credentialSource` round-trip.

---

## Phase 4 — Low-Severity Cleanups & Design-Doc Gaps

### Low-Severity Cleanups
| ID | File & Lines | Concrete Fix |
|---|---|---|
| **L1** | `src/core/cli-identity.ts:1503-1615` | Add `${OPEN_ID_VAR}` to the `unset` statement inside the `bytedcli-user)` wrapper branch (matching `user-home` and `larkdev-user`). |
| **L2** | `src/services/tool-identity-config.ts:297-313, 357-377` | Either use `toolIdentityInvalid` in `wrapperIdentityTools` (fail-closed: install wrappers for all tools when `toolIdentityInvalid` is set so broken config cannot leak host creds) or remove unused param; delete dead exports `normalizedAutomaticTools`, `normalizedExplicitTools`, and single-caller `unableAutomationTool` if unused. |
| **L3** | `src/core/tool-identity-policy.ts:42, 223` | Remove unused `entry?: ToolIdentityEntry` from `ToolCredentialInput` (or actually record it on decisions if audit logs need it). |
| **L4** | `src/core/dashboard-ipc-server.ts:7515-7518, 7593` | Move the `!cachedLarkAppId` guard above `resolveAutomationUser(cachedLarkAppId, ...)` in `PATCH /api/schedules/:id`. |
| **L5** | `src/core/dashboard-ipc-server.ts:11492-11493` | Remove the duplicate `assertAutomationUserPolicy` call in `PUT /api/bot-automation-identity`. |
| **L6** | `src/bot-registry.ts:1809`, `src/i18n.ts:637,692`, `docs/automation-execution-identity.md:14` | Update stale `--profile 透传` comment, `automation.runAsHelp` copy, and add `toolIdentity` to the precedence list in `docs/automation-execution-identity.md`. |

### Design-Doc Completeness Gaps (Track Explicitly as Follow-Up Scope)
- **G1 — Dashboard Read-Only Effective Policy Preview (Plan §4.3 & §10)**:
  - Add a pure helper `summarizeBotToolIdentityPolicy(botConfig)` returning per-tool effective modes (`Host credentials / Current sender / Assigned user / Bot application / Delegated scope`), override precedence, and `restartRequired` indicator.
  - Expose via bot payload / read-only endpoint and render a compact matrix in `bot-defaults-page.tsx` (and live pre-save preview when toggling `triggerUserAuth`, `larkToolBinding`, `toolIdentity`, or `automationIdentity`).
- **G2 — Native Bot Automatic-Only Identity Without Global Toggle (Plan §3.4 & §12.1)**:
  - Confirm with product whether a default native bot (`triggerUserAuth` off, `larkToolBinding` unset, `toolIdentity` unset) should be permitted to set `automationIdentity` or task/connector `runAsUser` directly (auto-installing per-turn wrappers only for the selected automatic tools without altering normal human chat turns). If yes, relax `assertAutomationUserPolicy` / `unenforceableManagedToolNormalized` to allow automatic-only managed wrappers on native sessions and update `wrapperIdentityTools` to install wrappers whenever `automationIdentity` or any active schedule/connector `runAsUser` exists.
- **G3 — Multi-Tool Provenance Preservation in `selectTurnExecutionUser` (`tool-identity-policy.ts:198-208`)**:
  - When `fixedBotUser` covers a strict subset (e.g. `['bytedcli']`) while `triggerUserAuth` covers `['lark-cli', 'bytedcli']`, `selectTurnExecutionUser` currently returns only `fixedBotUser` and drops `provenance` for `lark-cli`. Either return per-tool selections (`Record<TriggerUserAuthTool, TurnExecutionUserSelection>`) or explicitly preserve `provenance` fallback for tools outside `fixedBotUser.tools`.

---

## Verification & Rollout Checklist (Execute on `preview` per `AGENTS.md`)

All compilation and tests must run on `preview` (`feat/byte_approval/dev`), never locally:

1. **Build & Typecheck**:
   ```bash
   bun run build
   ```
2. **Targeted Test Suite (Vitest + Bun leg)** covering all modified modules:
   ```bash
   bun run test -- \
     test/ordinary-im-contract-admission.test.ts \
     test/session-contract-recovery.test.ts \
     test/schedule-identity-claim.test.ts \
     test/schedule-identity-claim-card-route.test.ts \
     test/bytedcli-identity-renewal.test.ts \
     test/automation-identity.test.ts \
     test/tool-identity-policy.test.ts \
     test/identity-decision-wiring.test.ts \
     test/ipc-lark-tool-identity.test.ts \
     test/registered-background-identity.test.ts \
     test/scheduled-turn-provenance.test.ts \
     test/schedule-creator-authorization.test.ts \
     test/scheduler-execution-context.test.ts \
     test/lark-tool-platform-credential.test.ts \
     test/lark-cli-auth.test.ts \
     test/cli-identity.test.ts \
     test/turn-cli-identity-platform.test.ts \
     test/trigger-api.test.ts
   ```
3. **Deploy to `preview` & Live Verification**:
   ```bash
   bun run switch:here && bun run daemon:restart
   ```
   - Confirm bot & Dashboard online via `bun run daemon:logs`.
   - Trigger a scheduled task with explicit `runAsUser` (e.g., `d4813a6e` or a test task): verify **zero** new `no_creator` rows in `schedule_identity_claim_cards`.
   - After that turn finishes, watch `daemon-0-out.log` across >90 minutes (or inspect renewal count) to confirm `[bytedcli-renewal]` does **not** renew the completed turn.
   - Fire a webhook trigger (`trg_*`) with `runAsUser`: verify `sessions.db` has no synthetic `ownerOpenId` / `senderOpenId` pollution and `botmux send --mention-back` does not emit `@ou_...（未知）`.
   - Verify Dashboard `/bots` defaults page clears invalid banners on save and renders/saves `toolIdentity.tools` & `credentialSource` cleanly.
4. **Promote to `feat/byte_approval/release`** only after all Phase 0–3 tests pass and `preview` live checks are clean.
