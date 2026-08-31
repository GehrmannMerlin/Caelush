# Caelush Phase 10D Budget Enforcement and Governance Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add crash-safe Tool-call, LLM-token, and estimated-cost budget enforcement and finish the Phase 10 execution-governance boundary without implementing Phase 11.

**Architecture:** Use one durable `run_budget_entries` ledger as the enforcement authority and a pure Core `BudgetManager` for admission/calculation. Integrate reservations into the existing SQLite execution transactions before Tool handlers and Provider calls, then project reconciled usage into `AgentState` and route all terminal outcomes through the existing authority/cleanup model.

**Tech Stack:** TypeScript/ESM monorepo, Zod protocol schemas, Vitest, SQLite/`node:sqlite` storage with committed migrations, existing Context UTF-8 estimator, AI SDK provider adapters, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-30-caelush-phase-10d-budget-governance-design.md` and the user-provided Phase 10D source text.

## Global Constraints

- Phase 10 has exactly 10A, 10B, 10C, and 10D; stop after 10D and do not implement Phase 11.
- Budget enforcement is `Reserve -> Execute -> Settle`; reservations are durable before external effects.
- `RunBudgetLedger` is authoritative for Tool/Token/Cost enforcement; `AgentState.usage` is a projection.
- `IN_FLIGHT` reservations are never released after an ambiguous crash; missing usage is conservative, never zero.
- `maxSteps` remains `MAX_STEPS_REACHED`; deadline remains `TIMEOUT`; budget dimensions map to `BUDGET_EXCEEDED`.
- Cancellation and deadline outrank budget; maxSteps outranks budget and retry; budget outranks retry.
- Security denial and approval waiting consume zero Tool calls; a started handler consumes one exactly once.
- Tool batches preflight executable segments so budget exhaustion cannot cause avoidable partial side effects.
- `maxCost` is USD externally, integer micro-USD internally, with overflow-safe BigInt arithmetic and injected pricing snapshots.
- No live pricing, billing, public budget API/UI, VerificationRunner, `COMPLETED`, MCP, Browser, remote runtime, or OS hard sandbox.
- Use `@caelush/*` public package entrypoints, keep `tools -> core` and `runtime -> core` forbidden, and preserve existing no-replay semantics.
- Every behavior change follows TDD: failing test observed before production code, then minimal implementation and green verification.

---

### Task 1: Baseline, characterization, and audit artifacts

**Files:**

- Create/Modify: `docs/superpowers/plans/2026-08-30-caelush-phase-10d-budget-enforcement-governance-finalization.md`
- Create: `docs/superpowers/specs/2026-08-30-caelush-phase-10d-budget-governance-design.md`
- Create: `docs/superpowers/characterization/2026-08-30-caelush-phase-10d-accounting-characterization.md`

- [ ] Record Phase 10C remote SHA, selected base, branch, worktree, and clean baseline commands.
- [ ] Record actual usage mutation points, Step lifecycle, LLMCall identity, Tool preflight/security/approval order, Context estimator, adapter normalization, and Storage transaction boundaries.
- [ ] Record the fresh format baseline (607 warnings) and the Phase 10C regression counts (222 files, 820 passed, 4 skipped) as reference, then commit documentation only.

### Task 2: Harden RunLimits and protocol error/event contracts

**Files:**

- Modify: `packages/protocol/src/limits.ts`, `packages/protocol/src/error.ts`, `packages/protocol/src/events/*`, `packages/protocol/src/index.ts`
- Create/Modify: `packages/protocol/test/limits.test.ts`, `packages/protocol/test/event.test.ts`, `packages/protocol/test/public-api.test.ts`

- [ ] Write failing tests for safe positive `maxSteps`, `maxToolCalls`, `timeoutMs`, optional `maxTokens`, finite positive micro-USD-representable `maxCost`, and sanitized `BUDGET_ENFORCEMENT_UNAVAILABLE`/`budget.exceeded` contracts.
- [ ] Run the focused tests and observe expected failures.
- [ ] Implement strict schemas and public exports without changing the Protocol run status set.
- [ ] Run focused protocol tests and commit.

### Task 3: Pure budget arithmetic and reservation domain

**Files:**

- Create: `packages/core/src/budget-types.ts`, `packages/core/src/budget-manager.ts`, `packages/core/src/cost-micros.ts`, `packages/core/src/llm-usage-normalizer.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/budget-manager.test.ts`, `packages/core/test/cost-micros.test.ts`, `packages/core/test/llm-usage-normalizer.test.ts`

- [ ] Write failing tests for Tool/token/cost exact boundaries, combined clamps, safe integer checks, decimal USD conversion, ceiling cost calculation, zero rates, overflow, cached/reasoning subsets, inconsistent totals, missing usage, and actual greater than reservation.
- [ ] Observe the tests fail for missing domain behavior.
- [ ] Implement immutable budget snapshots, admission decisions, output allowance/clamping, micro-USD arithmetic, pricing validation, reservation lifecycle types, and conservative usage normalization without SQLite/provider/tool dependencies.
- [ ] Run focused domain tests and commit.

### Task 4: Durable budget ledger migration and repository

**Files:**

- Modify: `packages/storage/src/schema.ts`, `packages/storage/src/migrate.ts`, `packages/storage/src/storage.ts`, `packages/storage/src/index.ts`
- Create: `packages/storage/src/budget-ledger-repository.ts`
- Create/Modify: `packages/storage/test/migrations.test.ts`, `packages/storage/test/budget-ledger-repository.test.ts`

- [ ] Write failing tests for the single migration, unique `(run_id, kind, owner_id)`, state transitions, idempotent owner lookup, aggregate snapshots, reserved capacity, released capacity, actual settlement, and crash conversion to conservative.
- [ ] Observe focused storage failures.
- [ ] Implement the narrow migration and repository with protocol-safe DTOs and transaction-compatible operations; do not expose database rows or clients.
- [ ] Run focused storage tests and commit.

### Task 5: Core budget ports and projection reconciliation

**Files:**

- Create: `packages/core/src/budget-ports.ts`, `packages/core/src/budget-reconciliation.ts`
- Modify: `packages/core/src/run-execution-store.ts`, `packages/core/src/run-controller-ports.ts`, `packages/core/src/agent-state.ts`, `packages/core/src/index.ts`
- Create/Modify: `packages/core/test/budget-reconciliation.test.ts`, `packages/core/test/run-execution-store-contract.test.ts`

- [ ] Write failing tests for loading `RunBudgetSnapshot`, reconciling Tool calls/tokens/cost to `AgentState`, and preserving `steps` from settled Step semantics.
- [ ] Observe failures.
- [ ] Add narrow Core ports for ledger operations, token estimation, pricing resolution, and terminal resource cleanup without importing Storage or concrete adapters into `BudgetManager`.
- [ ] Implement deterministic projection/reconciliation and commit.

### Task 6: Tool budget admission and durable start accounting

**Files:**

- Modify: `packages/tools/src/dispatcher-ports.ts`, `packages/tools/src/dispatcher-types.ts`, `packages/tools/src/dispatcher.ts`, `packages/tools/src/batch-coordinator.ts`, `packages/tools/src/batch-types.ts`, `packages/tools/src/index.ts`
- Modify: `packages/storage/src/tool-execution-store.ts`
- Create/Modify: `packages/tools/test/dispatcher-execution.test.ts`, `packages/tools/test/batch-coordinator.test.ts`, `packages/storage/test/tool-execution-store.test.ts`

- [ ] Write failing tests for Security DENY/approval waiting/rejection/preflight zero, exact handler-start one, ordinary error/cancel/uncertain one, duplicate reservation idempotency, and atomic invocation/ledger start.
- [ ] Write the critical batch test: max 1 with two executable patch calls causes zero handlers and unchanged workspace.
- [ ] Observe failures before changing production code.
- [ ] Add a structural budget admission port, executable-segment preflight, durable whole-segment reservation, atomic `REQUESTED -> RUNNING` plus `RESERVED -> IN_FLIGHT`, terminal settlement, and release only for provably unstarted calls.
- [ ] Preserve approval and no-replay behavior; run focused Tool/Storage tests and commit.

### Task 7: Tool recovery and usage projection integration

**Files:**

- Modify: `packages/tools/src/dispatcher.ts`, `packages/storage/src/tool-execution-store.ts`, `packages/core/src/run-controller.ts`
- Create/Modify: `packages/tools/test/dispatcher-recovery.test.ts`, `packages/storage/test/recovery.test.ts`, `packages/storage/test/run-controller-tool-integration.test.ts`

- [ ] Write failing restart tests for `RUNNING + IN_FLIGHT` counting once, `RESERVED + never RUNNING` release, and uncertainty barrier/no trailing handler.
- [ ] Observe failures.
- [ ] Implement recovery reconciliation and projection without replaying a Tool; ensure `AgentState.usage.toolCalls` is derived from authoritative ledger accounting.
- [ ] Run focused tests and commit.

### Task 8: Token estimator and provider usage settlement

**Files:**

- Modify: `packages/context/src/index.ts` only if a public estimator path is needed; otherwise reuse existing `token-estimator.ts`
- Create: `packages/core/src/llm-token-estimator.ts`, `packages/core/src/llm-budget-admission.ts`
- Modify: `packages/core/src/agent-loop-ports.ts`, `packages/core/src/run-controller.ts`, `packages/core/src/agent-state.ts`, `packages/core/src/index.ts`
- Create/Modify: `packages/core/test/llm-token-estimator.test.ts`, `packages/core/test/llm-budget-admission.test.ts`, `packages/core/test/llm-usage-normalizer.test.ts`, `packages/core/test/run-controller-start.test.ts`

- [ ] Write failing tests proving full request estimation, maxTokens absent behavior, missing-estimator fail-closed behavior, exact/over boundary, configured lower output, budget clamp, no Step on blocked call, and conservative missing usage.
- [ ] Observe failures.
- [ ] Implement injectable provider-independent estimation, admission before Step creation, reservation before provider call, normalized settlement, actual-over-reservation truthfulness, and reconciled token projection.
- [ ] Run focused Core tests and commit.

### Task 9: Pricing resolver and cost budget enforcement

**Files:**

- Create: `packages/core/src/pricing.ts`, `packages/core/src/cost-budget-admission.ts`
- Modify: `packages/core/src/run-controller-ports.ts`, `packages/core/src/run-controller.ts`, `packages/storage/src/budget-ledger-repository.ts`, `packages/core/src/index.ts`
- Create/Modify: `packages/core/test/pricing.test.ts`, `packages/core/test/cost-budget-admission.test.ts`, `packages/storage/test/budget-ledger-repository.test.ts`

- [ ] Write failing fake-pricing tests for absent/present pricing, exact and one-micro over limits, rounding, zero rate, combined token/cost clamps, durable snapshot reuse after pricing changes, retry cost reservation, and missing pricing fail-closed with zero Provider calls.
- [ ] Observe failures.
- [ ] Implement injected static/versioned pricing snapshots, durable snapshot identity/rates, cost reservation/admission/settlement, and `AgentState.usage.cost` projection from micro-USD aggregation.
- [ ] Run focused tests and commit.

### Task 10: Provider retry integration with budget authority

**Files:**

- Modify: `packages/core/src/run-controller.ts`, `packages/core/src/retry-controller.ts`, `packages/core/src/run-retry-registry.ts`, `packages/core/src/run-controller-input.ts`
- Create/Modify: `packages/core/test/retry-controller.test.ts`, `packages/core/test/run-controller-retry.test.ts`, `packages/storage/test/run-controller-recovery.test.ts`

- [ ] Write failing tests for retry token/cost reservations, missing-usage conservative first attempt blocking second, low actual usage releasing capacity, wake recheck, no `retry.started`/Step/Provider call when budget blocks, cancellation/deadline/maxSteps priority, and Tool no-replay.
- [ ] Observe failures.
- [ ] Move budget admission before `retry.started`, new Step, and Provider call; re-read the latest ledger at wake and preserve 10C bounded retry behavior.
- [ ] Run Phase 10C regression and focused budget/retry tests, then commit.

### Task 11: Budget terminal finalizer and cleanup boundary

**Files:**

- Modify: `packages/core/src/run-controller.ts`, `packages/core/src/run-controller-input.ts`, `packages/core/src/run-execution-state.ts`, `packages/core/src/run-termination-authority.ts`, `packages/core/src/index.ts`
- Modify: `packages/protocol/src/events/run.ts`, `packages/protocol/src/events/index.ts`
- Create/Modify: `packages/core/test/run-controller-budget.test.ts`, `packages/core/test/run-termination-authority.test.ts`, `packages/storage/test/run-controller-boundaries.test.ts`

- [ ] Write failing tests for `BUDGET_EXCEEDED`, exactly-once `budget.exceeded` plus `status.changed`, no `run.failed`, continuation/approval/retry/deadline cleanup, process cleanup, finishedAt, terminal preservation, and all authority priority combinations.
- [ ] Write failing `BUDGET_EXCEEDED_PENDING` tests for unconfirmed cleanup and recovery-only retry.
- [ ] Observe failures.
- [ ] Implement the centralized finalizer, pending outcome, sanitized event payload, and shared terminal cleanup audit for MAX_STEPS where the current code is incomplete, without changing existing terminal status semantics.
- [ ] Run focused Core/Storage tests and commit.

### Task 12: Ledger recovery, crash E2Es, and projection reconciliation

**Files:**

- Modify: `packages/core/src/run-controller.ts`, `packages/storage/src/budget-ledger-repository.ts`, `packages/storage/src/storage.ts`
- Create/Modify: `packages/core/test/budget-crash-e2e.test.ts`, `packages/storage/test/recovery.test.ts`, `packages/storage/test/run-controller-restart.test.ts`

- [ ] Write failing E2Es for LLM crash conservative accounting, Tool crash no-double-count, pricing snapshot stability, budget-exceeded cleanup crash, no resumed Agent work, and retry no overspend.
- [ ] Observe failures.
- [ ] Implement startup reconciliation before retry/tool/approval/Step recovery and make all recovery paths idempotent.
- [ ] Run focused crash tests and commit.

### Task 13: Documentation and Phase 10 final seal

**Files:**

- Create: `docs/architecture/budget.md`, `docs/architecture/execution-governance.md`
- Modify: `docs/architecture/cancellation.md`, `docs/architecture/timeout.md`, `docs/architecture/retry.md`, `docs/architecture/agent-loop.md`, `docs/architecture/tool-system.md`, `docs/architecture/runtime.md`, `README.md`, `AGENTS.md`

- [ ] Write documentation tests/audit checks for forbidden Phase 11 leakage and forbidden live pricing/billing claims.
- [ ] Document dimensions, ledger lifecycle, Tool/token/cost accounting, conservative limitations, priority, cleanup, events, and the fact that estimated cost is not a billing guarantee.
- [ ] Mark Phase 10A/10B/10C/10D and Phase 10 completed, explicitly retain `VERIFYING`, and add the durable Phase 10 rules without claiming Verification or `COMPLETED`.
- [ ] Run architecture/scope audits and commit.

### Task 14: Full verification and delivery

**Files:**

- No source changes expected; inspect all changed files and generated artifacts.

- [ ] Run changed-file Prettier check and verify zero warnings for all Phase 10D files.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` serially and record focused/full counts.
- [ ] Safely remove only `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` using Node fs, then run frozen install and the full clean build gate.
- [ ] Run `pnpm format:check`, `pnpm check`, `git diff --check`, and compare warnings with the 607 baseline; report historic format debt honestly if `pnpm check` fails only there.
- [ ] Inspect `git status --short` and `git diff`; verify no unrelated files, secrets, Phase 11 implementation, or force operations.
- [ ] Commit coherent changes, push `codex/phase-10d-budget-enforcement-governance-finalization` without force, verify local SHA equals `git ls-remote` SHA, and only then output the required 95-item Phase 10D final report and stop.
