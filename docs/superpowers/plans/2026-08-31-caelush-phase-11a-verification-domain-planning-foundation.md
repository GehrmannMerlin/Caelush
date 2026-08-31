# Phase 11A Verification Domain, Planning, and Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict, immutable, intent-only VerificationPlan and Evidence foundation and atomically attach one plan to every Final Candidate before the Run enters `VERIFYING`.

**Architecture:** `@caelush/protocol` owns JSON-safe Verification IDs, plan/check/evidence schemas, lifecycle enums, and the `verification.planned` event. `@caelush/verification` owns a deterministic, side-effect-free planner, canonical plan hashing, and pure evaluation. Core owns only the structural planner port and coordinates a materialized plan through the existing `RunExecutionStorePort`; Storage persists plans/checks/evidence in one SQLite execution transaction and publishes only after commit.

**Tech Stack:** TypeScript ESM, Node.js 24, pnpm workspaces, Zod 4, Vitest, `node:sqlite`, Drizzle ORM migrations, SHA-256 canonical hashing, existing Core/Storage/EventBus contracts.

**Spec:** `docs/superpowers/specs/2026-08-31-caelush-phase-11a-verification-foundation-design.md`

## Global Constraints

- Phase 11 has exactly four rounds: 11A, 11B, 11C, and 11D; do not add 11A-1, 11A-2, 11E, or Phase 12 work.
- An `AgentFinalCandidateDecision` is a completion candidate, never completion authority.
- No Run may transition to `VERIFYING` without a durable `VerificationPlan` and an `AWAITING_VERIFICATION` continuation pointing to that plan.
- Verification planning is deterministic, LLM-free, filesystem-free, network-free, Runtime-free, Storage-free, and Tool-free.
- Plans contain verification intents, never guessed concrete commands; project command discovery and execution belong to Phase 11B.
- `VerificationPlan` is immutable and bound to exactly one Run and one source Final Candidate `StepId`; a repaired candidate receives a new plan and never reuses old evidence.
- Verification evidence is immutable, bounded, JSON-safe, and scoped to one plan/check; it must not contain secrets, prompts, hidden reasoning, or unbounded output.
- Phase 11A does not execute lint, typecheck, tests, builds, Git, shell, Runtime, or child processes; it does not change Security/Approval, Tool accounting, retry, cancellation, timeout, budget, repair, or completion behavior.
- Core must not import concrete `@caelush/verification`; `@caelush/verification` must not import Core, Storage, Runtime, Tools, Security, LLM, or app packages.
- Existing `AWAITING_VERIFICATION`, `VERIFYING`, cancellation, deadline, retry, budget, and EventBus semantics remain intact except for the required plan pointer and atomic plan write.
- Use `apply_patch` for source edits, preserve unrelated user changes, never use `git reset --hard`, `git clean`, or force push, and keep generated `dist`/`*.tsbuildinfo` out of commits.
- `PHASE_11A_FORMAT_BASELINE=627`; changed files must produce zero individual Prettier warnings and repository warnings must not exceed 627.

---

### Task 1: Freeze protocol identifiers and Verification contracts

**Files:**

- Modify: `packages/protocol/src/primitives/ids.ts`
- Modify: `packages/protocol/src/verification.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/verification-contracts.test.ts`
- Modify: `packages/protocol/test/ids.test.ts`
- Modify: `packages/protocol/test/observation.test.ts` only where legacy compatibility assertions need the new IDs

**Interfaces:**

- Produces `VerificationPlanIdSchema/createVerificationPlanId`, `VerificationCheckIdSchema/createVerificationCheckId`, and `VerificationEvidenceIdSchema/createVerificationEvidenceId` with distinct `vplan_`, `vchk_`, and `vevd_` UUIDv7 prefixes.
- Produces strict `VerificationPlanSchema`, `VerificationCheckSchema`, `VerificationCheckSpecSchema`, `VerificationEvidenceSchema`, `VerificationPlanningInputSchema`, and their inferred public types.
- Preserves the existing legacy `VerificationResultSchema` and `VerificationStateSchema` until adjacent Phase 1 observation/state contracts are migrated in a later round.

