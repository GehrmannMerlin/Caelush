# Caelush V1.00 Context & Memory Production Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接线上一轮 Context/Memory foundation，使真实 AgentLoop、RunController、Daemon、Storage、Client、CLI 和 Web 使用同一条 bounded context production path，并把结果交到用户人工长任务验收之前。

**Architecture:** Core/Context 通过注入的 coordinator、checkpoint、artifact 和 memory ports 组成 production orchestration；Storage 只实现 durable adapters，Daemon 负责 composition root，Client/CLI/Web 只消费 safe context usage projection。Model context 使用 profile/policy 的 effective input limit，Tool raw settlement 与 ModelObservation 分离，Context Usage Ring 只表达当前 active working context 的 used ratio。

**Tech Stack:** TypeScript 6, Node.js 24, pnpm workspace, Vitest, Drizzle SQLite, Fastify/SSE, React, Ink, Playwright。

**Spec:** `C:/Users/韩吉衍/.codex/attachments/34a8c772-7702-4809-8681-3cd0cba510df/pasted-text.txt`

## Global Constraints

- 继续使用 `codex/v1-context-memory-engine-refactor`，不创建 worktree，不重置或覆盖上一轮 dirty foundation。
- 本轮只做 Task 1–8；不新增 Task 8-1、Task 9、MCP、RAG 或 Phase 14。
- 不执行真实 50+/100+ Tool、长时间 DeepSeek 或完整全栈人工验收；最终状态是 `READY FOR MANUAL LONG-TASK ACCEPTANCE`。
- 不创建 `ContextRuntimeV2`、`ContextItem2`、`CheckpointV2` 或 `MemoryManager2`；只接线已有 public foundation。
- 新启动的 sub-agent 必须使用 `gpt-5.6-luna`；本轮不依赖 sub-agent 时必须记录实际情况且 New `gpt-5.6-sol` Sub-Agent Count 为 0。
- Context Usage 使用 `estimatedInputTokens / effectiveInputLimitTokens`，不使用累计 session tokens、resource budget 或 long-term memory size。
- Core 不依赖 SQLite、Fastify、React；Daemon 是 runtime composition root；公开 DTO 保持 JSON-safe。
- ToolDispatcher 仍是唯一 Tool execution authority；Context Runtime 不执行 Tool。
- 变更遵循 TDD：每个行为先写 failing test、确认失败，再写最小实现；结束前运行完整验证和 `git status --short`/`git diff --check`。

---

### Task 1: Audit and Production Integration Contract

**Files:**

- Read: `docs/superpowers/plans/2026-09-03-v1-context-memory-engine-refactor.md`, `docs/superpowers/characterization/2026-09-03-context-runtime-baseline.md`, `docs/superpowers/reports/2026-09-03-v1-context-memory-engine-refactor.md`
- Modify: `packages/core/src/agent-loop-ports.ts`, `packages/core/src/agent-loop-input.ts`, `packages/core/src/run-controller-ports.ts`
- Create: `packages/context/src/context-runtime-coordinator.ts`
- Test: `packages/core/test/context-runtime-integration-contract.test.ts`

**Interfaces:**

- Consumes: `ContextBuilder`, `ModelContextProfile`, `ContextPolicy`, `ExecutionUnit`, `ModelObservation`, `StructuredCheckpoint`, `ContextRehydrator`, `MemoryRetriever`。
- Produces: `ContextRuntimeCoordinator.prepareModelContext(input)`, `recordContextBuild(input)`, `compactIfNeeded(input)`, `recoverOverflow(input, operation)`, `rehydrate(input)` and `loadCheckpoint(input)` ports without Core→Storage concrete imports。

- [ ] **Step 1: Write a failing contract test** asserting AgentLoop dependencies accept a context runtime port and the production request path calls `prepareModelContext` before the LLM client.
- [ ] **Step 2: Run the focused contract test** and confirm it fails because AgentLoop only calls `contextBuilder.build` directly.
- [ ] **Step 3: Implement the narrow coordinator port and AgentLoop adapter** so legacy tests can use a builder adapter while production composition can inject the coordinator.
- [ ] **Step 4: Run Core/context focused tests** and confirm old direct-builder tests remain compatible while coordinator invocation is observable through safe metadata only.
- [ ] **Step 5: Commit** with `feat(context): freeze production integration contract`.

