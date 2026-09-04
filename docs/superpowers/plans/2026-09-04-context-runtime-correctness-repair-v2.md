# Context Runtime Correctness Repair V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the real Caelush daemon context path so model capacity, budget arithmetic, observation pressure, compaction, overflow recovery, and restart telemetry remain correct under production-like tool workloads.

**Architecture:** Keep `ContextRuntimeCoordinator` as the only production context authority. Use the existing ContextBuilder, token estimator, ExecutionUnit, checkpoint, observation, storage, and Web boundaries, extending them only where the current contracts cannot carry an authoritative value. Every recovery stage rebuilds from durable/raw inputs and the current policy; it never executes a Tool.

**Tech Stack:** TypeScript/ESM, pnpm workspace, Vitest, SQLite migrations, React Web components, Playwright release/browser smoke tests.

**Spec:** `docs/superpowers/specs/2026-09-04-context-runtime-correctness-repair-v2-design.md`

## Global Constraints

- Phase 8 and Phase 11 boundaries remain unchanged; no new Phase or sub-round is added.
- No worktree is created; work continues in `D:\Develop\Caelush`.
- `master` is never merged, checked out, pushed, or deleted by this task.
- Production runtime must not query the network for model metadata.
- `ContextRuntimeCoordinator` is the only production context authority.
- Tool execution remains behind the Dispatcher; context recovery never redispatches a Tool.
- Durable records contain only bounded safe diagnostics, never prompts, tool arguments/output, memory content, credentials, or hidden reasoning.
- Every production behavior change follows RED → minimal GREEN → focused regression.

### Task 1: Real Production Characterization

**Files:**

- Create: `docs/superpowers/characterization/2026-09-04-context-runtime-correctness-v2-baseline.md`
- Create: `packages/core/test/context-runtime-correctness-v2-characterization.test.ts`
- Read-only evidence: `packages/context/src/*`, `packages/core/src/*`, `packages/llm/src/*`, `packages/storage/src/*`, `apps/daemon/src/*`, `apps/web/src/*`

**Interfaces:** The test uses `ContextRuntimeCoordinator`, real `ContextBuilder`, real `ContextPolicy`, real `Utf8HeuristicTokenEstimator`, and real Tool Result projection. It records the current call graph and candidate verdicts without altering production behavior.

- [ ] Write a real small-profile current-turn regression with a System fixture, user goal, assistant Tool Call, and two Tool Results; assert the current baseline failure/error semantics.
- [ ] Run `pnpm vitest run packages/core/test/context-runtime-correctness-v2-characterization.test.ts` and record the exact failure, estimate, profile source, and policy limits.
- [ ] Add characterization probes for model-profile precedence, 16,000/2,048/512 arithmetic, single/2/5 observation caps, 0.80 pressure, closed-history versus oversized-open-turn compaction, provider overflow, and durable restart state.
- [ ] Record Candidate A–I as `CONFIRMED`, `PARTIALLY_FIXED`, or `NOT_CONFIRMED` with file/line evidence; do not claim old defects that current master already repaired.

### Task 2: Model Profile and Context Arithmetic

**Files:**

- Modify: `packages/context/src/model-context-profile.ts`, `packages/context/src/context-policy.ts`, `packages/context/src/context-builder.ts`
- Modify: `apps/daemon/src/providers/model-canonicalizer.ts`, `apps/daemon/src/config.ts`, `apps/daemon/src/daemon-composition.ts`
- Test: `packages/context/test/model-context-profile.test.ts`, `packages/context/test/context-policy.test.ts`, `packages/context/test/context-builder.test.ts`, `apps/daemon/test/daemon-composition.test.ts`, `apps/daemon/test/config.test.ts`

**Interfaces:** Preserve `ModelContextProfile`, `ContextPolicy`, and legacy `ContextBuildLimits`; expose the resolved profile source and effective input limit through the coordinator result and usage projection. Profile inputs remain local data-only configuration.

- [ ] Add RED tests for explicit profile, known metadata, legacy limits, fallback, multi-model configuration, zero reserves, non-zero reserves, and strict invalid environment JSON.
- [ ] Make precedence and validation deterministic; reject unsafe arithmetic overflow and unknown profile fields at startup.
- [ ] Ensure the policy path passes the effective limit to the budget exactly once while the legacy direct Builder path keeps its existing safety semantics.
- [ ] Inject each provider's configured profiles into the daemon coordinator and assert composition resolves the configured provider/model instead of silently using fallback.
- [ ] Run focused profile/policy/builder/daemon tests and commit `feat(context): wire model context profiles into daemon runtime` plus `fix(context): correct effective input budget semantics`.

### Task 3: Policy-Aware Observation and Open-Turn Shrinking

**Files:**

- Modify: `packages/context/src/observation-projector.ts`, `packages/context/src/context-policy.ts`, `packages/context/src/context-runtime-coordinator.ts`
- Modify: `packages/core/src/agent-tool-batch.ts`, `packages/core/src/agent-tool-results.ts`, `packages/core/src/run-controller.ts`
- Test: `packages/context/test/observation-projector.test.ts`, `packages/core/test/agent-tool-batch.test.ts`, `packages/core/test/context-runtime-correctness-v2-characterization.test.ts`

