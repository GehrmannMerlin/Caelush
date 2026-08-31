# Caelush Phase 11D Completion Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh, candidate-bound Verification evidence the sole basis for an atomic and exactly-once `VERIFYING → COMPLETED` transition, with safe recovery and terminal verification failure.

**Architecture:** Protocol owns JSON-safe plan/result/event contracts; Runtime exposes only a read-only raw-byte fingerprint beside existing path safety; Verification owns pure evidence/freshness/digest calculations and check recovery data; Core owns completion authority and lifecycle decisions; Storage owns guarded SQLite transactions and persist-before-notify. The existing 11C repair loop remains the only repair mechanism.

**Tech Stack:** TypeScript/ESM, Zod Protocol schemas, Node `crypto` and streaming `fs`, SQLite/Drizzle storage, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-31-caelush-phase-11d-completion-authority-verification-recovery-design.md`

## Global Constraints

- Phase 11 has exactly 11A, 11B, 11C, and 11D; do not create 11D-1, 11E, or Phase 12 work.
- `Verification PASSED` is necessary but not sufficient; only Core/RunController may authorize `VERIFYING → COMPLETED`.
- Completion must bind the current final candidate, current/latest plan, durable evidence, and fresh workspace/Git state.
- Reuse `WorkspacePathResolver` and existing `RuntimeGitService`; do not create a second path resolver or mutate the workspace during freshness checks.
- Stale RUNNING verification checks never replay; they settle to bounded ERROR evidence.
- Completion persistence is one SQLite transaction across Run, State, finalResult, continuation clearing, and durable events; persist before notify.
- Cancellation, deadline, and budget authority remain higher priority than completion.
- No extra LLM calls, Agent Steps, Tool Invocations, synthetic conversation messages, or completion event family may be introduced.
- Do not run `prettier --write .`; changed files must have zero Prettier warnings and repository historical warning count must not increase.

### Task 1: Protocol identity and final-result contracts

**Files:**

- Modify: `packages/protocol/src/verification.ts`
- Modify: `packages/protocol/src/run.ts`
- Modify: `packages/protocol/src/events/verification.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/verification-contracts.test.ts`
- Test: `packages/protocol/test/verification-events.test.ts`

**Interfaces:**

- Produce `VerificationPlan.candidateHash?: string`, `VerifiedRunFinalResultSchema`, `VerificationCompletionSealSchema`, and `verification.finalized` event schema.
- Preserve legacy plan decoding by keeping `candidateHash` optional in the Protocol decoder; Core completion rejects absent hashes.

- [ ] **Step 1: Write failing tests** for candidate hash format, strict verified final result fields, bounded text/counts, forbidden extra fields, and finalized event payload bounds.
- [ ] **Step 2: Run `pnpm vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/verification-events.test.ts`** and confirm the new contract assertions fail because the schemas/fields do not exist.
- [ ] **Step 3: Add the minimal Zod schemas and exports** without changing unrelated Protocol types or introducing provider/runtime types.
- [ ] **Step 4: Re-run the focused Protocol tests** and confirm they pass; then run the existing Protocol test files.

### Task 2: Candidate hash creation and evidence digest/seal primitives

**Files:**

- Modify: `packages/verification/src/planner.ts`
- Create: `packages/verification/src/completion-integrity.ts`
- Modify: `packages/verification/src/index.ts`
- Test: `packages/verification/test/completion-integrity.test.ts`

**Interfaces:**

- Produce `computeVerificationCandidateTextHash(text)`, `computeVerificationEvidenceDigest(plan, evidence)`, and `createVerificationCompletionSeal(input)`.
- Canonical ordering is checks by `ordinal,id` and evidence by `checkId,capturedAt,id`; foreign evidence and check/evidence mismatches throw a sanitized verification error.

- [ ] **Step 1: Write failing tests** for equal-input determinism, candidate text differences, plan/evidence differences, ordering independence, foreign evidence rejection, and seal field sensitivity.
- [ ] **Step 2: Run the focused test file** and verify the expected missing-export failures.
- [ ] **Step 3: Implement SHA-256 UTF-8 hashing and canonical JSON** with no timestamps or random IDs added by the helper.
- [ ] **Step 4: Run focused tests and all Verification unit tests** to confirm green.

### Task 3: Runtime raw-byte fingerprint capability

**Files:**

- Modify: `packages/runtime/src/filesystem/types.ts`
- Modify: `packages/runtime/src/filesystem/local-filesystem.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/fingerprint.test.ts`

**Interfaces:**

- Produce `RuntimeFileFingerprint` and `RuntimeFileSystem.fingerprintFile(absolutePath)`.
- Use `lstat` for classification and a streaming `createReadStream` SHA-256 for regular files; return `MISSING` without throwing for ENOENT and never decode content.

- [ ] **Step 1: Write failing tests** for same/different bytes, LF/CRLF, BOM, UTF-8 Chinese, binary bytes, missing, symlink, directory, and read errors.
- [ ] **Step 2: Run the focused Runtime test** and verify the interface/method is absent.
- [ ] **Step 3: Implement the minimal streaming fingerprint method** and wire it through the existing filesystem public API.
- [ ] **Step 4: Run the focused Runtime tests plus existing path-safety tests**; confirm no second resolver was introduced.

### Task 4: Workspace fingerprint evidence and freshness comparison

**Files:**

- Modify: `packages/verification/src/contracts.ts`
- Modify: `packages/verification/src/workspace-verifier.ts`
- Modify: `packages/verification/src/evidence.ts`
- Modify: `apps/daemon/src/verification-runtime-adapters.ts`
- Modify: `packages/verification/src/index.ts`
- Test: `packages/verification/test/workspace-freshness.test.ts`
- Test: `apps/daemon/test/verification-runtime-adapter.test.ts`

**Interfaces:**

- Extend workspace observations/evidence with bounded `contentFingerprints` and a deterministic `workspaceFreshnessHash`.
- Produce a comparator that returns PASS, `FRESHNESS_CHANGED`, or `FRESHNESS_UNPROVABLE`; required fingerprints are never silently omitted.

- [ ] **Step 1: Write failing tests** for tracked and untracked files, same-size content changes, deletion/recreation, symlink replacement, deleted sentinels, bounded oversized evidence, and legacy evidence without fingerprints.
- [ ] **Step 2: Run the focused tests** and verify they fail before implementation.
- [ ] **Step 3: Extend the daemon adapter to call `pathResolver.resolveExisting()` and the existing runtime filesystem fingerprint method** while preserving OUTSIDE/MISSING/SYMLINK behavior.
- [ ] **Step 4: Implement deterministic fingerprint normalization/comparison** and update workspace evidence creation with only metadata/hash values.
- [ ] **Step 5: Run workspace, daemon adapter, and existing Verification tests**.

### Task 5: Git freshness comparator

**Files:**

- Modify: `packages/verification/src/git-verifier.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Test: `packages/verification/test/git-freshness.test.ts`

