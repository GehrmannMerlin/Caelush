# Caelush V1.00 Context & Memory Engine Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unbounded intra-run model history with a durable-record/model-projection context runtime that supports bounded observations, safe compaction, authoritative rehydration, overflow recovery, progressive world state, safe observability, and scoped durable memory.

**Architecture:** Durable records remain complete and auditable in the existing Protocol/Storage planes. A new Context Control Plane indexes execution units, observations, checkpoints, world-state deltas, and memory retrieval; each provider turn receives a bounded Model Projection assembled from pinned goal, open protocol units, structured checkpoint, recent tail, relevant project context, bounded observations, and relevant memory. Core owns lifecycle authority and retry boundaries; Context owns projection and compaction orchestration; Storage owns migrations and repositories; UI consumes safe metadata only.

**Tech Stack:** TypeScript 6, Node.js 24, ESM, pnpm workspaces, Zod schemas, SQLite storage/migrations, Vitest, ESLint, Prettier, Vite/React, Playwright browser smoke tests.

**Spec:** User-provided `Caelush V1.00 — Context & Memory Engine Refactor` pasted task specification.

**BASE_SHA:** `1976ec06f4c06de56d28f92954e8dd789ba0b109`

## Global Constraints

- Fixed scope is Caelush V1.00 Tasks 1–12; do not add Task 6-1, Task 12-2, Task 13, Phase 14, MCP, RAG, Web Search, Skill, Sub-Agent, Browser Agent, or remote runtime.
- Durable History is not Model Context; compaction never deletes durable Conversation, Tool, Approval, Verification, Process, Resource, or Event records.
- Raw Tool Result is not Model Observation; raw results stay in existing durable storage or bounded artifacts, while model observations are deterministic, bounded, UTF-8 safe projections.
- Goal is reloaded from authoritative Run state on every context build and remains pinned; Checkpoints are summaries and never authority.
- Assistant Tool Calls and matching Tool Results form one atomic protocol group; open units, approval boundaries, active process boundaries, and incomplete pairs are never compacted.
- Context window comes from deterministic local ModelContextProfile resolution; no per-run network lookup and no universal hard-coded 32K assumption.
- Context pressure uses configurable floor/cap/elastic-pool policy, proactive/emergency thresholds, bounded recent-tail targets, and compaction hysteresis.
- Provider overflow recovery retries the same logical Agent turn at most once after force-compaction and rehydration; it never redispatches completed Tools.
- Context-internal LLM calls are cancellable, usage/cost-accounted with `CONTEXT_COMPACTION` or `MEMORY_EXTRACTION`, and do not count as Agent turns or ProgressLedger progress.
- Runtime/Storage/Core package dependencies remain directional; public APIs enter through package `src/index.ts`; provider SDK types and hidden reasoning never enter public contracts.
- Existing Security, Approval, Resource Governance, Verification, Recovery, Phase 13 Web, and Phase 8 runtime tests must remain valid; final verification uses the requested full order.
- Any new SQLite table requires a committed migration and migration coverage for existing runs, tool history, resource state, and sessions.
- New sub-agents, if independently requested by the execution workflow, must use `gpt-5.6-luna`; no new `gpt-5.6-sol` sub-agent may be created.

---

### Task 1: Context Runtime Baseline Characterization

**Files:**

- Create: `packages/core/test/context-runtime-characterization.test.ts`
- Create: `docs/superpowers/characterization/2026-09-03-context-runtime-baseline.md`
- Modify: `packages/context/test/context-budget.test.ts` only if a focused characterization fixture belongs with existing budget coverage

**Interfaces:**

- Consumes: current `prepareResumeHistory`, `ContextBuilder.build`, `assembleContextBudget`, `AgentErrorMapper` behavior.
- Produces: reproducible traces for current-turn growth, mandatory-token pressure, raw tool-result growth, protocol atomicity, and current limits; no production behavior change.

- [ ] Write failing characterization tests for 30+ continuation cycles, 16K overflow, 1MB tool output, and assistant/tool pair integrity.
- [ ] Run only the new characterization suite and confirm failures/symptoms are caused by the existing unbounded semantics rather than fixture errors.
- [ ] Record real symbols and file/function path in the baseline report, including the 32K/safety/conversation/relevant-file limits and `BUDGET_EXCEEDED` mapping.
- [ ] Keep Task 1 behavior-only; run the focused suite and commit the baseline evidence.

### Task 2: Model Context Profile and Context Policy

**Files:**

