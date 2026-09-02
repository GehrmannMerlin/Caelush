# Caelush Phase 13D — Interactive Control and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Web Activity Client into a safe interactive control surface with durable Approval, cancellation, SSE reconnect/replay, browser reload recovery, and daemon restart recovery while preserving Core, Security, Runtime, Verification, and Protocol authority boundaries.

**Architecture:** Browser-safe control projections and reconnect scheduling live in `@caelush/client` and are consumed by both CLI and Web. `WebSessionManager` owns only local presentation and transport orchestration: it calls existing daemon actions, reads durable approvals/runs/events, and never fabricates RunStatus, approval state, cancellation settlement, or completion. The Web keeps exactly one AgentEvent stream per selected Run and feeds replay/live events through the existing shared Timeline reducer.

**Tech Stack:** TypeScript, ESM, React, Vitest, `@caelush/client`, `@caelush/protocol`, existing daemon/SQLite integration fixtures, browser-safe `TextEncoder`/`TextDecoder`.

**Spec:** User-provided `Caelush Phase 13D — Approval / Cancellation / Reconnect / Recovery` instructions in `C:/Users/韩吉衍/.codex/attachments/9c9b6dfd-2b81-45e4-a578-e18c36931a8d/pasted-text.txt`.

## Global Constraints

- Phase 13 is fixed to `13A`, `13B`, `13C`, `13D`, `13E`; this work is only `13D`, with internal Tasks 1–7 and no `13D-1`, `13D-2`, `13D-extra`, `13F`, or `13E` work.
- Starting baseline is `master == origin/master == 5ee413af6003ec9aae7a4b6735bf736f01f04dd9`.
- Do not create a worktree; work directly in `D:/Develop/Caelush` on `codex/phase-13d-approval-cancellation-reconnect-recovery`.
- Do not modify `packages/protocol`, `packages/core`, `packages/security`, `packages/runtime`, or `packages/verification`; existing public contracts already expose `cancelRun`, `recoverRun`, Approval APIs, and `afterSequence`.
- `Core` remains execution authority, `Security` approval authority, `Verification` completion authority, `Daemon` Run state authority, `EventBus` durable history authority, and Browser only a local control projection.
- Approval UI may consume only the public ApprovalRequest projection: `title`, `reason`, `riskLevel`, `scope`, `action.toolName`, `action.summary`, and `action.requiredCapabilities`; raw `ToolInvocation.args`, shell arguments, environment, credentials, stdout/stderr, hidden reasoning, and verification evidence never enter Web control state or markup.
- Approval title is bounded to 2 KiB, summary and each capability to 512 bytes, and capabilities to 16 items using browser-safe `TextEncoder`/`TextDecoder`, with no `Buffer` or `node:*` imports in browser-safe Client code.
- `Approve Run` is available only when `approval.scope === "RUN"`; options map to `{ action: "APPROVE", scope: "ONCE" }`, `{ action: "APPROVE", scope: "RUN" }`, and `{ action: "REJECT" }`.
- Cancellation is allowed only for `RUNNING`, `WAITING_APPROVAL`, and `VERIFYING`; `CANCELLING` is Web-local presentation state and is never a Protocol RunStatus. Cancellation waits for daemon confirmation and never optimistically renders `CANCELLED`.
- Reconnect delays are exactly `250`, `500`, `1000`, `2000`, `4000`, `5000` ms. Reconnect preserves Timeline state and uses `afterSequence: timeline.lastDurableSequence`; shared Timeline reducer remains the only event de-duplication authority.
- One selected Run has one physical `watchRunEvents` consumer. Old stream results are ignored after generation changes, and an old stream is aborted before a replacement is installed.
- `approval.requested` updates Timeline and the control projection from the same event stream. Reload/recovery loads durable approvals with `listPendingApprovals`; it does not wait for a repeated event.
- PENDING Runs are never auto-started; multiple active Runs require an explicit recovery selection; Web calls `recoverRun` and never re-executes Tools or creates a replacement Run.
- Selected-session persistence stores only a validated workspace-scoped `SessionId`; Timeline is reconstructed from daemon durable replay, never browser cache.
- Use TDD: every behavior change starts with a failing test and the failure is observed before production code. Keep changes minimal and do not add Playwright or Phase 13E visual polish.
- Final verification order is `git diff --check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:release`, `pnpm test:release`, plus changed-file Prettier checks. Existing repository-wide format debt and ignored `release-artifacts` noise must be reported separately, not silently claimed as passing.