- [ ] **Step 1: Write failing protocol tests** for all three ID prefixes, strict plan/check/evidence parsing, unknown-field rejection, invalid requirement/stage/status/spec rejection, contiguous zero-based ordinal bounds, maximum 32 checks, bounded summary/purpose/version text, JSON-safe evidence, and rejection of `Error`, `AbortSignal`, `Map`, `Set`, `Buffer`, and `BigInt` values.
- [ ] **Step 2: Run the focused tests to verify RED**

Run: `pnpm vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/ids.test.ts packages/protocol/test/observation.test.ts`

Expected: FAIL because the Phase 11A identifiers, schemas, and exports do not exist; any unrelated baseline failure must be reported separately.

- [ ] **Step 3: Implement the minimum strict schemas** using the existing branded UUID helper, `JsonValueSchema`, `TimestampMsSchema`, `RunIdSchema`, `StepIdSchema`, `WorkspaceRefSchema`, and `FileChangeSummarySchema`. Define project/workspace/Git/task discriminants, `SYSTEM|PROJECT|USER` source, `REQUIRED|IF_AVAILABLE|ADVISORY` requirement, all five stages, all seven check statuses, `NOT_AVAILABLE|NOT_APPLICABLE` skip reasons, and a 32-check plan limit without introducing a new RunStatus.
- [ ] **Step 4: Run the focused tests to verify GREEN**

Run: `pnpm vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/ids.test.ts packages/protocol/test/observation.test.ts`

Expected: PASS with legacy observation/verification tests still green.

- [ ] **Step 5: Refactor only after green** to keep the new Protocol file bounded and ensure every export enters through `packages/protocol/src/index.ts`; rerun the focused tests.
- [ ] **Step 6: Commit the protocol contract**

Run: `git add packages/protocol/src packages/protocol/test && git commit -m "feat(protocol): define verification contracts"`

### Task 2: Add the planned event and continuation pointer

**Files:**

- Modify: `packages/protocol/src/events/verification.ts`
- Modify: `packages/protocol/src/events/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/core/src/agent-continuation.ts`
- Modify: `packages/core/src/agent-continuation-schema.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/protocol/test/verification-event.test.ts`
- Modify: `packages/core/test/agent-continuation.test.ts`

**Interfaces:**

- Produces strict durable `VerificationPlannedEventSchema` with payload `{ verificationPlanId, sourceStepId, checkCount, plannerVersion, requiredCount?, ifAvailableCount?, advisoryCount? }` and no goal/candidate/command/secret fields.
- Extends `AwaitingVerificationContinuation` and its schema with required `verificationPlanId: VerificationPlanId`.
- Removes `verification.started`/`verification.completed` from the new Phase 11A event path while retaining legacy non-Phase-11 Protocol types only if existing public tests require them; `AgentEventSchema` includes exactly the new planned event for Phase 11A.

- [ ] **Step 1: Write failing tests** for strict event envelope/serialization/replay shape and for continuation parsing requiring a plan pointer, including rejection of unknown fields and plan-less production-shaped continuations.
- [ ] **Step 2: Run focused protocol/core tests and verify RED**

Run: `pnpm vitest run packages/protocol/test/verification-event.test.ts packages/core/test/agent-continuation.test.ts`

Expected: FAIL because the new event and required pointer are absent.

