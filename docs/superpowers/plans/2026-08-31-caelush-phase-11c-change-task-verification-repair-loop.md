# Caelush Phase 11C Change, Task Acceptance, and Repair Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic Workspace/Git/Task verification and a bounded, governance-preserving repair handoff while keeping Phase 11C in `VERIFYING`.

**Architecture:** Extend the provider-neutral Verification domain with bounded evidence and structural ports. Compose Runtime and LLM adapters at host/Core boundaries, reuse the existing check lifecycle, Storage repositories, RuntimeGitService, ContextBuilder, AgentLoop, and Phase 10D budget ledger, then let RunController own ordinal orchestration and the atomic `VERIFYING → RUNNING` repair transition.

**Tech Stack:** TypeScript/ESM, Zod protocol schemas, Vitest, pnpm workspaces, SHA-256, existing Runtime filesystem/Git adapters, existing LLM Gateway and BudgetManager, SQLite repositories.

**Spec:** `docs/superpowers/specs/2026-08-31-caelush-phase-11c-change-task-repair-design.md`

## Global Constraints

- Phase 11 has exactly 11A, 11B, 11C, and 11D; do not create 11C-1, 11C-2, 11E, or another round.
- Verification failure and Verification infrastructure error are different states; only blocking FAILED checks may trigger repair.
- Verification never owns completion authority; a passing plan remains `VERIFYING` with no `run.completed` or `finalResult`.
- Verification cannot import Runtime, Storage, Tools, LLM, `node:fs`, or `child_process`; all host work crosses injected high-level ports.
- Runtime Git and filesystem capabilities are reused read-only; Verification never stages, restores, resets, checks out, stashes, commits, or invokes Git Tools.
- Task reviewer evidence is untrusted data, bounded, strict JSON, chain-of-thought-free, no-tools, and no-mutation.
- Reviewer calls use `VERIFICATION_LLM` in the existing Phase 10D BudgetManager/ledger; they are not AgentSteps or ToolInvocations.
- Repair context is bounded/redacted diagnostic data, not a synthetic user/tool conversation message.
- Old VerificationPlans and Evidence remain immutable; every repaired Final Candidate gets a new plan and fresh evidence.
- Default automatic repair limit is three cycles, clamped by an injected hard maximum of ten.
- All implementation behavior follows TDD: write a focused failing test, run it and observe the expected failure, implement the minimum, rerun focused and regression tests, then refactor only while green.

---

### Task 1: Extend protocol-purpose, event, and continuation contracts

**Files:**
- Modify: `packages/protocol/src/verification.ts`, `packages/protocol/src/events/verification.ts`, `packages/protocol/src/events/index.ts`, `packages/protocol/src/index.ts`
- Modify: `packages/core/src/agent-continuation.ts`, `packages/core/src/agent-continuation-schema.ts`, `packages/core/src/run-controller-input.ts`, `packages/core/src/run-execution-state.ts`, `packages/core/src/index.ts`
- Test: `packages/protocol/test/verification-contracts.test.ts`, `packages/protocol/test/verification-events.test.ts`, `packages/core/test/agent-continuation.test.ts`, `packages/core/test/run-execution-state.test.ts`

**Interfaces:**
- Produces `VerificationCheckPurposeSchema`, repair event schemas, `WaitingVerificationRepairContinuation`, its Zod schema, and `RunControllerResult` repair metadata.

- [ ] **Step 1: Write failing tests** for change-review event purposes, valid/invalid repair continuation fields, and `RUNNING` invariant acceptance only when no active Step.
- [ ] **Step 2: Run focused tests** with `pnpm exec vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/verification-events.test.ts packages/core/test/agent-continuation.test.ts packages/core/test/run-execution-state.test.ts`; expect failures for missing schemas/types.
- [ ] **Step 3: Implement minimum schemas/types** and export them through public package indexes. Keep repair continuation out of RunStatus.
- [ ] **Step 4: Rerun focused tests**, then `pnpm exec vitest run packages/protocol packages/core/test/run-execution-state.test.ts`.

### Task 2: Add workspace verification domain and deterministic evidence

**Files:**
- Create: `packages/verification/src/workspace-verifier.ts`
- Modify: `packages/verification/src/contracts.ts`, `packages/verification/src/evidence.ts`, `packages/verification/src/index.ts`
- Test: `packages/verification/test/workspace-verifier.test.ts`

**Interfaces:**
- Produces `WorkspaceVerificationPort`, `WorkspaceInspectionResult`, and a pure `verifyWorkspaceInspection()` / evidence builder that accepts injected metadata facts and emits bounded sorted fields plus SHA-256 hash.