---

### Task 1: Shared browser-safe control semantics

**Files:**
- Create: `packages/client/src/control/approval.ts`
- Create: `packages/client/src/control/run-control.ts`
- Create: `packages/client/src/control/reconnect-scheduler.ts`
- Create: `packages/client/src/control/index.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `apps/cli/src/application/cli-control.ts`
- Modify: `apps/cli/src/application/reconnect-scheduler.ts`
- Test: `packages/client/test/control.test.ts`
- Test: `apps/cli/test/cli-control.test.ts`
- Test: `apps/cli/test/reconnect-scheduler.test.ts`

**Interfaces:**
- `createApprovalView(approval: ApprovalRequest): ApprovalView` returns only bounded public fields and option values.
- `approvalOptions(scope: ApprovalScope): readonly ApprovalOption[]` and `approvalResolutionForOption(kind: ApprovalOptionKind): ApprovalResolution` preserve CLI labels exactly.
- `canCancelRunStatus(status: RunStatus): boolean` and `isTerminalRunStatus(status: RunStatus): boolean` are shared by CLI and Web.
- `RECONNECT_DELAYS_MS` is the frozen six-entry tuple `[250, 500, 1000, 2000, 4000, 5000]`.
- `ReconnectScheduler` accepts an injected `{ schedule(delayMs, callback): TimerHandle }`, `onAttempt(attempt)`, and `onExhausted()`, and exposes `start()`, `failed()`, `succeeded()`, `manualRetry()`, and `dispose()`.

- [ ] **Step 1: Write failing shared-control tests** for bounded Approval projection, ONCE/RUN/REJECT option mapping, `canCancelRunStatus`, terminal statuses, scheduler delay sequence, success reset, exhaustion, manual retry reset, and disposal.
- [ ] **Step 2: Run the focused tests and verify the expected missing-module failures.** Run `pnpm --filter @caelush/client test -- control.test.ts` and the two CLI focused files; failure must be caused by the new shared exports, not a test typo.
- [ ] **Step 3: Implement the three Client control modules** with only Protocol data types, `TextEncoder`/`TextDecoder`, deterministic timers, and no Node imports or executable Tool data.
- [ ] **Step 4: Refactor CLI control/scheduler to consume the shared exports** through `@caelush/client`; retain `CliApprovalView`/CLI state adapters and exact existing English labels so CLI behavior does not change.
- [ ] **Step 5: Run Client and CLI focused tests, then `pnpm typecheck`.** Fix only failures caused by this task.
- [ ] **Step 6: Commit** with `feat(client): share interactive control semantics`.

### Task 2: Web Approval lifecycle and local control state

**Files:**
- Modify: `apps/web/src/application/session-manager.ts`
- Modify: `packages/client/src/control/approval.ts` only if Task 1 exposes a missing browser-safe type
- Test: `apps/web/test/session-manager.test.ts`
- Test: `apps/web/test/approval-control.test.ts`

**Interfaces:**
- Extend `WebSessionClient` with existing `listPendingApprovals(runId)`, `resolveApproval(runId, approvalId, resolution)`, and `getRun` methods; do not add an HTTP route.
- Add presentation-only snapshot fields `transportState: "CONNECTED" | "RECONNECTING" | "DISCONNECTED"`, `controlMode: "NONE" | "APPROVAL" | "CANCELLING" | "RECOVERY_PICKER" | "PENDING_RUN_CONFIRMATION"`, and `approvalState?: { requests: readonly ApprovalView[]; submitting: ReadonlySet<ApprovalRequestId> }` or an equivalent immutable representation.
- Add public Manager methods `resolveApproval(approvalId, resolution): Promise<boolean>` and `refreshApprovals(runId): Promise<void>`; identity is always `approvalId`, never an array index.

- [ ] **Step 1: Add failing tests** for event-driven `approval.requested` visibility, `approval.resolved` removal, reload-time `listPendingApprovals`, stale approval revalidation, external-resolution cleanup, duplicate submission suppression, and resolve-failure reconciliation.
- [ ] **Step 2: Run `pnpm --filter @caelush/web test -- approval-control.test.ts session-manager.test.ts` and verify failures before implementation.**
- [ ] **Step 3: Implement approval state projection** from the existing AgentEvent stream and durable approval list, sorting by `createdAt` then `approvalId`, bounding through shared Client projection, and retaining the existing Timeline reducer as the other projection of the same event.
- [ ] **Step 4: Implement before-mutate revalidation**: call `listPendingApprovals`, require the matching request to be `PENDING`, then call `resolveApproval`; on absence or any failure call `getRun` plus `listPendingApprovals` best-effort and remove stale controls without showing a fabricated approval failure state.
- [ ] **Step 5: Run Web focused tests and `pnpm typecheck`.**
- [ ] **Step 6: Commit** with `feat(web): add approval control lifecycle`.

### Task 3: Web cancellation lifecycle

**Files:**
- Modify: `apps/web/src/application/session-manager.ts`
- Test: `apps/web/test/cancellation-control.test.ts`

**Interfaces:**
- Add `cancelRun(): Promise<boolean>` to `WebSessionManager` and `cancelRun(runId)` to `WebSessionClient` using the existing Client API.
- A single private `cancelPromise` guards repeated clicks. The local state enters `controlMode: "CANCELLING"` and remains non-terminal until the daemon response is observed.

- [ ] **Step 1: Add failing tests** for cancellation from `RUNNING`, `WAITING_APPROVAL`, and `VERIFYING`; double-click idempotency; terminal response; non-terminal response; request failure; and cancellation racing with Approval.
- [ ] **Step 2: Run the focused cancellation test and verify it fails for missing Manager behavior.**
- [ ] **Step 3: Implement status gating, single-flight cancel, safe failure text (`无法确认取消请求。任务可能仍在后台运行。`), and Approval cleanup/reconciliation after confirmed cancellation.**
- [ ] **Step 4: Run cancellation and existing session-manager tests plus `pnpm typecheck`.**
- [ ] **Step 5: Commit** with `feat(web): add daemon-confirmed cancellation`.

### Task 4: Reconnect, replay, and one-stream lifecycle

**Files:**
- Modify: `apps/web/src/application/session-manager.ts`
- Modify: `apps/web/src/app.ts`
- Test: `apps/web/test/reconnect.test.ts`
- Test: `apps/web/test/session-manager.test.ts`

**Interfaces:**
- `WebSessionManager.reconnectActiveRun(): void` resets scheduler attempts only after exhaustion; it never calls `createRun`.
- Every `watchRunEvents` call receives `{ afterSequence, signal, onOpen }`; initial attach uses `0`, reconnect uses the retained `timeline.lastDurableSequence`.
- Each lifecycle attachment has a monotonically increasing `streamGeneration`; callbacks and async results must verify the generation before publishing.

- [ ] **Step 1: Add failing tests** for preserved Timeline across disconnect, `afterSequence` of 50 replaying 51/52/53 without duplicate entries, exact one stream consumer, abort-before-replace, generation guard, open success reset, six retry delays, exhaustion, and manual retry.
- [ ] **Step 2: Run the focused reconnect tests and verify the missing reconnect behavior.**
- [ ] **Step 3: Replace direct Web stream failure errors with the shared scheduler**; publish `RECONNECTING` with attempt information, retain Timeline and reducer state, and publish `DISCONNECTED` with manual reconnect text only after exhaustion.
- [ ] **Step 4: Treat reducer integrity/protocol/business errors as terminal local transport errors** that do not call the scheduler; only genuine stream loss enters reconnect.
- [ ] **Step 5: Run reconnect/session tests and `pnpm typecheck`.**
- [ ] **Step 6: Commit** with `feat(web): reconnect live runs from durable sequence`.

### Task 5: Run recovery and reload persistence

**Files:**
- Modify: `apps/web/src/application/session-manager.ts`
- Modify: `apps/web/src/app.ts`
- Create: `apps/web/src/application/session-persistence.ts`
- Test: `apps/web/test/recovery.test.ts`
- Test: `apps/web/test/session-persistence.test.ts`

**Interfaces:**
- `prepareRecoveryRun(run: ClientAgentRun): Promise<boolean>` classifies `PENDING`, `RUNNING`, `VERIFYING`, and `WAITING_APPROVAL` using durable APIs.
- `selectRecoveryRun(runId: RunId): Promise<boolean>` selects exactly one active Run; other daemon Runs remain untouched.
- `confirmPendingRun(runId: RunId): Promise<boolean>` is the only Web path that calls `startRun` for a PENDING Run.
- `SessionSelectionStore` exposes `read(workspaceId): SessionId | undefined`, `write(workspaceId, sessionId): void`, and `clear(workspaceId): void`, validates the stored string with the Protocol schema and current candidate membership, and stores no Run/Timeline/Approval data.

- [ ] **Step 1: Add failing tests** for no active Run, one `RUNNING`, one `VERIFYING`, one `WAITING_APPROVAL` with pending approvals, one `WAITING_APPROVAL` with an empty durable list, one `PENDING`, multiple active Runs, reload Manager A→Manager B, and stored invalid/non-member SessionId.
- [ ] **Step 2: Run recovery/persistence focused tests and verify failures before implementation.**
- [ ] **Step 3: Implement recovery classification** after `listRuns`; attach the stream before admitting `recoverRun`; never auto-start PENDING and never auto-recover a WAITING_APPROVAL Run with actual pending requests.
- [ ] **Step 4: Persist the selected SessionId only after candidate membership validation** and load it during `loadSessions`; reconstruct Timeline with `createInitialTimelineState(run.id)` and durable replay, not browser cache.
- [ ] **Step 5: Run focused recovery tests and `pnpm typecheck`.**
- [ ] **Step 6: Commit** with `feat(web): recover durable active runs on reload`.

### Task 6: Web control UI and rendering safety

**Files:**
- Modify: `apps/web/src/app.ts`
- Modify: `apps/web/src/components/session-workspace.ts`
- Modify: `apps/web/src/components/prompt-composer.ts`
- Create: `apps/web/src/components/approval-card.ts`
- Create: `apps/web/src/components/reconnect-banner.ts`
- Create: `apps/web/src/components/recovery-panel.ts`
- Modify: `apps/web/src/styles.css` only for the small inline control styles required by the existing layout
- Test: `apps/web/test/control-presentation.test.tsx`

**Interfaces:**
- `ApprovalCard` receives only `ApprovalView` plus callbacks `(approvalId, resolution)`, and renders `需要审批`, risk, reason, public action summary/tool name, bounded capabilities, and `拒绝`/`仅本次允许`/`本次运行内允许` as applicable.
- `SessionWorkspace` receives one `onCancel` callback and renders one Cancel control only for the three shared cancellable statuses.
- `ReconnectBanner` renders `CONNECTED`, `RECONNECTING` with `第 N / 6 次`, and `DISCONNECTED` with one `重新连接` callback.
- `RecoveryPanel` renders PENDING confirmation and multiple-Run selection using bounded goal/status/createdAt/runId projections.

- [ ] **Step 1: Add failing server-rendered markup tests** for Approval Card labels and scope gating, Cancel visibility, `正在取消`, reconnect states, recovery picker, and absence of raw args/secret/shell/process output/hidden reasoning/evidence/diff/terminal/inspector markup.
- [ ] **Step 2: Run `pnpm --filter @caelush/web test -- control-presentation.test.tsx` and verify red.**
- [ ] **Step 3: Implement the components in the existing Top Bar + Session Sidebar + Main Workspace layout** without adding a right Inspector, global Approval Center, Terminal, usage panel, or Phase 13E styling system.
- [ ] **Step 4: Wire callbacks from `WebHostApp` to `WebSessionManager`, disable Composer during active/cancelling/recovery states, and keep technical values untranslated.**
- [ ] **Step 5: Run Web rendering tests, existing timeline/presentation tests, and `pnpm typecheck`.**
- [ ] **Step 6: Commit** with `feat(web): add inline run controls and recovery UI`.

### Task 7: Real integrations, independent review, and delivery verification

**Files:**
- Modify or create only test fixtures under `apps/web/test/` and `apps/daemon/test/` as required by existing test conventions; no production backend changes without first proving the existing public contract is insufficient.
- Create: `docs/superpowers/reports/2026-09-02-phase-13d-verification.md`

**Interfaces:**
- Reuse existing `startDaemon`, SQLite path, `CaelushClient`, deterministic Provider, Security ApprovalRepository, ToolDispatcher, and WebSessionManager fixtures.
- Real tests must exercise Approval `WAITING_APPROVAL → Approve Once → continuation`, Reject, daemon-confirmed cancellation, broken SSE→`afterSequence` replay, exact-once Tool behavior, and same-database restart recovery when the Windows test harness permits it.

- [ ] **Step 1: Add failing real integration tests** for Approval, cancellation, reconnect/replay, and restart recovery before changing fixtures.
- [ ] **Step 2: Run the new focused integrations and classify failures** as implementation defects, existing fixture limitations, or a real public-contract blocker; do not silently skip daemon restart. If Windows child-process restart is unavailable, record the environment limitation and add the strongest real service-level same-SQLite recovery test possible.
- [ ] **Step 3: Implement only the missing Web/client behavior** needed by the failing integration tests; do not modify Protocol/Core/Security/Runtime/Verification.
- [ ] **Step 4: Run all focused Client, CLI, Web, and integration tests; inspect `git diff --check`, changed-file Prettier output, and `git status --short`.**
- [ ] **Step 5: Run the final commands in order:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:release`, `pnpm test:release`. Report every failure honestly, including historical format debt or ignored generated-artifact lint noise.**
- [ ] **Step 6: Perform an independent whole-branch review** against the plan, including authority/security/no-13E gates and any deferred-minor ledger entries; fix or explicitly adjudicate only within the permitted review cycle.
- [ ] **Step 7: Commit the final verified branch** with `feat(web): add interactive run control and recovery` if no earlier commit already provides the final commit.
- [ ] **Step 8: Push and seal delivery:** push `codex/phase-13d-approval-cancellation-reconnect-recovery`, compare local and remote task SHA, fast-forward `master`, push `master`, compare local master/remote master/task SHA, delete the local task branch with `git branch -d`, and verify `master` only, one worktree, clean status, and `master == origin/master`.

## Completion Report Checklist

Before stopping, report the baseline SHA, task branch and final SHAs, shared-vs-host-specific control ownership, Approval/cancellation/reconnect/recovery behavior, UI additions and explicitly deferred 13E scope, real integration coverage, focused and final command results, baseline noise, security answers, independent reviewer verdict, remote task seal, master seal, and final local cleanup. Do not begin Phase 13E.