### Task 2: Production Context Runtime Orchestration

**Files:**

- Modify: `packages/core/src/agent-loop.ts`, `packages/core/src/run-controller.ts`, `packages/core/src/run-controller-history.ts`
- Modify: `apps/daemon/src/daemon-composition.ts`
- Create: `packages/context/src/context-runtime-coordinator.ts` implementation helpers if the port requires split files
- Test: `packages/core/test/context-runtime-production.test.ts`, `packages/storage/test/run-controller-context-integration.test.ts`

**Interfaces:**

- Consumes: run authority, durable conversation, `ContextCheckpointRepository`, `ArtifactRepository`, `MemoryRetriever`, project inspector/planner, profile/policy resolver and `ContextBuilder`.
- Produces: canonical pre-provider sequence `authority → profile → checkpoint → execution units → observations → rehydration → memory → projection → pressure/prune → compaction → checkpoint persist → rehydrate → trace → LLM`.

- [ ] **Step 1: Add failing tests** for new Run without checkpoint, tool continuation with recent CLOSED units plus OPEN unit, small-window pressure and cancellation during preparation.
- [ ] **Step 2: Run those tests** and capture failures proving production still builds context directly and has no checkpoint/memory orchestration seam.
- [ ] **Step 3: Implement coordinator orchestration** with injected ports, `AbortSignal` propagation, no Tool execution, no synthetic durable-history append, and a cancellation check immediately before returning the provider request.
- [ ] **Step 4: Wire RunController/AgentLoop/Daemon** so all provider requests use the coordinator and no production path bypasses it.
- [ ] **Step 5: Add resource-purpose metadata** for compaction and memory-extraction LLM calls without charging them as AgentTurn or ToolOperation.
- [ ] **Step 6: Run focused production integration tests** and commit `feat(context): integrate context runtime with agent execution`.

### Task 3: Durable Checkpoint, Artifact and Recovery Adapters

**Files:**

- Modify: `packages/storage/src/schema.ts`, `packages/storage/src/storage.ts`, `packages/storage/src/index.ts`
- Create: `packages/storage/src/context-checkpoint-repository.ts`, `packages/storage/src/context-artifact-repository.ts`
- Modify: `packages/context/src/checkpoint.ts`, `packages/context/src/observation-projector.ts`
- Test: `packages/storage/test/context-checkpoint-repository.test.ts`, `packages/storage/test/context-artifact-repository.test.ts`, `packages/storage/test/context-recovery-integration.test.ts`

**Interfaces:**

- Produces `ContextCheckpointRepository.create/getLatestByRun/getById/listByRun` with runId, checkpointId, schemaVersion, previous id, source range, structured checkpoint, token counts, model ref and createdAt.
- Produces `ContextArtifactRepository.createOrGet/getMetadata/readInternal/readSafeProjection`, with stable artifact identity and no Web access to `readInternal`.

- [ ] **Step 1: Write failing persistence/reopen/CAS tests** for checkpoint source-range idempotency, artifact metadata/reference storage, crash-before-commit fallback and legacy nonterminal Run without checkpoint.
- [ ] **Step 2: Run the tests** and confirm the repository methods and durable recovery behavior are absent.
- [ ] **Step 3: Implement repositories** using existing SQLite/codec patterns, keeping raw database rows private and avoiding raw 1 MB content in checkpoint JSON.
- [ ] **Step 4: Integrate latest-checkpoint loading into coordinator recovery** and verify daemon restart rebuilds from durable checkpoint plus post-checkpoint records rather than in-memory execution-unit cache.
- [ ] **Step 5: Run migration regression and storage focused tests** and commit `feat(storage): persist context checkpoints and artifacts`.

### Task 4: Tool Settlement to Model Observation Pipeline

**Files:**

- Modify: `packages/tools/src/*` only at existing settlement adapter seam, `packages/context/src/observation-projector.ts`, `packages/core/src/agent-tool-batch.ts`
- Modify: `packages/storage/src/tool-execution-store.ts` only where raw settled output is exposed through an existing port
- Test: `packages/storage/test/tool-observation-integration.test.ts`, `tests/integration/tool-observation-large-output.test.ts`

**Interfaces:**