- [ ] **Step 1: Write failing tests** for created/modified/moved/deleted success and mismatch, symlink failure, outside/error classification, deterministic multibyte path hash, bounds, and no contents in output.
- [ ] **Step 2: Run the focused workspace test** and confirm it fails because the domain contract is absent.
- [ ] **Step 3: Implement the pure bounded verifier** with stable path sorting, byte-aware limits, safe metadata-only facts, and SHA-256 canonical input.
- [ ] **Step 4: Run focused tests**, then existing `packages/verification/test/evidence.test.ts` and `packages/verification/test/runner.test.ts`.

### Task 3: Compose Runtime workspace adapter without a second filesystem

**Files:**
- Create: `apps/daemon/src/verification-runtime-adapters.ts` (or the existing host-composition location selected by the package graph)
- Modify: `apps/daemon/package.json`, `apps/daemon/tsconfig.json` only if required by public imports
- Test: `packages/verification/test/workspace-runtime-adapter.test.ts` or host adapter test

**Interfaces:**
- Produces an adapter from `RuntimeWorkspaceScope` to `WorkspaceVerificationPort` using `pathResolver` and `filesystem` only; it must never import Verification from Runtime or add a Runtime-to-Verification dependency.

- [ ] **Step 1: Write the failing adapter test** using a fake `RuntimeWorkspaceScope` that records `resolveExisting`/`getMetadata` calls and rejects direct fs access.
- [ ] **Step 2: Run the focused test** and confirm the adapter is missing.
- [ ] **Step 3: Implement the adapter in the host/composition layer**; map Runtime errors to `ERROR`, preserve AbortSignal, and never read file content.
- [ ] **Step 4: Run the focused test and the architecture boundary suite**.

### Task 4: Add Git verification domain and RuntimeGit adapter

**Files:**
- Create: `packages/verification/src/git-verifier.ts`
- Modify: `packages/verification/src/contracts.ts`, `packages/verification/src/evidence.ts`, `packages/verification/src/index.ts`
- Test: `packages/verification/test/git-verifier.test.ts`, `packages/verification/test/git-read-only.test.ts`

**Interfaces:**
- Produces `VerificationGitPort`, bounded Git review result/evidence, `verifyGitChangeset()`, and a structural adapter contract matching `RuntimeGitService` data without importing Runtime.

- [ ] **Step 1: Write failing tests** for unavailable IF_AVAILABLE/REQUIRED, clean/tracked/deleted/untracked, unmerged, status/diff truncation, unattributed dirty paths, no-net-diff, per-path hashes, aggregate bounds, and zero mutation calls.
- [ ] **Step 2: Run focused tests** and verify expected missing-contract failures.
- [ ] **Step 3: Implement pure Git review and bounded evidence** with no Git commands, no Tool calls, sorted paths, and explicit completeness flags.
- [ ] **Step 4: Run focused tests and existing Runtime Git tests** to characterize adapter compatibility.

### Task 5: Generalize verification stage execution and evaluation

**Files:**
- Create: `packages/verification/src/change-runner.ts` or focused stage strategy file
- Modify: `packages/verification/src/runner.ts`, `packages/verification/src/evaluator.ts`, `packages/verification/src/contracts.ts`, `packages/verification/src/index.ts`
- Test: `packages/verification/test/change-runner.test.ts`, `packages/verification/test/evaluator.test.ts`

**Interfaces:**
- Produces a stage driver that processes checks by ordinal, preserves 11B project behavior, uses shared start/settle store/event ports, and exposes evaluation summaries with blocking Failed/Error IDs.

- [ ] **Step 1: Write failing tests** for ordinal order, durable start-before-inspection, terminal evidence settlement, project→workspace→git→task order, blocking failure stop, Error no-repair classification, and full-pass evaluation.
- [ ] **Step 2: Run focused tests** and observe failures before implementation.
- [ ] **Step 3: Implement the minimum generic strategy/orchestrator**; do not add fake Tool events or a fourth unrelated runner.
- [ ] **Step 4: Run focused and existing verification tests**.

### Task 6: Add task review bundle, hash, strict parser, and prompt

**Files:**
- Create: `packages/verification/src/task-review.ts`
- Modify: `packages/verification/src/contracts.ts`, `packages/verification/src/index.ts`
- Test: `packages/verification/test/task-review.test.ts`

**Interfaces:**
- Produces `TaskReviewBundleBuilder`, `TaskAcceptanceReviewInput`, strict `TaskAcceptanceReviewSchema`, `buildTaskReviewPrompt()`, `parseTaskAcceptanceReview()`, and `reviewInputHash`.