**Interfaces:** Keep model-facing `LLMToolResultMessage[]` bounded and ordered. Add a data-only raw observation/projection input or durable artifact reference where needed; do not pass Runtime, Storage, Dispatcher, or mutable services into Context.

- [ ] Add RED tests proving a 2K single cap with five results cannot consume 10K, and that source-order allocation is independent of completion order.
- [ ] Define centralized `NORMAL`, `TIGHT`, `EMERGENCY`, and `MINIMAL` allocations with a single-result cap, whole-batch cap, and minimum protocol floor.
- [ ] Regenerate tighter observations from durable raw content/artifact data, preserve every Tool Call ↔ Result pair, and retain required identity/status/reference markers.
- [ ] Integrate the policy from the active coordinator into initial and resumed Tool continuation paths; remove any production authority that is a fixed 8,192-token limit.
- [ ] Run focused observation/core tests and commit `feat(context): budget tool observations per model context` and `feat(context): shrink open tool observations under pressure`.

### Task 4: ExecutionUnit Compaction and Checkpoint Correctness

**Files:**

- Modify: `packages/context/src/execution-unit.ts`, `packages/context/src/compaction.ts`, `packages/context/src/context-rehydrator.ts`, `packages/context/src/checkpoint.ts`, `packages/context/src/context-runtime-coordinator.ts`
- Modify: `packages/context/src/context-persistence.ts`, `packages/storage/src/context-checkpoint-repository.ts`, `packages/storage/src/schema.ts`
- Test: `packages/context/test/execution-unit.test.ts`, `packages/context/test/compaction.test.ts`, `packages/context/test/rehydration.test.ts`, `packages/storage/test/context-checkpoint-repository.test.ts`

**Interfaces:** Introduce only a migration-safe typed execution cursor if existing message history cannot carry durable sequence authority. Checkpoint creation returns measured `tokensBefore` and `tokensAfter`; checkpoint structured facts are derived from injected authoritative snapshots and never override fresher authority.

- [ ] Add RED tests for OPEN versus CLOSED units, safe boundary cuts, recent-tail preservation, current-turn non-deletion, real pre-compaction estimates, and no duplicate compaction for the same source cursor.
- [ ] Build units from durable conversation entries/cursors, select only older CLOSED units, and preserve the recent closed tail plus the complete OPEN unit.
- [ ] Build a bounded checkpoint from goal, workspace/effects, verification, approvals, processes, resource governance, latest errors, and changed/read files supplied by authority ports.
- [ ] Rebuild provisionally from the new checkpoint, measure the actual rebuilt model context, then persist the checkpoint with non-placeholder before/after values before provider admission.
- [ ] Run focused context/storage tests and commit `feat(context): compact closed execution units in production` and `fix(context): make checkpoint token telemetry authoritative`.

### Task 5: Adaptive Context Pressure State Machine

**Files:**

- Modify: `packages/context/src/compaction.ts`, `packages/context/src/context-runtime-coordinator.ts`, `packages/context/src/errors.ts`, `packages/context/src/context-build-report.ts`
- Test: `packages/context/test/compaction.test.ts`, `packages/context/test/context-runtime-coordinator.test.ts`, `packages/core/test/agent-loop-failures.test.ts`

**Interfaces:** Keep context pressure internal (`NORMAL`, `PROACTIVE`, `EMERGENCY`, `RECOVERING_OVERFLOW`, `EXHAUSTED`); map only final unrecoverable exhaustion to public `CONTEXT_EXHAUSTED`.

- [ ] Add RED tests for proactive 75% behavior, post-compaction target/hysteresis, system-only overflow, minimal-open-protocol overflow, and ordinary pressure not escaping as runtime `BUDGET_EXCEEDED`.
- [ ] Implement deterministic breakdown-aware recovery order: optional Memory/files, older CLOSED units, then open observation detail when current-turn pressure dominates.
- [ ] Make context state recheck after each rebuild and stop when a target ratio is met; never clear history as the default strategy.
- [ ] Preserve cancellation/approval/verification/resource-governance boundaries while context recovery is in progress.
- [ ] Run focused context/core tests and commit `feat(context): add adaptive context pressure recovery`.

### Task 6: Provider Context Overflow Recovery

**Files:**

- Modify: `packages/llm/src/providers/openai-compatible/errors.ts`, `packages/llm/src/errors.ts`, `packages/core/src/agent-loop.ts`, `packages/context/src/context-overflow.ts`
- Test: `packages/llm/test/openai-compatible-errors.test.ts`, `packages/core/test/context-runtime-integration-contract.test.ts`, `packages/core/test/agent-loop-integration.test.ts`

**Interfaces:** Provider adapters emit the existing provider-independent `LLMContextOverflowError`; AgentLoop invokes the context runtime recovery boundary with a fresh request and at most one retry. Tool handlers remain outside the recovery path.