- Consumes: settled Tool invocation/observation and existing terminal sanitizer/security boundaries.
- Produces: durable raw result or metadata reference, bounded `ModelObservation`, original `toolCallId`, and ordered `LLMToolResultMessage` without exposing args/credentials/raw output.

- [ ] **Step 1: Write failing 256 KB/1 MB integration tests** proving raw durable settlement, bounded model projection, preserved call identity, and no raw output in model history/UI timeline.
- [ ] **Step 2: Run tests** and confirm the current `toLLMToolResultMessages` path still exposes raw Tool content.
- [ ] **Step 3: Implement the narrow settlement projection** after ToolDispatcher settlement and before continuation persistence, reusing existing sanitization and never changing Tool execution authority.
- [ ] **Step 4: Add artifact reference rehydration for bounded slices** and verify OPEN approval does not create a success observation before settlement.
- [ ] **Step 5: Run focused tool/storage tests** and commit `feat(context): project settled tools into bounded observations`.

### Task 5: Durable Project Memory Pipeline

**Files:**

- Create: `packages/memory/src/extraction-job.ts`, `packages/storage/src/memory-extraction-job-repository.ts`
- Modify: `packages/memory/src/index.ts`, `packages/storage/src/storage.ts`, `apps/daemon/src/daemon-composition.ts`
- Create: `apps/daemon/src/memory/memory-extraction-worker.ts`
- Modify: `packages/core/src/run-controller.ts` only at verified-completion notification seam
- Test: `packages/memory/test/extraction-job.test.ts`, `packages/storage/test/memory-extraction-job-repository.test.ts`, `apps/daemon/test/memory-worker.test.ts`

**Interfaces:**

- Produces durable idempotent `MemoryExtractionJob` with sourceRunId, PROJECT scope, status PENDING/RUNNING/COMPLETED/FAILED, attempt and timestamps; completion notification never blocks Verified Final Result.
- Consumes safe final result, checkpoint, authoritative project facts and evidence references; rejects secret candidates and respects WorldState over stale Memory.

- [ ] **Step 1: Write failing tests** for post-COMPLETED enqueue, idempotent sourceRunId, nonblocking terminal result, startup recovery, project scoping, evidence requirement and deterministic secret rejection.
- [ ] **Step 2: Run tests** and confirm no durable extraction job/worker exists.
- [ ] **Step 3: Implement SQLite job adapter and bounded-concurrency worker** with one active extraction job by default and no fire-and-forget loss.
- [ ] **Step 4: Wire verified completion to enqueue after terminal commit** and retrieval to new Run context projection; keep FAILED/CANCELLED/TIMEOUT/BUDGET_EXCEEDED ineligible by default.
- [ ] **Step 5: Add minimal canonical list/forget/supersede/invalidate service API** without creating a large Memory Center UI.
- [ ] **Step 6: Run memory/storage/daemon tests** and commit `feat(memory): integrate durable project memory pipeline`.

### Task 6: Context Observability, CLI `/context`, Client State and Web Ring

**Files:**

- Create: `packages/context/src/context-usage-projection.ts`
- Modify: `packages/context/src/index.ts`, `packages/events/src/*` only at existing event contract seam, `apps/daemon/src/routes/*`, `packages/client/src/client.ts`, `packages/client/src/index.ts`
- Modify: `apps/cli/src/application/cli-controller.ts`, `apps/cli/src/components/*`
- Create: `apps/web/src/components/context-usage-ring.tsx`, `apps/web/src/components/context-inspector.tsx`
- Modify: `apps/web/src/application/session-manager.ts`, `apps/web/src/components/prompt-composer.ts`, `apps/web/src/components/session-workspace.ts`, `apps/web/src/styles.css`
- Test: `packages/context/test/context-usage-projection.test.ts`, `packages/client/test/context-usage.test.ts`, `apps/web/test/context-usage-ring.test.tsx`, `apps/cli/test/context-command.test.ts`

**Interfaces:**

- Produces safe `ContextUsageProjection` with runId/provider/model, context/effective limits, estimated input, usedRatio, remaining, pressure, compaction count/time and breakdown.
- `ContextUsageRing` is a 28×30 hit area containing a roughly 14×14, 2 px SVG ring; React only renders the projection, while SSE/replay or one canonical `getRunContextUsage` state source supplies data.

