# Caelush Phase 10B Deadline & Timeout Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a restart-safe absolute Run wall-clock deadline derived from durable `startedAt + limits.timeoutMs`, reusing the Phase 10A abort spine and settling expired Runs as `TIMEOUT` only after confirmed cleanup.

**Architecture:** Keep the deadline derivable from existing Protocol fields; add no timeout table or redundant `deadlineAt` entity field. Core owns safe arithmetic, an injectable one-registration deadline registry, ephemeral abort causes, authority resolution, and the RunController two-phase timeout finalizer. The registry remains alive across idle boundaries and recovery, while active work receives the Phase 10A `RunExecutionScope.signal`.

**Tech Stack:** TypeScript/ESM, Zod Protocol schemas, Vitest, SQLite/Drizzle storage, existing Core/LLM/Tools/Runtime ports, and Node `setTimeout` as the production timer primitive.

**Spec:** `docs/superpowers/specs/2026-08-30-caelush-phase-10b-deadline-timeout-design.md`

## Global Constraints

- Base on Phase 10A SHA `b58067156d90e61821502d881ae7d8bb2bba591b`; do not merge `master`, force-push, or create a new Phase 10 round.
- Deadline is exactly `startedAt + limits.timeoutMs`; `createdAt` is not used and PENDING Runs do not time out.
- `timeoutMs` and `deadlineAt` use safe positive-integer arithmetic; `now >= deadlineAt` is expired.
- Abort causes and timer handles are ephemeral; `DEADLINE_EXCEEDED` never enters `RunCancellationIntent` or other durable Protocol data.
- Durable user cancellation intent wins before timeout terminal commit; a durable `TIMEOUT` cannot later become `CANCELLED`.
- `TIMEOUT_PENDING` is a controller result only, never a Protocol `RunStatus`.
- Registry keeps one timer per started non-terminal Run, supports re-arm/disarm/dispose, rechecks the clock, chunks long delays, and is independent of active scopes.
- Provider-local timeout remains `MODEL_TIMEOUT`; Phase 10B adds no retry/backoff/budget/verification execution or public daemon timeout API.
- Cleanup, approvals, continuation, active steps, and events settle before durable `TIMEOUT`; patch commit/rollback safety remains intact.
- Public APIs enter through package `src/index.ts`, and every behavior change follows TDD red → green → refactor.

---

### Task 1: Baseline, seal audit, and current timeout characterization

**Files:** Inspect `packages/protocol/src/{run.ts,limits.ts,error.ts,events/**}`, `packages/core/src/**`, `packages/llm/src/{gateway.ts,abort.ts,errors.ts}`, `packages/tools/src/**`, `packages/runtime/src/**`, `packages/storage/src/**`, `README.md`, and `AGENTS.md`.

- [ ] Run in the dedicated worktree, serially: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then `pnpm format:check`. Record the fresh file-warning count as `PHASE_10B_FORMAT_BASELINE`.
- [ ] Verify Phase 10A remote SHA and base selection, and audit every Prettier-applicable Phase 9D→10A changed file. Preserve the separate `1bc2642` 10A formatting-seal commit; do not run `prettier --write .`.
- [ ] Run existing LLM timeout/abort tests and document that provider-local `LLMTimeoutError` maps to `MODEL_TIMEOUT`, while an external signal is a different authority.

### Task 2: Pure deadline contract and safe arithmetic

**Files:** Create `packages/core/src/run-deadline.ts`; modify `packages/protocol/src/limits.ts` and `packages/core/src/index.ts`; test `packages/core/test/run-deadline.test.ts` and `packages/protocol/test/domain.test.ts`.

**Interfaces:** Export `RunDeadline { startedAt, timeoutMs, deadlineAt }`, `deriveRunDeadline(run): RunDeadline | undefined`, `isRunDeadlineExceeded(deadline, now): boolean`, and `remainingRunTimeMs(deadline, now): number`.

- [ ] Write failing tests for missing `startedAt`, createdAt non-use, exact active/expired boundary, safe positive timeout, unsafe timeout, addition overflow, and non-negative remaining time.
- [ ] Run `pnpm exec vitest run packages/core/test/run-deadline.test.ts packages/protocol/test/domain.test.ts` and observe a feature-missing failure.
- [ ] Implement `Number.isSafeInteger` validation and checked addition; return no deadline for PENDING/unstarted Runs without changing other budget fields.
- [ ] Re-run the focused tests, then refactor only while green.

### Task 3: Ephemeral abort causes and termination authority

**Files:** Modify `packages/core/src/run-execution-scope.ts` and `packages/core/src/index.ts`; create `packages/core/src/run-termination-authority.ts`; test `packages/core/test/run-execution-scope.test.ts` and `packages/core/test/run-termination-authority.test.ts`.