- [ ] **Step 3: Implement the event and continuation schema changes** and update all typed exports.
- [ ] **Step 4: Update existing fixtures at their construction sites** to allocate a plan pointer instead of adding a production fallback that permits an undefined plan.
- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run packages/protocol/test/verification-event.test.ts packages/core/test/agent-continuation.test.ts packages/protocol/test/event.test.ts`

Expected: PASS with exactly one new durable event variant and no completion event.

- [ ] **Step 6: Commit the Protocol event and continuation boundary**

Run: `git add packages/protocol/src packages/protocol/test packages/core/src packages/core/test && git commit -m "feat(protocol): add verification planning boundary"`

### Task 3: Implement canonical hashing and the deterministic planner

**Files:**

- Create: `packages/verification/src/contracts.ts` if the public types need a focused package-local barrel
- Create: `packages/verification/src/plan-hash.ts`
- Create: `packages/verification/src/planner.ts`
- Modify: `packages/verification/src/index.ts`
- Create: `packages/verification/test/plan-hash.test.ts`
- Create: `packages/verification/test/planner.test.ts`
- Modify: `packages/verification/package.json` only if a declared dependency is required; keep Protocol as the only runtime dependency

**Interfaces:**

- Produces `canonicalVerificationPlanContent(draft): string` and `hashVerificationPlan(draft): string` with lowercase SHA-256; canonical content excludes plan ID, check IDs, timestamps, goal text, and command strings.
- Produces `VerificationPlanner`/`DefaultVerificationPlanner` with `plan(input: VerificationPlanningInput): VerificationPlanDraft`.
- Produces a draft with ordered, deduplicated, zero-based intent checks, bounded planner version, and stable `planHash`; it does not materialize durable IDs or timestamps.

- [ ] **Step 1: Write failing plan-hash tests** proving IDs/timestamps do not affect the hash, source Step/planner version/spec/requirement changes do affect the hash, property order is canonical, and the digest is exactly 64 lowercase hex characters.
- [ ] **Step 2: Run plan-hash tests and verify RED**

Run: `pnpm vitest run packages/verification/test/plan-hash.test.ts`

Expected: FAIL because the hash module does not exist.

- [ ] **Step 3: Implement canonical content and SHA-256 hashing** with explicit key ordering and Protocol validation.
- [ ] **Step 4: Run plan-hash tests and verify GREEN**
- [ ] **Step 5: Write failing planner tests** for no-change code facts, changed files, explicit/non-explicit Git facts, non-code facts, duplicate facts, stable stage order, required Task Acceptance, no command fields, and repeated planning producing equal logical drafts/hashes.
- [ ] **Step 6: Run planner tests and verify RED**

Run: `pnpm vitest run packages/verification/test/planner.test.ts`

Expected: FAIL because `DefaultVerificationPlanner` does not exist.

- [ ] **Step 7: Implement the minimal planner**: always add `TASK/ACCEPTANCE/REQUIRED/ACCEPTANCE`; add Project LINT/TYPECHECK/TEST/BUILD as `IF_AVAILABLE` when `projectFacts.isCodeProject !== false`; add required Workspace `CHANGESET_SANITY` for non-empty `changedFiles`; add Git `CHANGESET_REVIEW` as `REQUIRED` only for explicit Git facts, `IF_AVAILABLE` for unknown Git facts, and omit it when facts say non-Git. Deduplicate by `(kind, purpose)` and sort by stage then canonical kind/purpose order.
- [ ] **Step 8: Run planner tests and verify GREEN**

Run: `pnpm vitest run packages/verification/test/plan-hash.test.ts packages/verification/test/planner.test.ts`

Expected: PASS with zero filesystem, network, LLM, Runtime, Storage, Tool, or command execution.

- [ ] **Step 9: Commit planner and hashing**

Run: `git add packages/verification && git commit -m "feat(verification): add deterministic verification planning"`

### Task 4: Implement pure Verification evaluation

**Files:**

- Create: `packages/verification/src/evaluator.ts`
- Modify: `packages/verification/src/index.ts`
- Create: `packages/verification/test/evaluator.test.ts`

**Interfaces:**

- Produces `evaluateVerification(input: { checks: readonly VerificationCheck[]; evidence: readonly VerificationEvidence[] }): VerificationEvaluation`.
- Returns only `INCOMPLETE|PASSED|FAILED|ERROR`, bounded public reasons, and advisory warnings; it never transitions a Run or calls a planner/runner.

- [ ] **Step 1: Write failing evaluator tests** for zero checks, pending/running, missing evidence, required failed/error, all required passed, IF_AVAILABLE passed, valid unavailable skip evidence, invalid skip evidence, advisory failure, cancellation, and anti-self-certification text that cannot affect evaluation.
- [ ] **Step 2: Run evaluator tests and verify RED**

Run: `pnpm vitest run packages/verification/test/evaluator.test.ts`

Expected: FAIL because the evaluator does not exist.

- [ ] **Step 3: Implement the pure status rules**: zero checks and pending/running/missing required evidence are `INCOMPLETE`; blocking failed/error map to `FAILED`/`ERROR`; advisory failures become warnings; IF_AVAILABLE skips require `DISCOVERY` evidence with an explicit unavailable marker; only all blocking checks passing yields `PASSED`.
- [ ] **Step 4: Run evaluator tests and verify GREEN**
- [ ] **Step 5: Commit evaluation foundation**

Run: `git add packages/verification && git commit -m "feat(verification): add pure verification evaluation"`

### Task 5: Add durable SQLite plan/check/evidence repositories

**Files:**

- Modify: `packages/storage/src/schema.ts`
- Create: `packages/storage/drizzle/20260831170000_verification_foundation/migration.sql`
- Create: `packages/storage/src/repositories/verification-repository.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/test/migrations.test.ts`
- Create: `packages/storage/test/verification-repository.test.ts`

**Interfaces:**

- Produces `VerificationRepository` methods `createPlan`, `getPlanById`, `getPlanBySourceStep`, `listChecks`, `getCheck`, and `listEvidence`.
- `createPlan` accepts a validated immutable `VerificationPlan` plus its ordered checks and returns the existing matching plan for an identical `(runId, sourceStepId, planHash)` or throws a sanitized conflict for a different hash.
- The repository never exposes `DatabaseSync`, Drizzle clients, row types, `runCheck`, plan replacement, or `appendCheck`/`updatePlan` mutation APIs.

- [ ] **Step 1: Write failing migration/repository tests** for fresh tables, all required foreign keys, `(run_id, source_step_id)` uniqueness, `(plan_id, ordinal)` uniqueness, strict codec round trips, plan immutability, same-hash idempotency, different-hash conflict, wrong source ownership, bounded evidence summary/details, and persistence after close/reopen.
- [ ] **Step 2: Run focused storage tests and verify RED**

Run: `pnpm vitest run packages/storage/test/migrations.test.ts packages/storage/test/verification-repository.test.ts`

Expected: FAIL because the tables, migration, and repository do not exist.

- [ ] **Step 3: Add exactly one committed migration and matching Drizzle table metadata** for `verification_plans`, `verification_checks`, and `verification_evidence`; use foreign keys to existing Runs/Steps/parent records and the existing non-cascade durable-history convention.
- [ ] **Step 4: Implement repository create/read/idempotency operations** with scalar column cross-checks, Protocol schema decode, strict JSON parsing, and sanitized `StorageConflictError`/`StorageDecodeError` mapping.
- [ ] **Step 5: Add the repository to `CaelushStorage` composition and public exports** without adding an `@caelush/verification` dependency to Storage.
- [ ] **Step 6: Run focused migration/repository tests and verify GREEN**
- [ ] **Step 7: Commit storage foundation**

Run: `git add packages/storage && git commit -m "feat(storage): persist verification plans and checks"`

### Task 6: Extend the atomic Run execution commit

**Files:**

- Modify: `packages/core/src/run-execution-store.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/storage/src/run-execution-store.ts`
- Modify: `packages/storage/src/repositories/verification-repository.ts` for transaction-only helpers
- Create: `packages/storage/test/verification-execution-atomicity.test.ts`
- Modify: `packages/core/test/run-execution-store-contract.test.ts`

**Interfaces:**

- Adds `RunExecutionVerificationPlanCreate` containing the full plan and ordered checks to `RunExecutionCommit.verificationPlanCreate`.
- Extends `RunExecutionSnapshot` with no mutable AgentState plan copy; Verification plan lookup remains behind Storage's repository.
- Adds internal transaction helpers to write the plan/check rows and validate plan/run/source-step ownership before event append.

- [ ] **Step 1: Write failing atomicity tests** that inject plan insert, check insert, continuation, and event insert failures and assert no partial `VERIFYING` Run, State, continuation, plan, check, or event remains; test event notification occurs only after commit.
- [ ] **Step 2: Run the focused atomicity tests and verify RED**

Run: `pnpm vitest run packages/storage/test/verification-execution-atomicity.test.ts packages/core/test/run-execution-store-contract.test.ts`

Expected: FAIL because the commit payload cannot carry a Verification plan.

- [ ] **Step 3: Implement the optional transaction payload** and write it between settled Step/State and durable event append inside the same existing `BEGIN IMMEDIATE`/`COMMIT` block. Validate the plan schema, plan/run/source-step ownership, check ordinals, and unique logical identity before writing.
- [ ] **Step 4: Map same-hash duplicate commits to the existing immutable plan and reject different-hash conflicts** without overwriting rows or emitting a second `verification.planned` event.
- [ ] **Step 5: Run focused atomicity tests and verify GREEN**
- [ ] **Step 6: Commit atomic execution storage**

Run: `git add packages/core/src packages/core/test packages/storage/src packages/storage/test && git commit -m "feat(storage): attach verification planning to execution commits"`

### Task 7: Integrate planner port and Final Candidate settlement in Core

**Files:**

- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/run-controller-verification.test.ts`
- Modify: all Core/Storage controller fixtures that construct a Final Candidate boundary