- [ ] **Step 1: Write failing projection/UI tests** for ratios 0/.25/.5/.75/1, no-data neutral track, used-vs-remaining semantics, tooltip, aria-label, reduced motion, compaction drop and reload restoration.
- [ ] **Step 2: Run tests** and confirm client/daemon/UI have no Context Usage state or ring.
- [ ] **Step 3: Implement projection and safe event/API delivery** without timeline entries for silent usage updates; emit one compact activity for actual compaction only.
- [ ] **Step 4: Implement `/context` using existing CLI architecture** showing Model, capacity, Used, Remaining, percentage, pressure, last compaction, count and breakdown without prompts/raw output/memory detail/secrets.
- [ ] **Step 5: Implement the approved SVG ring and lightweight inspector** in composer footer before send/cancel controls, preserving narrow-screen size, keyboard focus and Escape close behavior.
- [ ] **Step 6: Run focused client/CLI/Web tests** and commit `feat(client): expose safe context usage state`, `feat(web): add context usage ring and inspector`, and `feat(cli): expose context diagnostics`.

### Task 7: Bounded Production Integration and Browser E2E

**Files:**

- Create: `tests/integration/context-production-integration.test.ts`
- Modify: `scripts/web-session-browser-smoke.mjs` and existing Web smoke helpers only as needed for real context usage assertions
- Test: `tests/integration/context-production-integration.test.ts`, `apps/web/test/context-usage-ring.e2e.test.ts`

**Interfaces:**

- Uses real daemon composition, real SQLite, real AgentLoop, real Context Runtime, real ToolDispatcher, deterministic provider and small synthetic 4K/8K windows; no fake React state or fake SSE payload.

- [ ] **Step 1: Write failing bounded scenarios A–H** covering pressure/compaction/completion, huge output, provider overflow retry once, restart recovery, approval reload/resolve, verified memory retrieval, secret rejection and ring ratio drop.
- [ ] **Step 2: Run the scenarios** and record each missing production seam without running long-task or real paid-model acceptance.
- [ ] **Step 3: Implement only targeted fixes required by the scenarios**, preserving Approval/Security/Verification authority and existing Phase 13E two-column UX.
- [ ] **Step 4: Run focused integration, browser, restart/recovery and release tests**; assert real ring state changes before/after compaction.
- [ ] **Step 5: Commit `test(context): seal production context integration` and `docs(context): record pre-acceptance integration results`.

### Task 8: Independent Review, Release and Manual Acceptance Handoff

**Files:**

- Modify: `docs/superpowers/reports/2026-09-03-v1-context-memory-production-integration.md`
- Test/inspect: full branch diff, `pnpm check`, release artifacts, remote branch state

**Interfaces:**

- Reviewer input is `FOUNDATION_COMMIT_SHA..TASK_HEAD_SHA`; output must include actual reviewer ID/model/role/verdict, with New `gpt-5.6-sol` Sub-Agent Count = 0 if no Sol agent was launched.
- Delivery output includes local task SHA, remote task SHA, clean working tree, unchanged master, and a `## Manual Acceptance Ready` section with commands discovered from package scripts/launcher.

- [ ] **Step 1: Run independent Luna whole-branch review** against the 15 specified checks; perform at most three corrective cycles and stop/report `ARCHITECTURE UNSTABLE` if the same architecture finding repeats.
- [ ] **Step 2: Run required verification commands**: `pnpm lint`, `pnpm typecheck`, focused context/storage/memory/ring tests, `pnpm test`, `pnpm build`, `pnpm test:web:e2e`, `pnpm build:release`, `pnpm test:release`, changed-file Prettier, and `git diff --check`.
- [ ] **Step 3: Update the pre-acceptance report** with PASS/FAIL per AgentLoop/RunController/Daemon/Checkpoint/Artifact/Memory/Client/CLI/Web, ring formula/evidence, checkpoint/artifact/memory/approval details, review table and deferred manual gate.
- [ ] **Step 4: Commit the report, push `codex/v1-context-memory-engine-refactor`, verify local SHA equals remote SHA, and keep master unchanged; do not merge or delete the task branch.**
- [ ] **Step 5: Hand off as `READY FOR MANUAL LONG-TASK ACCEPTANCE`** with discovered Production Web startup command and explicit instruction that the user—not Codex—performs the real DeepSeek/50+/100+ Tool/full-stack/multi-compaction acceptance next round.