- Create: `packages/context/src/model-context-profile.ts`
- Create: `packages/context/src/context-policy.ts`
- Modify: `packages/context/src/context-builder.ts`, `packages/context/src/context-budget.ts`, `packages/context/src/context-build-report.ts`, `packages/context/src/index.ts`
- Modify: daemon provider configuration/composition files discovered during Task 1
- Test: `packages/context/test/model-context-profile.test.ts`, `packages/context/test/context-policy.test.ts`

**Interfaces:**

- Consumes: provider/model configuration and existing deterministic estimator.
- Produces: `ModelContextProfile`, `resolveModelContextProfile(input)`, `ContextPolicy`, and bounded effective-input/recent-tail/observation-cap calculations.

- [ ] Write red tests for 16K, 32K, and 128K profiles, source-priority resolution, explicit DeepSeek override/fallback provenance, thresholds, and bounded tail targets.
- [ ] Implement schemas and deterministic metadata resolution with explicit `profileSource`, safe fallback, positive safe-integer/overflow validation, and configurable ratios.
- [ ] Replace universal `maxInputTokens` admission with profile-derived policy while retaining compatibility for callers that provide explicit limits.
- [ ] Verify the focused suites and package typecheck before committing.

### Task 3: Durable History / Model Projection Separation and Execution Units

**Files:**

- Create: `packages/context/src/context-item.ts`
- Create: `packages/context/src/execution-unit.ts`
- Create: `packages/context/src/model-context-projection.ts`
- Modify: `packages/context/src/conversation-history.ts`, `packages/context/src/context-builder.ts`, `packages/core/src/agent-loop-history.ts`, `packages/core/src/run-controller-history.ts`
- Modify: Protocol/Storage contracts only where durable execution-unit/checkpoint references require JSON-safe entities
- Test: `packages/context/test/execution-unit.test.ts`, `packages/context/test/model-context-projection.test.ts`, `packages/core/test/agent-loop-history.test.ts`

**Interfaces:**

- Consumes: durable conversation/tool lifecycle records and `ModelContextProfile`/`ContextPolicy`.
- Produces: retention-aware `ContextItem`, `ExecutionUnit` OPEN/CLOSED model, safe-cut selection, and `ModelContextProjection`; compatibility helpers no longer model the entire run as one current turn.

- [ ] Write red tests proving 50 closed units do not inflate mandatory current context, open units remain complete, and call/result pairs are never split.
- [ ] Implement immutable JSON-safe entities and index/grouping logic with source ranges and atomic groups.
- [ ] Build bounded projection inputs from pinned goal, open unit, recent tail, and selected durable units without mutating durable history.
- [ ] Update AgentLoop continuation preparation to use execution-unit boundaries and validate protocol completeness.
- [ ] Run focused Core/Context tests and commit.

### Task 4: Tool Observation and Artifact Runtime

**Files:**

- Create: `packages/context/src/model-observation.ts`
- Create: `packages/context/src/artifact.ts`
- Create: `packages/context/src/observation-projector.ts`
- Modify: existing Tool execution/observation contracts and Storage repository only when reuse is proven necessary
- Test: `packages/context/test/observation-projector.test.ts`, `packages/tools/test/*observation*` or the nearest existing built-in test files

**Interfaces:**

- Consumes: existing durable ToolInvocation/ToolObservation results and built-in tool result shapes.
- Produces: `ModelObservation`, `ArtifactStore`/`ArtifactRetriever` ports, deterministic per-tool pruning with UTF-8-safe head/tail and omission markers.

- [ ] Write red tests for 1MB exec output and each built-in observation policy: read_file, list_directory, find_files, search_text, exec_command, write_stdin/process, git_diff.
- [ ] Implement bounded projection and artifact references without duplicating raw-result storage; classify sensitive artifacts as non-browsable.
- [ ] Preserve provider tool-call ID, role, order, and one-to-one protocol while replacing raw content with bounded observation content.
- [ ] Verify raw durability, model bounds, truncation metadata, and no secret/raw-argument leakage.

### Task 5: Intra-Run Compaction and Structured Checkpoints

**Files:**

- Create: `packages/context/src/context-pressure-controller.ts`
- Create: `packages/context/src/checkpoint.ts`
- Create: `packages/context/src/compaction.ts`
- Create or modify: Storage checkpoint/compaction repository and committed migration
- Modify: Core context preparation/admission integration and internal LLM usage accounting ports
- Test: `packages/context/test/compaction.test.ts`, `packages/context/test/checkpoint.test.ts`, migration tests

**Interfaces:**