**Interfaces:**

- Adds structural `VerificationPlannerPort.plan(input: VerificationPlanningInput): VerificationPlanDraft | Promise<VerificationPlanDraft>` to Core ports.
- Adds injected `VerificationPlanIdFactory` and `VerificationCheckIdFactory` ports for materializing durable IDs without embedding a concrete Verification package in Core.
- Extends `RunControllerResult` `AWAITING_VERIFICATION` with `verificationPlanId` and compact check counts.

- [ ] **Step 1: Write failing RunController integration tests** for Final Candidate → durable plan/checks, Run/State `VERIFYING`, required continuation pointer, source Step match, one `verification.planned`, one `status.changed`, no `COMPLETED`, no `run.completed`, unchanged conversation semantics, and zero budget/tool/token additions.
- [ ] **Step 2: Run focused Core/Storage controller tests and verify RED**

Run: `pnpm vitest run packages/core/test/run-controller-verification.test.ts packages/storage/test/run-controller-boundaries.test.ts packages/storage/test/run-controller-restart.test.ts`

Expected: FAIL because the controller produces a plan-less continuation and no plan rows.

- [ ] **Step 3: Implement planner dependency and deterministic plan materialization**: check cancellation, deadline, max-step, retry, and budget authority first; call the injected planner once; validate the draft; allocate IDs/timestamp; build the immutable plan; and submit it in the existing final-candidate commit.
- [ ] **Step 4: Add `verification.planned` event construction** with only bounded plan identity/count metadata and append it in the existing durable event order before `status.changed` as required by the current conventions.
- [ ] **Step 5: Extend result mapping** with `verificationPlanId` and summary counts without copying the full plan or evidence; keep `AgentLoop` unaware of Planner/Repository/Runner.
- [ ] **Step 6: Update centralized fixtures and all existing expected results** to use a deterministic fake planner/ID factory; do not add a production fallback that can create plan-less `VERIFYING` data.
- [ ] **Step 7: Run focused integration tests and verify GREEN**
- [ ] **Step 8: Commit Core integration**