**Interfaces:**

- Produce `compareGitFreshness(verifiedEvidence, currentReview)` and a Core read-only port for status/diff revalidation.
- Compare attributed paths, per-path diff hashes, unmerged state, truncation, and review completeness; keep unrelated dirty-path semantics from 11C.

- [ ] **Step 1: Write failing tests** for equal hashes, changed tracked diff, unmerged conflict, status/diff truncation, and optional Git unavailability.
- [ ] **Step 2: Run the focused Git test and confirm failure.**
- [ ] **Step 3: Implement canonical extraction and comparison** using the existing `reviewGitChangeset()` output and `RuntimeGitService` adapter.
- [ ] **Step 4: Run focused and existing Git verifier tests.**

### Task 6: Core completion authority decision policy

**Files:**

- Create: `packages/core/src/verification-completion-authority.ts`
- Modify: `packages/core/src/agent-state.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/verification-completion-authority.test.ts`
- Test: `packages/core/test/run-execution-state.test.ts`

**Interfaces:**

- Produce `VerificationCompletionDecision`, `VerificationCompletionAuthority`, `markAgentStateCompleted()`, and `markAgentRunCompleted()`.
- The authority is pure policy: it does not call LLM, Tools, Runtime mutation, Storage, or Verification execution.

- [ ] **Step 1: Write failing matrix tests** for PASS, repairable FAILED, exhausted FAILED, ERROR, incomplete pending/no progress, cancellation, deadline, budget, candidate mismatch, freshness changed/unprovable, and advisory failures.
- [ ] **Step 2: Run the focused Core tests and confirm the missing policy/helper failures.**
- [ ] **Step 3: Implement the decision matrix and strict completed helpers** using canonical status transitions and bounded final result validation.
- [ ] **Step 4: Run focused Core state/authority tests and existing state-machine tests.**