**Interfaces:** Export `RunExecutionAbortCause = "USER_REQUESTED" | "DEADLINE_EXCEEDED"`; make `scope.abort(cause)` first-wins and expose `abortCause`; export `resolveRunTerminationAuthority({ run, cancellationIntent, now, abortCause })` returning cancellation, timeout, unexpected-abort, or no authority.

- [ ] Write and run failing tests for both causes, duplicate aborts, terminal preservation, durable cancellation-before-timeout, timeout, and unexpected abort; assert `DEADLINE_EXCEEDED` is absent from cancellation intent.
- [ ] Implement the Core-only cause and pure priority resolver: terminal → durable cancellation → expired deadline → unexpected abort.
- [ ] Re-run focused tests and refactor only after green.

### Task 4: Injectable timer and deadline registry

**Files:** Create `packages/core/src/run-deadline-registry.ts`; modify `packages/core/src/run-controller-ports.ts` and `packages/core/src/index.ts`; test `packages/core/test/run-deadline-registry.test.ts`.

**Interfaces:** Export `RunDeadlineTimerPort.schedule(delayMs, callback): RunDeadlineTimerHandle`, a Node timer adapter with `unref()` where available, and `RunDeadlineRegistry.arm(runId, deadline, onDeadline)`, `disarm(runId)`, `dispose()`.

- [ ] Write deterministic fake-scheduler tests for deduplication, replacement re-arm, disarm, dispose, safe long-delay chunks, early wake recheck, exact fire, and contained async callback errors; run them and observe red.
- [ ] Implement one tokenized registration per Run, bounded chunks below Node’s timer limit, clock recheck at callback, and no unhandled rejection.
- [ ] Run focused tests and refactor with green output.

### Task 5: Timeout state, event, and result helpers

**Files:** Modify `packages/protocol/src/events/run.ts`, `packages/protocol/src/events/index.ts`, `packages/protocol/src/index.ts`, `packages/core/src/agent-state.ts`, `packages/core/src/run-execution-state.ts`, `packages/core/src/run-controller-events.ts`, `packages/core/src/run-controller-input.ts`, and `packages/core/src/index.ts`; test matching Protocol/Core suites.

**Interfaces:** Export `RunTimedOutEventSchema`/type with `{ deadlineAt }`, `markAgentStateTimedOut(state, now)`, `markAgentRunTimedOut(run, now)`, and a `RunControllerResult` member with status `TIMEOUT_PENDING`.

- [ ] Write failing tests for state/run timeout shape, no ordinary AgentError, safe event payload, exactly-one event factory output, and rejection of `TIMEOUT_PENDING` as Protocol RunStatus.
- [ ] Run focused Protocol/Core tests and observe red; implement through the canonical state machine without Step `TIMEOUT`, `CANCELLING`, or `RETRYING`; rerun green.

### Task 6: Controller registration, safe points, and two-phase timeout finalizer

**Files:** Modify `packages/core/src/run-controller-ports.ts`, `packages/core/src/run-controller.ts`, `packages/core/src/run-execution-state.ts`, and `packages/core/src/index.ts`; test `packages/core/test/run-controller-start.test.ts` and create/modify `packages/core/test/run-controller-timeout.test.ts`.

- [ ] Write failing latch-based tests for short timeout before provider, timeout during provider/context/tool, active Step `→ CANCELLED` with one usage increment, cleanup-before-commit, one `status.changed`, one `run.timed_out`, no `run.failed`, and cancellation priority.
- [ ] Run focused tests and observe red.
- [ ] Inject the registry; persist `RUNNING + startedAt` before arming; check deadline before work; abort active scope with `DEADLINE_EXCEEDED` before waiting for the termination lock; reload state; cancel approvals; use `RunOwnedResourceControllerPort`; settle step/continuation; atomically commit timeout state/events; disarm after commit.
- [ ] Generalize the Phase 10A cancellation lock/finalization without changing cancel behavior. Return `TIMEOUT_PENDING` when cleanup is unconfirmed and retain expired authority for recovery. Run focused tests and refactor green.

### Task 7: Idle boundaries and Approval/Tool/verification behavior

**Files:** Modify `packages/core/src/run-controller.ts` and only correct `packages/storage/src/repositories/approval-repository.ts` if necessary; test Core and Storage boundary/recovery suites.

- [ ] Write failing fake-timer tests that advance time without another user API: `WAITING_APPROVAL → TIMEOUT` with pending Approval `→ CANCELLED`; Approval TTL independently remains `EXPIRED`; `WAITING_TOOL_RESULTS` clears continuation and rejects later submission; `VERIFYING → TIMEOUT`; approval race executes zero Tools.
- [ ] Run focused tests and observe red.
- [ ] Reconcile deadlines on controller loads/boundaries without refreshing `startedAt`; reject expired approval/Tool continuation before resuming; keep Approval TTL implementation separate.
- [ ] Run focused boundary tests and refactor with green tests.