Run: `git add packages/core packages/storage/test && git commit -m "feat(core): attach verification plans to final candidates"`

### Task 8: Add planned-boundary recovery and corruption fail-closed behavior

**Files:**

- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/storage/src/run-execution-store.ts`
- Create: `packages/storage/test/verification-recovery.test.ts`
- Modify: `packages/storage/test/run-controller-restart.test.ts`
- Modify: `packages/storage/test/recovery.test.ts`

**Interfaces:**

- Recovery of `VERIFYING/AWAITING_VERIFICATION` loads the referenced existing plan and returns the same result without Planner, LLM, Tool, Runtime, or event calls.
- Missing plan, plan/run mismatch, and plan/source-step mismatch fail closed as sanitized invariant/storage errors.

- [ ] **Step 1: Write failing restart/corruption tests** using real file-backed SQLite: close/reopen preserves plan ID/hash/check order/source Step; planner call count remains zero; no new event appears; missing referenced plan and mismatches reject without replacement.
- [ ] **Step 2: Run focused recovery tests and verify RED**
- [ ] **Step 3: Implement recovery validation** by loading the plan through the Storage repository, checking continuation pointer ownership, and returning the existing boundary without calling `planner.plan()`.
- [ ] **Step 4: Run focused recovery tests and verify GREEN**
- [ ] **Step 5: Add anti-self-certification E2E coverage** proving candidate text such as `All tests passed` leaves the plan checks `PENDING`, evaluation `INCOMPLETE`, and Run `COMPLETED` false.
- [ ] **Step 6: Commit recovery and anti-self-certification boundaries**

Run: `git add packages/core packages/storage/src packages/storage/test && git commit -m "test: cover durable verification planning boundaries"`

### Task 9: Add architecture guards and Phase 10 regression coverage

**Files:**

- Modify: `tests/architecture/package-boundaries.test.ts`
- Create: `tests/architecture/verification-boundaries.test.ts`
- Create: `packages/verification/test/architecture.test.ts`
- Create or modify: `packages/core/test/verification-governance-regression.test.ts`
- Modify: `packages/storage/test/run-controller-failure.test.ts` and adjacent Phase 10 tests only where plan creation races need explicit assertions

**Interfaces:**

- Static guards prove Verification has no imports/dependencies on Core, Runtime, Tools, Storage, Security, LLM, apps, `node:child_process`, `node-pty`, Git CLI, or concrete execution helpers; Core has no concrete Verification package import; AgentLoop has no Verification knowledge.
- Regression tests prove planning does not create ToolInvocations, budget entries, Provider calls, retry boundaries, Approval requests, Runtime calls, or new terminal statuses.

- [ ] **Step 1: Write failing static/regression tests** with exact forbidden import/dependency/token assertions and cancellation/deadline/retry/budget priority races while a Run is `VERIFYING`.
- [ ] **Step 2: Run focused architecture/regression tests and verify RED**
- [ ] **Step 3: Implement only the minimum import/export/test fixture changes** required by the Phase 11A design; do not add Runtime or Security integration.
- [ ] **Step 4: Run focused architecture/regression tests and verify GREEN**
- [ ] **Step 5: Commit architecture guards**

Run: `git add tests/architecture packages/verification/test packages/core/test packages/storage/test && git commit -m "test: guard verification architecture boundaries"`

### Task 10: Update architecture documentation, README, and AGENTS rules

**Files:**

- Create: `docs/architecture/verification.md`
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/architecture/execution-governance.md`
- Modify: `docs/architecture/storage-and-events.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Documentation states that Final Candidate is not completion, plans contain intents not commands, evidence is plan-scoped, and Phase 11A does not execute verification or transition to `COMPLETED`.
- Architecture diagrams show `AgentLoop → Final Candidate → RunController → VerificationPlanner → VerificationPlan → Durable Store → VERIFYING`, Candidate ≠ Authority, and the four frozen Phase 11 rounds.

- [ ] **Step 1: Write documentation assertions/checklist** in the new verification architecture document and update existing docs using the actual implemented names and boundaries.
- [ ] **Step 2: Run documentation/static scans and verify the expected pre-change failures** for missing document/phrases.
- [ ] **Step 3: Implement the required documents and durable AGENTS rules** without claiming automatic tests, proven correctness, or completion.
- [ ] **Step 4: Run targeted scans** for forbidden claims (`tests automatically run`, `task correctness proven`, `Run can automatically complete`) and required phrases.
- [ ] **Step 5: Commit documentation**

Run: `git add docs/architecture README.md AGENTS.md && git commit -m "docs: document phase 11a verification architecture"`

### Task 11: Focused test matrix and plan self-review

**Files:**

- Modify focused tests under `packages/protocol/test`, `packages/verification/test`, `packages/storage/test`, and `packages/core/test` only to close requirements found during review.
- Modify: `docs/superpowers/plans/2026-08-31-caelush-phase-11a-verification-domain-planning-foundation.md` if implementation discoveries require exact signature corrections.

- [ ] **Step 1: Run the complete focused Phase 11A matrix**

Run: `pnpm vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/verification-event.test.ts packages/verification/test/plan-hash.test.ts packages/verification/test/planner.test.ts packages/verification/test/evaluator.test.ts packages/verification/test/architecture.test.ts packages/storage/test/migrations.test.ts packages/storage/test/verification-repository.test.ts packages/storage/test/verification-execution-atomicity.test.ts packages/storage/test/verification-recovery.test.ts packages/core/test/run-controller-verification.test.ts packages/core/test/verification-governance-regression.test.ts tests/architecture/verification-boundaries.test.ts`

Expected: PASS with explicit coverage for the contract, planner, evaluator, migration, repository, atomic commit, restart, anti-self-certification, Phase 10 priorities, and architecture boundaries.

- [ ] **Step 2: Re-read the design and this plan against the implementation**; verify no task introduces 11B command discovery, 11C repair, or 11D completion authority.
- [ ] **Step 3: Run `git diff --check`, inspect `git diff --stat`, and scan changed production code** for `child_process`, `node-pty`, `spawn(`, `exec(`, `git status`, `git diff`, `COMPLETED` transitions, ToolInvocation creation, and plan/evidence secrets.
- [ ] **Step 4: Commit any narrowly scoped test-only corrections** with `test: cover phase 11a verification boundaries`.

### Task 12: Clean build, full regression, format, and final Git gates

**Files:**

- No source changes expected; inspect only generated artifacts and final diff.

- [ ] **Step 1: Remove only validated generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` with explicit Node filesystem operations; never use `git clean`.
- [ ] **Step 2: Run the strict serial clean verification**

Run: `pnpm install --frozen-lockfile`

Then run independently in order: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

Expected: all exit 0; plain `pnpm test` must report the full suite with zero failures and no retry flag.

- [ ] **Step 3: Run `pnpm format:check` and record final warning count**; require zero warnings in every Phase 11A changed file and final repository warnings `<= 627`. Do not run `prettier --write .`.
- [ ] **Step 4: Run `pnpm check` and report whether the only failure is the known historical formatting debt**; do not conceal a new lint/typecheck/test/build failure.
- [ ] **Step 5: Run `git diff --check`, `git status --short`, `git log --oneline --decorate -12`, and exact static audits; verify only intended commits/files are present and no generated/unrelated file is tracked.
- [ ] **Step 6: Run the final Phase 11A checklist**: no Runner/command/Git/Runtime/repair/completion leakage; plan immutable/source-bound/hashed; evidence bounded/scoped; atomic plan/Run/State/Step/continuation/event commit; restart/recovery idempotent; cancellation/deadline/retry/budget/security/runtime/AgentLoop regressions pass.
- [ ] **Step 7: Push the dedicated branch without force**

Run: `git push -u origin codex/phase-11a-verification-domain-planning-foundation`

If TLS/network remains unavailable, preserve the exact error and do not claim remote success.

- [ ] **Step 8: Verify local/remote SHA only if push succeeds**

Run: `$localSha = git rev-parse HEAD; $remoteSha = (git ls-remote --heads origin refs/heads/codex/phase-11a-verification-domain-planning-foundation | ForEach-Object { ($_ -split '\\s+')[0] }); Write-Output "LOCAL_SHA=$localSha"; Write-Output "REMOTE_SHA=$remoteSha"; if ($localSha -ne $remoteSha) { exit 1 }`

- [ ] **Step 9: Use `superpowers:verification-before-completion`**: only report Phase 11A complete if every required gate has fresh evidence; otherwise report the exact unmet gate and current branch/commit state.