- Consumes: policy/profile, execution units, observations, durable authority readers, optional compaction LLM port, and recent-tail selector.
- Produces: validated versioned `StructuredCheckpoint`, `ContextPressureController`, compaction records, deterministic degraded fallback, and safe compaction trace/events.

- [ ] Write red stress tests for 16K 50+ operations with at least two compactions, safe-cut rules, hysteresis, fallback after one failed retry, and constraint retention.
- [ ] Implement deterministic pruning → measure → safe cut → checkpoint → validation → persistence → authority rehydration → projection rebuild order.
- [ ] Persist checkpoint metadata and bounded fields with versioning; never persist fabricated plan/verification/approval authority.
- [ ] Account compaction calls separately from Agent turns/progress; honor cancellation and discard late compaction results.
- [ ] Run focused compaction/migration suites and commit.

### Task 6: Rehydration and Provider Overflow Recovery

**Files:**

- Create: `packages/context/src/context-rehydrator.ts`
- Create: `packages/context/src/context-overflow.ts`
- Modify: Core AgentLoop/provider-turn boundary and error taxonomy; daemon recovery composition
- Test: `packages/context/test/rehydration.test.ts`, `packages/core/test/context-overflow-recovery.test.ts`, restart/recovery tests

**Interfaces:**

- Consumes: Run, Workspace/Project Inspector, Security/Approval, Resource Governance, Verification, Runtime process state, Tool/file state, checkpoint store, and optional Memory provider.
- Produces: authoritative `rehydrateContext()` and a one-retry provider overflow recovery policy yielding `CONTEXT_EXHAUSTED` only after recovery fails.

- [ ] Write red tests for stale checkpoint authority, resolved approvals, active-process reload, daemon restart after compaction, exact-once overflow retry, and no redispatch.
- [ ] Implement authority precedence and bounded projection rebuilding from checkpoint plus durable execution tail.
- [ ] Add structured provider overflow classification at adapter boundary; avoid arbitrary string matching in Core.
- [ ] Implement one logical-turn retry with force compaction and cancellation-safe settlement; map unrecoverable pressure to explicit `CONTEXT_EXHAUSTED`.
- [ ] Run the P0 Long-run Gate scenarios A–H. Stop and report `CONTEXT RUNTIME ARCHITECTURE UNSTABLE` after three repeated architecture-corrective cycles.

### Task 7: World State and Progressive Project Context

**Files:**

- Create: `packages/context/src/world-state.ts`
- Create: `packages/context/src/world-state-delta.ts`
- Modify: `packages/context/src/project-inspector.ts`, `packages/context/src/snapshot.ts`, `packages/context/src/relevant-file-planner.ts`
- Test: `packages/context/test/world-state.test.ts`, `packages/context/test/world-state-large-monorepo.test.ts`

**Interfaces:**

- Consumes: existing ProjectIntelligenceSnapshot, ProjectInspector, RelevantFilePlanner, workspace revisions, file mutations, and process transitions.
- Produces: bounded full snapshot plus incremental delta `WorldStateProjection`; generated-tree ignore policy and progressive context guidance.

- [ ] Write red tests for first snapshot, revision delta, ignored generated trees, and thousands of fake paths.
- [ ] Implement incremental state projection without a second repository scanner or hardcoded tool-order behavior.
- [ ] Verify current Project Intelligence remains the source of project facts and authority overrides memory.

### Task 8: Context Observability and Inspector

**Files:**

- Create: `packages/context/src/context-build-trace.ts`
- Create or modify: safe context-inspector DTO/port
- Modify: `packages/cli`, `packages/client`, `apps/web` developer-only context modal/drawer integration
- Test: package trace/security tests, CLI command tests, Web inspector tests

**Interfaces:**

- Consumes: projection/compaction reports and safe counters.
- Produces: bounded `ContextBuildTrace`, `/context` CLI output, and default-hidden two-column Web developer inspector.

- [ ] Write red tests for all safe metadata fields and explicit absence of system body, raw args/output, secrets, and hidden reasoning.
- [ ] Implement trace collection with stable counts, pressure ratio, checkpoint/compaction identifiers, and dropped/truncated summaries.
- [ ] Add CLI/Web presentation without a permanent third column or product-facing token meter.
- [ ] Run focused client/Web tests and browser smoke coverage.

### Task 9: Project / Global Memory Foundation

**Files:**

- Create: `packages/memory/package.json`, `packages/memory/src/index.ts`, `packages/memory/src/contracts.ts`, `packages/memory/src/sensitivity.ts`, `packages/memory/src/store.ts`, `packages/memory/src/extractor.ts`
- Create: Storage memory repository and committed migration
- Modify: workspace package configuration and daemon composition
- Test: `packages/memory/test/contracts.test.ts`, `packages/memory/test/sensitivity.test.ts`, migration tests