### Task 8: Crash recovery and restart-safe re-arm

**Files:** Modify `packages/core/src/run-controller.ts` and `packages/core/src/run-controller-ports.ts`; test `packages/core/test/run-controller-timeout.test.ts`, `packages/storage/test/run-controller-recovery.test.ts`, and `packages/storage/test/run-controller-restart.test.ts`.

- [ ] Write failing recovery tests for expired RUNNING/WAITING_APPROVAL/WAITING_TOOL_RESULTS/VERIFYING snapshots: zero provider calls, zero Tool execution, approval cancellation, continuation clear, TIMEOUT. Test an unexpired Run receives `deadlineAt - now`, never a fresh full timeout.
- [ ] Run focused recovery tests and observe red.
- [ ] Implement terminal → durable cancellation → expired deadline checks before stale Step/Approval/Tool recovery; disarm terminal snapshots and arm the original absolute deadline for unexpired Runs.
- [ ] Run focused recovery tests and refactor green.

### Task 9: Provider hierarchy, Runtime/process, and Patch regression

**Files:** Test/inspect `packages/llm/src/{gateway.ts,abort.ts,errors.ts}`, `packages/core/test/run-controller-timeout.test.ts`, `packages/runtime/src/exec/**`, `packages/runtime/src/search/**`, `packages/runtime/src/git/**`, `packages/runtime/src/patch/**`, `packages/runtime/src/local-runtime.ts`, and their existing tests.

- [ ] Write failing tests for provider-local timeout first (`MODEL_TIMEOUT`, one call, existing failure path) and Run deadline first (external abort, Run `TIMEOUT`, no provider-timeout mapping).
- [ ] Write failing tests for pipe/PTY/rg/Git/yielded managed-process cleanup, multiple same-Run processes, other-Run isolation, unconfirmed cleanup → `TIMEOUT_PENDING`, and patch prepare abort vs commit/rollback deferred critical section.
- [ ] Run the focused LLM/runtime tests and observe red; implement only Core authority mapping and reuse the Phase 10A signal/resource controller. Do not add per-tool timeout, timeout process manager, provider changes, or retry.
- [ ] Re-run all focused tests and verify green.

### Task 10: Deterministic race matrix and exactly-once settlement

**Files:** Modify `packages/core/test/run-controller-timeout.test.ts`, `packages/storage/test/run-execution-store-cancellation.test.ts`, and relevant existing controller failure tests only when a race exposes a real defect.

- [ ] Write failing deferred/latch tests for cancel-before-timeout-commit, timeout-before-later-cancel, cancel intent-before-deadline callback, simultaneous cleanup, duplicate callback, normal completion beside deadline, callback infrastructure failure, and repeated recover.
- [ ] Run them without `--retry` and observe red; make finalizers reload authoritative state, preserve terminal/cancellation authority, avoid deadlock, and emit one status transition plus one `run.timed_out`.
- [ ] Re-run race tests repeatedly without retry flags and refactor only while green.

### Task 11: Architecture docs and durable rules

**Files:** Create `docs/architecture/timeout.md`; modify `docs/architecture/cancellation.md`, `docs/architecture/agent-loop.md`, `docs/architecture/runtime.md`, `docs/architecture/approval-workflow.md`, `README.md`, and `AGENTS.md`.

- [ ] Document the two lifecycle diagrams, absolute deadline/wall-clock coverage, PENDING/approval/tool-result/verifying boundaries, registry/timer lifecycle and long delays, shared abort spine, authority races, cleanup/TIMEOUT_PENDING, crash recovery, provider distinction, Patch safety, and exclusions.
- [ ] Add the frozen Phase 10B durable rules without claiming Retry, Budget, Verification, hard sandbox, or daemon execution. Run Prettier checks on changed docs and `pnpm exec vitest run tests/architecture`.

### Task 12: Full verification and delivery

**Files:** Inspect all changed files, `git status --short`, and `git diff`.

- [ ] If generated artifacts exist, narrowly remove only `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` with safe Node fs operations; never use `git clean`, reset, checkout, or force push.
- [ ] Run serially: `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm typecheck`; plain `pnpm test`; `pnpm build`; `pnpm format:check`; `pnpm check`; `git diff --check`.
- [ ] Confirm every 10B changed file has zero individual Prettier warnings and repository warnings are `<= PHASE_10B_FORMAT_BASELINE`; audit no timeout migration/table, no `DEADLINE_EXCEEDED` durable intent, no `TIMEOUT_PENDING` RunStatus, no `CANCELLING`/`RETRYING`, and no prohibited Phase 10C/10D features.
- [ ] Review `git status --short` and `git diff`, commit feature changes as `feat(core): enforce run deadlines and timeout recovery`, push `codex/phase-10b-deadline-timeout-hierarchy-recovery`, and verify local SHA equals `git ls-remote` SHA. Only then report the Phase 10B completion status.