- [ ] Add RED tests for structured overflow versus ordinary HTTP 400, one retry, second overflow to `CONTEXT_EXHAUSTED`, request identity inequality, and exact-once Tool invocation.
- [ ] Normalize only verified overflow codes/types in the adapter; do not classify every HTTP 400 as context overflow.
- [ ] On the first overflow, force emergency context recovery, rehydrate authoritative state, rebuild the LLM request, and retry once without reusing the prior request.
- [ ] Count provider attempts separately from Agent turns and map the final error without leaking provider payloads.
- [ ] Run focused LLM/core tests and commit `feat(llm): recover provider context overflow with rebuilt requests`.

### Task 7: Durable Context Telemetry and Ring Correctness

**Files:**

- Modify: `packages/context/src/context-usage-projection.ts`, `packages/context/src/context-build-trace.ts`, `packages/storage/src/context-runtime-state-repository.ts`, `packages/storage/src/schema.ts`
- Modify: `packages/protocol/src/api/context-usage.ts`, `apps/daemon/src/daemon-composition.ts`, `apps/web/src/components/context-usage-ring.ts`, `apps/web/src/components/context-inspector.ts`
- Test: `packages/storage/test/context-runtime-state-repository.test.ts`, `apps/daemon/test/daemon-composition.test.ts`, `apps/web/test/context-usage-ring.test.tsx`, `apps/web/test/session-persistence.test.ts`

**Interfaces:** Extend the existing runtime-state projection with safe raw/effective identity, last build/recovery data, and numeric breakdown fields. The ring computes `estimated/effective` from persisted authoritative usage and renders neutral state when no run is active.

- [ ] Add RED tests for successful build, failed/exhausted build, compaction before/after values, durable restart recovery, ratio above effective limit for diagnostics, and no content persistence.
- [ ] Add one committed migration only if schema fields are missing; keep `context_runtime_states` as the sole source of truth.
- [ ] Persist usage before provider admission and read it on daemon restart without a 32K fallback or fabricated zero state.
- [ ] Show provider, model, profile source, raw window, effective input, estimated used, remaining, pressure, compaction count, and safe numeric breakdown in the existing inspector.
- [ ] Run focused storage/daemon/Web tests and commit `feat(storage): persist accurate context runtime state` and `fix(web): restore authoritative context usage diagnostics`.

### Task 8: Production Integration Verification

**Files:**

- Create/modify: `apps/daemon/test/context-runtime-production-e2e.test.ts`, `packages/core/test/context-runtime-production-integration.test.ts`, `apps/web/test/context-usage-ring.test.tsx`
- Modify: `docs/superpowers/characterization/2026-09-04-context-runtime-correctness-v2-baseline.md`

**Interfaces:** Use real daemon composition, SQLite storage, RunController, AgentLoop, Context Runtime, Dispatcher, and deterministic in-process provider fixtures. Keep provider/tool side effects deterministic and local.

- [ ] Add scenarios A–P required by the approved task text: workspace scan, current-turn pressure, closed-history pressure, mixed pressure, proactive/hysteresis, five-tool batch, 1MB raw result, provider overflow, exact-once, restart, failed context, approval, cancellation, verification, and resource governance.
- [ ] Run targeted suites in the required order; record exact file/test/pass/skip totals rather than synthesized examples.
- [ ] Run `git diff --check`, changed-file Prettier, lint, typecheck, focused suites, full test/build, browser E2E, release build/test, and `pnpm check`; report pre-existing format debt without formatting unrelated files.
- [ ] Commit `test(context): seal production context correctness` and `docs(context): record context correctness repair v2`.

### Task 9: Independent Review and Remote Task Seal

**Files:**

- Create: `docs/superpowers/reports/2026-09-04-context-runtime-correctness-repair-v2.md`

**Interfaces:** A read-only independent reviewer must use `gpt-5.6-luna`; no new `gpt-5.6-sol` sub-agent may be started. The report contains the exact Agent ID/Model/Role/Task/Verdict audit.

- [ ] Dispatch the independent read-only Luna reviewer with the A–W checklist and retry at most twice only for service-level unavailability; never fabricate PASS.
- [ ] Resolve only evidence-backed review findings, rerun affected tests, and obtain explicit `APPROVED`/`PASS`/`CLEAN` before calling the reviewer gate passed.
- [ ] Run `git status --short`, `git diff --check`, `git rev-parse HEAD`, `git rev-parse master`, and `git rev-parse origin/master`; commit all required changes.
- [ ] Push only `codex/v1-context-runtime-correctness-repair-v2`, verify local task SHA equals remote task SHA, and leave `master` untouched.
- [ ] Fill the pre-manual-acceptance report with root-cause matrix, arithmetic, observations, ExecutionUnits, pressure, compaction evidence, overflow, checkpoint, ring, error semantics, regressions, tests, reviewer, deferred manual acceptance, and Git seal.

## Verification commands

```text
git diff --check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:web:e2e
pnpm build:release
pnpm test:release
pnpm check
```

The final report must state any command that was not run or failed, with its actual output and
whether the failure is pre-existing format debt or introduced by this branch.