**Interfaces:**

- Consumes: verified completion records, evidence references, project identity, and post-completion asynchronous extraction port.
- Produces: scoped versioned `MemoryRecord`/`MemoryCandidate` with statuses, evidence, sensitivity classification, and forget APIs.

- [ ] Write red tests for Project/Global scopes, evidence requirement, secret rejection, conservative global extraction, status transitions, and deletion.
- [ ] Implement deterministic candidate validation and durable storage; extraction never blocks or changes a completed Run.
- [ ] Verify no temporary state, credentials, environment values, or raw tool output enters memory.

### Task 10: Memory Retrieval, Consolidation, Lifecycle, and Prompt Cache Hardening

**Files:**

- Create: `packages/memory/src/retriever.ts`, `packages/memory/src/consolidator.ts`, `packages/memory/src/lifecycle.ts`
- Modify: `packages/context/src/model-context-projection.ts`, `packages/context/src/context-renderer.ts`, daemon/provider composition
- Test: `packages/memory/test/retrieval.test.ts`, `packages/memory/test/consolidation.test.ts`, `packages/context/test/prompt-cache-structure.test.ts`

**Interfaces:**

- Consumes: deterministic scope/topic/keyword/recency/confidence/evidence-freshness retrieval inputs and authoritative World State.
- Produces: relevant memory ContextItems competing only for elastic pool, supersession/consolidation, and stable-prefix prompt ordering.

- [ ] Write red tests for Run A→Run B retrieval, pnpm→bun supersession, authority override, zero irrelevant memory, cap behavior, and forget/lifecycle transitions.
- [ ] Implement deterministic retrieval and conflict handling without embeddings, vector DB, RAG, or full-memory prompt injection.
- [ ] Order prompt sections as stable/semi-stable/dynamic while keeping Checkpoint IDs and meters out of the stable prefix.
- [ ] Verify memory extraction remains post-completion and separately accounted.

### Task 11: Long-running Real Integration, Browser E2E, Recovery, and Security Regression

**Files:**

- Create/modify: deterministic fixture workspaces, daemon/SQLite integration fixtures, Web browser smoke tests, focused long-run tests
- Modify: release asset inclusion if new Protocol/Storage/Context/Memory packages require it
- Test: focused Context/Compaction/Memory suites plus existing `pnpm test:web:e2e` and security/recovery suites

**Interfaces:**

- Consumes: Tasks 1–10 public APIs through daemon composition.
- Produces: evidence for 50+ scan, 100+ scaffold, tiny window, constraints, pair integrity, large output, overflow, restart, approval, cancellation, governance, verification, and memory scenarios.

- [ ] Write deterministic integration tests before implementation-specific fixture changes.
- [ ] Implement only missing composition wiring and fixture behavior, preserving Verification Completion Authority and existing UI layout.
- [ ] Run lint, typecheck, focused suites, full Vitest, build, browser E2E, and security regressions in the specified order.
- [ ] Run optional DeepSeek smoke only if credentials already exist; report SKIP when absent, never call paid models in CI.

### Task 12: Whole-branch Verification, Release, and Git Delivery Seal

**Files:**

- Create: `docs/superpowers/reports/2026-09-03-v1-context-memory-engine-refactor.md`
- Modify: only verified defects, release scripts/assets, and documentation needed by the implementation

**Interfaces:**

- Consumes: complete task branch, all test evidence, current Git remotes, and independent Luna review.
- Produces: completion report, branch/release/remote seals, fast-forward master integration, and clean final local state.

- [ ] Run `git diff --check`, changed-file Prettier, lint, typecheck, focused Context/Compaction/Memory suites, full test, build, Web E2E, release build/E2E, and production Web smoke.
- [ ] Perform independent read-only whole-branch review with `gpt-5.6-luna`; repair findings through no more than three cycles and stop on repeated architecture instability.
- [ ] Record Task reviewers, models, roles, verdicts, root cause, architecture, profiles, execution units, observations, compaction, rehydration, overflow, world state, inspector, memory, security, usage, and exact-once evidence.
- [ ] Commit verified changes, push `codex/v1-context-memory-engine-refactor`, verify local/remote task SHA equality, fast-forward `master`, push master, verify both remote seals, delete the local task branch with `git branch -d`, and confirm only `master`, the main worktree, and a clean status remain.