### Task 7: Latest-plan lookup and guarded Verification writes

**Files:**

- Modify: `packages/verification/src/contracts.ts`
- Modify: `packages/storage/src/repositories/verification-repository.ts`
- Modify: `packages/storage/src/verification-execution-store.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/verification-repository.test.ts`
- Test: `packages/storage/test/verification-execution-store.test.ts`

**Interfaces:**

- Produce `getLatestPlanByRun(runId)` ordered by `createdAt,id` and a guarded verification write input containing expected current plan/source-step/continuation identity.
- `startCheck`, `settleCheck`, and recovery settlement reject late writes before mutating check/evidence/event rows.

- [ ] **Step 1: Write failing SQLite tests** for latest-plan ordering, writes after COMPLETED/FAILED/CANCELLED/TIMEOUT, writes after repair RUNNING, wrong continuation plan/source step, and no evidence/event side effects on rejection.
- [ ] **Step 2: Run the focused storage tests and observe the current late-write behavior fail the new assertions.**
- [ ] **Step 3: Add the repository lookup and an in-transaction guard** that reads the authoritative Run/continuation rows before check writes.
- [ ] **Step 4: Update all existing Verification runner/stage-runner callers with the current boundary identity.**
- [ ] **Step 5: Run focused Storage and Verification tests.**

### Task 8: Atomic completion and terminal verification failure persistence

**Files:**

- Modify: `packages/core/src/run-execution-store.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/storage/src/run-execution-store.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/protocol/src/events/verification.ts`
- Test: `packages/storage/test/completion-transaction.test.ts`

**Interfaces:**

- Produce narrow `commitVerifiedCompletion()` and `commitVerificationFailure()` Storage ports, or equivalent guarded `RunExecutionCommit` commands, preserving the existing public store abstraction.
- Completion event order is fixed as `verification.finalized`, `status.changed`, `run.completed`; failure order is `verification.finalized`, `error`, `status.changed`, `run.failed`.

- [ ] **Step 1: Write failing fault-injection/race tests** for rollback at Run/State/event/continuation/finalResult writes, cancellation-first, completion-first, deadline-first, budget-first, exactly-once events, and concurrent completion.
- [ ] **Step 2: Run the focused storage tests and confirm no guarded atomic API exists.**
- [ ] **Step 3: Implement `BEGIN IMMEDIATE` completion/failure transactions** with current status, state/continuation revisions, latest-plan, candidate, and cancellation checks before any write.
- [ ] **Step 4: Add terminal-run cancellation guards** so a completion-first transaction cannot be followed by a new durable cancellation intent.
- [ ] **Step 5: Run focused Storage tests and existing run-execution/recovery tests.**

### Task 9: RunController completion authority integration

**Files:**

- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/run-controller-completion.test.ts`
- Test: `packages/storage/test/run-controller-completion-e2e.test.ts`

**Interfaces:**

- `driveChangeVerificationLocked()` invokes only Core authority after existing evaluation and revalidation; it never directly writes COMPLETED from Verification.
- Recovery of terminal Runs is a no-op; PASS recovery runs freshness and guarded completion only; failure/rework paths remain compatible with 11C.

- [ ] **Step 1: Write failing Core/E2E tests** for successful candidate-bound completion, no extra LLM/Step/Tool/conversation changes, final result privacy/bounds, restart stability, terminal no-op recovery, and exact-once events.
- [ ] **Step 2: Run the focused tests and confirm current behavior remains AWAITING_VERIFICATION or replays checks.**
- [ ] **Step 3: Add candidate hash at plan creation and implement completion-time latest-plan, continuation, evidence, freshness, deadline, budget, and cancellation checks.**
- [ ] **Step 4: Route repair exhaustion, Verification ERROR, stale-check ERROR, incomplete-without-progress, and freshness-unprovable terminal cases to atomic `FAILED` with `VERIFICATION_FAILED`.**
- [ ] **Step 5: Add PASSED crash recovery and repeated/concurrent recovery idempotence.**
- [ ] **Step 6: Run focused Core/Storage E2E tests and existing Phase 10–11 controller tests.**

### Task 10: Full Verification recovery and late-result handling

**Files:**

- Modify: `packages/verification/src/change-runner.ts`
- Modify: `packages/verification/src/runner.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/storage/src/verification-execution-store.ts`
- Modify: `packages/core/src/budget-ports.ts`
- Test: `packages/storage/test/verification-recovery-11d.test.ts`
- Test: `packages/core/test/verification-late-results.test.ts`

**Interfaces:**

- Produce one no-replay recovery path for stale PROJECT/WORKSPACE/GIT/TASK checks with bounded interruption evidence.
- Late provider and command results are rejected by storage identity guards; reviewer in-flight recovery uses existing budget authority conservatively before stale TASK settlement.

- [ ] **Step 1: Write failing recovery tests** for all stale check kinds, reviewer in-flight budget, pending safe checks, PASS crash recovery, late results after every terminal status, old plan after repair, and repeated repair exhaustion.
- [ ] **Step 2: Run the focused recovery tests and verify stale checks currently remain RUNNING/replayable.**
- [ ] **Step 3: Implement stale-check atomic settlement and recovery ordering** without invoking the executor or reviewer for stale checks.
- [ ] **Step 4: Implement terminal/recovery idempotence and late result rejection.**
- [ ] **Step 5: Run recovery tests plus Phase 11A/B/C, Phase 10, Phase 9, and Phase 8 regression groups.**

### Task 11: Architecture guards, documentation, and README/AGENTS updates

**Files:**

- Create: `docs/architecture/verification-completion.md`
- Create: `docs/architecture/verification-recovery.md`
- Modify: `docs/architecture/verification.md`
- Modify: `docs/architecture/execution-governance.md`
- Modify: `docs/architecture/runtime.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `tests/architecture/phase-11d-verification-boundaries.test.ts`
- Test: `tests/architecture/phase-11d-verification-boundaries.test.ts`

- [ ] **Step 1: Write failing architecture tests** asserting only Core owns completion, Verification has no Storage/child_process dependency, Runtime has no Verification dependency, no new path resolver exists, no duplicate completion event exists, and forbidden Phase 12/scope leakage is absent.
- [ ] **Step 2: Run the architecture test and confirm failures for missing guards/docs.**
- [ ] **Step 3: Add the narrow architecture guards and the required completion/recovery documentation** including absorbed/rejected external research and final data flow.
- [ ] **Step 4: Update README and AGENTS.md with the Phase 11D durable rules** without changing Phase 12 capabilities.
- [ ] **Step 5: Run architecture and documentation-related tests.**

### Task 12: Final focused and repository verification

**Files:**

- Modify: every Phase 11D source/test/doc file created above, only if a focused format check identifies a warning.

- [ ] **Step 1: Run focused tests for authority, candidate binding, fingerprints, workspace/Git freshness, seal, final result, atomic completion, races, late results, stale recovery, repair exhaustion, and architecture guards.**
- [ ] **Step 2: Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` serially; record exit codes and counts.**
- [ ] **Step 3: Run `pnpm exec prettier --check <each changed file>` and confirm zero warnings for changed files; do not format unrelated files.**
- [ ] **Step 4: Remove only `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` under this worktree using Node fs, then run `pnpm install --frozen-lockfile`, lint, typecheck, test, and build again serially.**
- [ ] **Step 5: Run `pnpm check`, `git diff --check`, and `git status --short`; report historical formatting debt honestly if `pnpm check` still fails only there.**
- [ ] **Step 6: Review `git diff` against this plan and the 11D checklist; commit coherent Phase 11D changes, push the actual branch without force, and verify local HEAD SHA equals `git ls-remote` remote SHA.**