- [ ] **Step 1: Write failing tests** for valid PASS/FAIL JSON, unknown fields, invalid/missing/oversized values, excessive instructions, non-JSON/tool-call rejection, injection boundary text, self-certification rejection via evidence, and critical evidence overflow.
- [ ] **Step 2: Run focused tests** and observe missing APIs/expected failures.
- [ ] **Step 3: Implement bounded canonical bundle/hash, explicit untrusted-evidence prompt, and strict Zod parser**; never persist raw prompt or hidden reasoning.
- [ ] **Step 4: Run focused tests and the package architecture test**.

### Task 7: Add reviewer LLM and shared budget accounting

**Files:**
- Modify: `packages/core/src/budget-ports.ts`, `packages/core/src/run-controller-ports.ts`, `packages/core/src/index.ts`
- Modify: `packages/storage/src/budget-ledger-repository.ts`, `packages/storage/src/run-budget-port.ts`, `packages/storage/src/index.ts`
- Test: `packages/storage/test/reviewer-budget.test.ts`, `packages/core/test/reviewer-budget.test.ts`

**Interfaces:**
- Produces a Core `VerificationLLMClient`/reviewer port and narrow budget methods for admission/start/settlement/conservative recovery, implemented by the existing `SqliteRunBudgetPort` and `BudgetManager` using `VERIFICATION_LLM` owner entries.

- [ ] **Step 1: Write failing tests** for normal/no-limit, token/cost exhaustion, pricing unavailable, reserve→in-flight→settle, missing usage conservative, usage projection, steps/toolCalls unchanged, and in-flight recovery no replay.
- [ ] **Step 2: Run focused tests** and verify missing kind/method failures.
- [ ] **Step 3: Extend the existing ledger/port** without a second manager or migration; keep solver `admitLLM` behavior unchanged.
- [ ] **Step 4: Run focused budget tests plus all existing storage budget tests**.

### Task 8: Add TASK check execution through the current Run model

**Files:**
- Modify: `packages/verification/src/change-runner.ts`, `packages/verification/src/contracts.ts`
- Modify: `packages/core/src/run-controller-ports.ts`, `packages/core/src/run-controller.ts`
- Test: `packages/core/test/task-reviewer.test.ts`, `packages/core/test/run-controller-verification.test.ts`

**Interfaces:**
- Produces a reviewer execution path that obtains original goal/candidate/plan/check/evidence from trusted durable boundaries, sends no tools, inherits Run AbortSignal, persists TASK RUNNING before provider call, settles bounded TASK evidence, and maps provider/parse failures to TASK ERROR.

- [ ] **Step 1: Write failing controller tests** for task review after prior checks, valid PASS/FAIL, malformed/tool-call/provider error, budget block, cancellation/deadline authority, no reviewer `llm.started`, and no self-certification.
- [ ] **Step 2: Run focused tests** and observe the absent full-stage path.
- [ ] **Step 3: Implement the injected reviewer port and controller wiring** with no provider-specific reviewer class and no retry continuation reuse.
- [ ] **Step 4: Run focused controller/verification tests and the existing RunController suite**.

### Task 9: Add repair policy, bounded context, continuation, and atomic transition

**Files:**
- Create: `packages/verification/src/repair.ts`
- Modify: `packages/verification/src/index.ts`, `packages/core/src/agent-loop-input.ts`, `packages/core/src/agent-continuation.ts`, `packages/core/src/agent-continuation-schema.ts`, `packages/core/src/run-controller.ts`, `packages/core/src/run-controller-events.ts`, `packages/core/src/run-controller-input.ts`, `packages/core/src/run-execution-state.ts`, `packages/core/src/run-controller-ports.ts`
- Test: `packages/verification/test/repair.test.ts`, `packages/core/test/run-controller-repair.test.ts`

**Interfaces:**
- Produces `VerificationRepairPolicy`, `VerificationRepairContext`, deterministic context compiler, `WAITING_VERIFICATION_REPAIR`, `verification.repair.started`, limit event, and the atomic `VERIFYING → RUNNING` handoff.

- [ ] **Step 1: Write failing tests** for FAILED-only eligibility, ERROR/no-repair, bounded/redacted/injection-safe context, original-goal/unrelated-failure instruction, default 3/hard 10 policy, cycle calculation, limit behavior, authority precedence, atomic commit/event ordering, and Run staying VERIFYING at the limit.
- [ ] **Step 2: Run focused tests** and confirm expected failures.
- [ ] **Step 3: Implement the pure policy/context compiler and Core transition**; store only plan/check/evidence references in continuation and never add a RunStatus.
- [ ] **Step 4: Run focused repair tests and existing state/event tests**.

### Task 10: Feed repair context through normal AgentLoop/ContextBuilder

**Files:**
- Modify: `packages/context/src/context-builder.ts`, `packages/context/src/context-renderer.ts`, `packages/context/src/context-text.ts`, `packages/context/src/index.ts`
- Modify: `packages/core/src/agent-loop-input.ts`, `packages/core/src/agent-loop.ts`, `packages/core/src/run-controller.ts`
- Test: `packages/context/test/repair-context.test.ts`, `packages/core/test/agent-loop-repair.test.ts`

**Interfaces:**
- Produces an optional `verificationRepairContext` input that renders a dedicated synthetic system/context section only for the first repair solver turn; it does not alter durable conversation history.

- [ ] **Step 1: Write failing tests** for dedicated section rendering, prompt-injection warning, absence from appended messages, first-turn-only injection, normal Tool Results continuation, and normal provider retry continuation.
- [ ] **Step 2: Run focused tests** and observe absent input/context behavior.
- [ ] **Step 3: Implement optional data-only input plumbing** and clear `WAITING_VERIFICATION_REPAIR` at the same durable provider Step-start checkpoint.
- [ ] **Step 4: Run focused context/core tests and all existing AgentLoop history/continuation tests**.

### Task 11: Create new plans and fresh evidence after repair

**Files:**
- Modify: `packages/storage/src/repositories/verification-repository.ts`, `packages/storage/src/index.ts`, `packages/core/src/run-controller.ts`
- Test: `packages/storage/test/verification-repair-plans.test.ts`, `packages/core/test/verification-freshness.test.ts`

**Interfaces:**
- Produces `listPlansByRun`/equivalent count port and controller behavior where each new Final Candidate gets a new plan ID/source Step/check IDs/hash, all checks PENDING, and no old evidence is attached.

- [ ] **Step 1: Write failing tests** for immutable old plan, distinct plan/source step IDs, no evidence reuse, fresh project/workspace/git/task execution, and plan-count cycle calculation.
- [ ] **Step 2: Run focused tests** and verify the missing storage/controller behavior.
- [ ] **Step 3: Implement the narrow repository query and reuse `createVerificationPlan`**; never reset old checks.
- [ ] **Step 4: Run focused freshness tests and existing verification repository/run-controller tests**.

### Task 12: Recovery, governance races, architecture guards, and documentation

**Files:**
- Modify: `packages/core/src/run-controller.ts`, `packages/core/src/run-execution-state.ts`, `packages/core/src/index.ts`
- Create: `docs/architecture/verification-change-review.md`, `docs/architecture/verification-repair.md`, `docs/architecture/task-acceptance-review.md`
- Modify: `docs/architecture/verification.md`, `docs/architecture/execution-governance.md`, `docs/architecture/retry.md`, `docs/architecture/budget.md`, `README.md`, `AGENTS.md`
- Test: `packages/core/test/verification-recovery.test.ts`, `tests/architecture/phase-11c-verification-boundaries.test.ts`, focused Phase 11C test files

- [ ] **Step 1: Write failing tests** for safe repair recovery, stale reviewer no-replay, cancellation/deadline/maxSteps/budget before repair, approval/retry/tool governance during repair, full PASS remaining VERIFYING, no completion event/result, and architecture/scope guards.
- [ ] **Step 2: Run focused tests** and record each expected missing behavior.
- [ ] **Step 3: Implement recovery and documentation**; keep stale Verification check reconciliation for Phase 11D and do not add UI/API or completion authority.
- [ ] **Step 4: Run the focused Phase 11C matrix**: workspace, Git, task reviewer, reviewer budget, repair context/policy/transition/freshness, cancellation/deadline, recovery, architecture guards.
- [ ] **Step 5: Run full regressions serially**: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- [ ] **Step 6: Perform clean build verification** by removing only ignored `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` with explicit paths (never `git clean`), then rerun install/lint/typecheck/test/build.
- [ ] **Step 7: Run `pnpm format:check`, `pnpm check`, `git diff --check`, inspect `git status --short` and `git diff`; prove Phase 11C changed files add no Prettier warnings and repository warning count does not exceed the recorded baseline.
- [ ] **Step 8: Commit implementation in the recommended slices**, push the actual Phase 11C branch with `git push -u origin <branch>`, verify local SHA equals remote SHA, and report the complete Phase 11C checklist. Never merge master or force push.

