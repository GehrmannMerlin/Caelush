# Caelush Phase 6C — RunController, Durable Persistence & Event Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Phase 6B in-memory resumable AgentLoop into a local-host durable runtime with a RunController, conversation ledger, continuation checkpoints, atomic SQLite execution commits, replayable lifecycle events, and safe restart recovery.

**Architecture:** Keep AgentLoop provider-independent and storage-independent. Add narrow persistence and lifecycle contracts to Core, implement them in Storage with one `BEGIN IMMEDIATE` transaction, and let RunController orchestrate boundaries through those ports. Durable state is authoritative; EventBus notification happens only after commit, and recovery never re-sends a provider turn whose durable `llm.started` checkpoint exists.

**Tech Stack:** TypeScript ESM monorepo, pnpm workspaces, Zod 4.4.3 schemas, `node:sqlite`, Drizzle migrations, Vitest, existing `@caelush/core`, `@caelush/context`, `@caelush/llm`, `@caelush/events`, `@caelush/protocol`, and `@caelush/storage` packages.

**Spec:** `C:\Users\韩吉衍\.codex\attachments\42ec3875-6bf4-423c-9922-5d6699797adc\pasted-text.txt`

## Global Constraints

- Phase 6C is the final Phase 6 round; do not create Phase 6D or another Phase 6 sub-phase.
- Phase 6C must not execute Tools, create ToolInvocation records, execute Verification, transition to COMPLETED, add Retry, add run-level cancellation, add budget/timeout orchestration, or expose new daemon execution endpoints.
- Core must not depend on `@caelush/storage`; Storage may implement the narrow Core persistence port.
- Conversation persistence accepts only real `user`, `assistant`, and `tool` messages; synthetic system/project/relevant-file context is never durable.
- Every provider turn has a durable RUNNING Step and `llm.started` event before the provider call; pre-provider checkpoint failure means zero provider calls.
- Run, AgentState, AgentStep, conversation, continuation, and durable lifecycle events settle atomically; use `BEGIN IMMEDIATE`, commit, then notify subscribers.
- Durable event sequence is the canonical chronology; timestamps are metadata only. Existing `DurableEventStore.append()` behavior remains compatible.
- Recovery is local-host durable recovery, not distributed exactly-once execution; stale in-flight provider Steps fail closed and are never automatically re-sent.
- No new external packages. Use the repository's exact pinned Zod version if Core needs a direct dependency.
- Use injected `AgentClock` and `EventIdFactory`; RunController must not call `Date.now()`, `randomUUID()`, network APIs, child processes, tools, or verification.
- Every behavior change follows RED → GREEN → REFACTOR, with a focused failing test observed before implementation.
- Preserve unrelated user changes; do not use `git reset --hard`, `git clean`, force push, or broad Prettier writes.

---

### Task 1: Instrument the AgentLoop provider lifecycle

**Files:**
- Modify: `packages/core/src/agent-loop-ports.ts`
- Modify: `packages/core/src/agent-loop-input.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-loop-lifecycle.test.ts`

**Interfaces:**
- Add `AgentProviderTurnState = "NOT_STARTED" | "FAILED" | "COMPLETED"`.
- Add `AgentBeforeProviderTurn` containing only `run`, active-step `state`, `step`, and `model`.
- Add optional `lifecycle?: AgentLoopLifecycleHooks` to `AgentLoopDependencies`, with `beforeProviderTurn(input): Promise<void>`.
- Add `providerTurnState` to both `AgentLoopOutcomeResult` and `AgentLoopFailureResult`.

- [ ] Write a test proving the hook runs after context/request preparation and before `llmClient.complete`, receives a RUNNING active Step, and a rejected hook causes zero provider calls with `NOT_STARTED`.
- [ ] Run `pnpm vitest run packages/core/test/agent-loop-lifecycle.test.ts`; observe failure because the lifecycle contract does not exist.
- [ ] Implement the narrow hook and metadata. Mark context/maxSteps/preparation failures `NOT_STARTED`, provider exceptions `FAILED`, and all provider-returned results—including classification rejection—`COMPLETED`.
- [ ] Run the focused test and the existing `packages/core/test` suite; refactor only after green.

### Task 2: Add durable continuation contracts and runtime schemas in Core

**Files:**
- Create: `packages/core/src/agent-continuation.ts`
- Create: `packages/core/src/agent-continuation-schema.ts`
- Modify: `packages/core/src/agent-decision.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json` only if the existing pinned Zod package must be declared directly
- Test: `packages/core/test/agent-continuation.test.ts`

**Interfaces:**
- Define `RunContinuationCheckpoint` as `WaitingToolResultsContinuation | AwaitingVerificationContinuation`.
- `WaitingToolResultsContinuation` contains `type`, `runId`, `sourceStepId`, `pendingDecision`, and optional `receivedResults`.
- `AwaitingVerificationContinuation` contains `type`, `runId`, `sourceStepId`, and `finalDecision`.
- Export schemas that validate IDs, model turn metadata, assistant messages, tool requests, candidate text, and accepted tool results without provider SDK types.

- [ ] Write schema tests for both variants, received results, malformed decisions, mismatched run IDs, and rejection of unknown/synthetic continuation shapes.
- [ ] Run the focused test and observe the missing contract/schema failure.
- [ ] Implement Zod schemas by composing public `@caelush/llm` and `@caelush/protocol` schemas; do not serialize raw provider payloads or hidden reasoning.
- [ ] Run focused Core tests, typecheck Core, and refactor only after green.

### Task 3: Add the Conversation Ledger schema and repository

**Files:**
- Create: `packages/storage/drizzle/<next-migration>_<name>/migration.sql`
- Create/update: `packages/storage/drizzle/<next-migration>_<name>/snapshot.json`
- Modify: `packages/storage/src/schema.ts`
- Create: `packages/storage/src/repositories/conversation-repository.ts`
- Modify: `packages/storage/src/storage.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/conversation-repository.test.ts`
- Test: `packages/storage/test/migrations.test.ts`

**Interfaces:**
- Define `RunConversationEntry { runId; sequence; sourceStepId?; createdAt; message: LLMMessage }`.
- Define `ConversationRepository.listByRun(runId): Promise<RunConversationEntry[]>` and an append API used by the execution adapter, with batch sequence allocation inside a caller-owned transaction helper.
- Add `messages` to `CaelushStorage` while keeping the public API free of database row/Drizzle types.

- [ ] Write tests for contiguous per-run sequences, deterministic sequence ordering despite equal/out-of-order timestamps, source Step IDs, batch append, only `user`/`assistant`/`tool` roles, and fail-closed malformed/system rows.
- [ ] Run the focused tests and observe missing table/repository failures.
- [ ] Add the formal next migration without editing the committed Phase 2 migration; add `(run_id, sequence)` unique/index constraints and runtime `LLMMessageSchema` decoding through `decodeProtocol`.
- [ ] Implement read and transaction-compatible write helpers, then run migration compatibility against an old Phase 6B database and all storage tests.

### Task 4: Add the Continuation repository

**Files:**
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/storage.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/src/repositories/continuation-repository.ts`
- Modify: `packages/storage/src/codec.ts` only for shared typed codec helpers if needed
- Test: `packages/storage/test/continuation-repository.test.ts`

**Interfaces:**
- Define `ContinuationRepository.get(runId): Promise<{ checkpoint: RunContinuationCheckpoint; revision: number } | null>`.
- Define transaction-compatible set/clear operations with `expectedRevision: number | null`; every successful update increments revision.
- Use the Core continuation schema for decode validation and reject corrupted `runId`, `sourceStepId`, decision, assistant message, tool request, or received result data.

- [ ] Write tests for both checkpoint variants, revision increments, initial null revision, clear, semantic decode validation, and stale revision rejection.
- [ ] Run the focused tests and observe missing repository/table behavior.
- [ ] Add `agent_run_continuations` with `run_id` primary key, `kind`, `source_step_id`, `revision`, `updated_at_ms`, and `data_json`; implement validated read/write helpers.
- [ ] Run focused and all storage tests; refactor only after green.

### Task 5: Define the atomic Core execution persistence port

**Files:**
- Create: `packages/core/src/run-execution-store.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/run-execution-store-contract.test.ts`

**Interfaces:**
- Define `RunExecutionSnapshot` with `run`, optional `state`, `stateRevision`, `activeStep?`, ordered `conversation`, optional `continuation`, and optional `continuationRevision`.
- Define `RunExecutionCommit` with the expected state/continuation revisions, projected Run/State/Step writes, conversation appends, continuation set/clear, and ordered durable event drafts.
- Define `RunExecutionStorePort.load(runId)` and `commit(command)` returning committed snapshot plus durable events, without importing Storage.
- Define explicit `RunExecutionConflictError` and `RunExecutionInvariantError` contracts.

- [ ] Write contract-level tests with an in-memory fake proving the port can represent PENDING without State, active provider checkpoints, tool boundaries, verification boundaries, and terminal projections.
- [ ] Run the focused test and observe absent exports/contracts.
- [ ] Implement immutable interfaces and result types only; keep all actual transaction logic in Storage.
- [ ] Run Core typecheck and focused tests.

### Task 6: Implement SQLite atomic execution commits with CAS and rollback

**Files:**
- Create: `packages/storage/src/run-execution-store.ts`
- Modify: `packages/storage/src/storage.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/repositories/run-repository.ts`
- Modify: `packages/storage/src/repositories/step-repository.ts`
- Modify: `packages/storage/src/repositories/run-state-repository.ts`
- Modify: `packages/storage/src/events/sqlite-durable-event-store.ts`
- Modify: `packages/storage/src/schema.ts` only for indexes/relations required by execution rows
- Test: `packages/storage/test/run-execution-store.test.ts`
- Test: `packages/storage/test/run-execution-rollback.test.ts`
- Test: `packages/storage/test/run-execution-cas.test.ts`

**Interfaces:**
- `SqliteRunExecutionStore` implements the Core `RunExecutionStorePort` and is exposed as `storage.execution`.
- Refactor existing repository/event writes into transaction-compatible internal helpers; public repository methods retain their existing transaction behavior.

- [ ] Write tests that construct a legal commit containing Run, State, Step, messages, continuation, and two events, then force duplicate second-event ID and assert zero partial writes.
- [ ] Write CAS tests for state revision and continuation revision, including two writers based on the same snapshot and rollback of all rows on conflict.
- [ ] Run the focused tests and observe missing atomic transaction/CAS behavior.
- [ ] Implement one `BEGIN IMMEDIATE`/`COMMIT` boundary with `ROLLBACK` on any failure, contiguous run-local event sequencing, expected-revision checks, invariant validation before and after writes, and no nested repository transactions.
- [ ] Run all Storage/Event tests plus typecheck; preserve `DurableEventStore.append()` compatibility.

### Task 7: Add committed-event notification without re-persistence

**Files:**
- Modify: `packages/events/src/event-bus.ts`
- Modify: `packages/events/src/index.ts`
- Test: `packages/events/test/event-bus-committed.test.ts`
- Test: `packages/events/test/replay-live-race.test.ts`

**Interfaces:**
- Add `EventBus.notifyCommitted(events: readonly DurableAgentEvent[]): void` (or equivalent batch API) that only notifies subscribers and never calls `DurableEventStore.append()`.
- Keep `publish()` behavior compatible for standalone events: persist durable event, then notify; ephemeral events never receive an SSE/durable sequence.

- [ ] Write tests proving committed events notify exactly once, the durable store still has one row, subscriber exceptions do not fail execution, and missed notification is recoverable through replay/watch.
- [ ] Run focused Events tests and observe the absent method/duplicate persistence failure.
- [ ] Implement notification-only delivery and preserve replay/live exclusive cursor behavior.
- [ ] Run all Events tests and refactor only after green.

### Task 8: Add Run/State projection and invariant helpers

**Files:**
- Create: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/agent-state.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/run-execution-state.test.ts`

**Interfaces:**
- Add `markAgentStateFailed(state, error, now)` and `markAgentRunFailed(run, now)` helpers using the canonical state machine.
- Add pure `assertRunExecutionInvariant(snapshot)` enforcing synchronized Run/State status, synchronized `currentStepId`, active RUNNING Step, no active Step on terminal runs, required continuations for WAITING/VERIFYING boundaries, and no continuation for PENDING/FAILED/MAX_STEPS.
- Add projection helpers for RUNNING, VERIFYING, FAILED, and MAX_STEPS_REACHED with `finishedAt`/`finalResult` rules.

- [ ] Write tests for all legal boundary projections and all specified invariant violations, including `VERIFYING` with unset `finalResult` and stale active Step mismatch.
- [ ] Run focused tests and observe absent helper behavior.
- [ ] Implement pure schema-validated helpers and sanitized failure errors; do not add COMPLETED execution.
- [ ] Run Core tests and typecheck.

### Task 9: Implement RunController start and pre-provider checkpoint

**Files:**
- Create: `packages/core/src/run-controller-ports.ts`
- Create: `packages/core/src/run-controller-input.ts`
- Create: `packages/core/src/run-controller-events.ts`
- Create: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/run-controller-start.test.ts`

**Interfaces:**
- `RunExecutionConfigResolver.resolve(run)` returns `baseSystemPrompt`, `contextLimits`, optional `tools`, `modelSettings`, `cwd`, and `explicitPaths`; it never returns credentials.
- `RunEventNotifier.notifyCommitted(events)` receives already-committed events.
- `RunController` constructor accepts `AgentLoop`, `RunExecutionStorePort`, `RunEventNotifier`, `RunExecutionConfigResolver`, `AgentClock`, and `EventIdFactory`.
- Export `start(runId)`, `submitToolResults(runId, results)`, and `recover(runId)` returning a discriminated `RunControllerResult` with PENDING, WAITING_TOOL_RESULTS, AWAITING_VERIFICATION, FAILED, MAX_STEPS_REACHED, TERMINAL, and internal RUNNING representations as needed.
- Add same-process active-run locking and `RunControllerBusyError`, input errors, and infrastructure errors.

- [ ] Write tests for PENDING → RUNNING start, one `run.started`, ordered `status.changed`, injected event IDs/clock, start idempotency, and concurrent calls rejected.
- [ ] Write the provider spy test that reads Storage at the first line of `complete()` and sees Run/State current Step, durable RUNNING Step, and `llm.started` already committed.
- [ ] Run focused tests and observe missing Controller behavior.
- [ ] Implement start projection, config resolution, AgentLoop lifecycle hook wiring, atomic start/pre-provider commit, event factory, and post-commit notification. If pre-provider commit fails, make zero provider calls.
- [ ] Run focused Core tests and existing suites.

### Task 10: Persist the Tool boundary

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Test: `packages/core/test/run-controller-tool-boundary.test.ts`

**Interfaces:**
- A tool outcome commit completes the Step, settles State while keeping Run `RUNNING`, clears both current Step IDs, appends `messagesToAppend` (`user` with no source Step and assistant with current Step), stores `WAITING_TOOL_RESULTS` with no received results, and writes `llm.completed` then `reasoning.summary`.
- Do not create ToolInvocation or emit `tool.requested`.

- [ ] Write tests for durable Step COMPLETED, ordered ledger rows, source Step IDs, continuation contents, exact public reasoning summary without tool args, and no `run.completed`.
- [ ] Run focused test and observe missing settlement behavior.
- [ ] Implement the atomic tool-boundary commit and notify only after commit.
- [ ] Run focused and regression suites.

### Task 11: Implement durable Tool Result acceptance and resume

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Test: `packages/core/test/run-controller-tool-results.test.ts`
- Test: `packages/core/test/run-controller-tool-results-failure.test.ts`

**Interfaces:**
- `submitToolResults()` loads the RUNNING Run/State and WAITING continuation, calls existing `normalizeToolResultBatch()`, and first commits `receivedResults` with continuation CAS.
- Semantic equality compares structured objects with sorted record keys, not JSON key order; an equal resubmission is idempotent, a different batch throws `RunControllerConflictError`.
- Invalid batches fail the Run atomically with sanitized `TOOL_OUTPUT_ERROR`, no Context/LLM calls, no premature conversation append, and events `error`, `status.changed`, `run.failed`.

- [ ] Write tests for normalization order, durable acceptance before provider invocation, idempotent equivalent batches, conflicting batches, invalid caller inputs, and failure event ordering/secret redaction.
- [ ] Run focused tests and observe missing acceptance/resume behavior.
- [ ] Implement acceptance commit, resumed AgentLoop call using the durable conversation and pending decision, and correct failure ownership.
- [ ] Run focused Core tests and all existing tests.

### Task 12: Persist final candidates at VERIFYING

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Test: `packages/core/test/run-controller-final-boundary.test.ts`

**Interfaces:**
- A final outcome atomically completes the Step, moves Run and State to `VERIFYING`, clears current Step IDs, appends tool result/assistant messages with source Step IDs, stores `AWAITING_VERIFICATION`, and emits `llm.completed`, `reasoning.summary`, then `status.changed`.
- `RunControllerResult` exposes exact `candidateText`, source Step ID, Run, and State; `AgentRun.finalResult` remains undefined.
- Never emit `run.completed`.

- [ ] Write tests for candidate checkpoint fields, conversation ledger order, final event payload safety, no candidate in summary/error, no COMPLETED transition, and zero LLM calls from VERIFYING recovery.
- [ ] Run focused test and observe missing final persistence behavior.
- [ ] Implement the final-boundary commit and result mapping.
- [ ] Run focused and regression suites.

### Task 13: Own failure and maxSteps lifecycle

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Test: `packages/core/test/run-controller-failure.test.ts`
- Test: `packages/core/test/run-controller-max-steps.test.ts`

**Interfaces:**
- Context failure creates no Step and emits `error`, `status.changed`, `run.failed` without LLM events.
- Provider failure creates a FAILED Step, increments State usage steps, sets sanitized State error/Run failure, and emits no `llm.completed`.
- Model-output rejection treats the provider as `COMPLETED` for LLM event purposes, then fails the Step/Run with error.
- MaxSteps creates no Step/provider call, persists normalized Tool Results when resuming, clears continuation, and transitions Run/State to `MAX_STEPS_REACHED` without `run.failed`.

- [ ] Write tests for context, provider, model-rejection, and maxSteps cases, including `finishedAt`, synchronized statuses/current Step IDs, continuation absence, event order, and secret audits.
- [ ] Run focused tests and observe absent terminal lifecycle behavior.
- [ ] Implement sanitized error mapping and atomic terminal commits; do not add retries or COMPLETED.
- [ ] Run Core/Storage/Events regression suites.

### Task 14: Implement safe recovery and stale active-Step handling

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Test: `packages/core/test/run-controller-recovery.test.ts`

**Interfaces:**
- `recover(PENDING)` returns ready/PENDING without auto-start.
- `recover(RUNNING + WAITING_TOOL_RESULTS)` returns tool requests and performs zero LLM calls; with durable results it may resume exactly once at the explicit boundary.
- `recover(VERIFYING + AWAITING_VERIFICATION)` returns candidate with zero LLM calls.
- `recover(RUNNING + no active Step + no continuation + empty conversation)` is a safe pre-provider resume point; non-empty unknown combinations throw `RunControllerInvariantError`.
- A stale RUNNING Step with durable `llm.started` fails closed: Step FAILED, usage incremented, Run/State FAILED, active IDs cleared, continuation absent, and sanitized `error`/`status.changed`/`run.failed`; never call Provider.

- [ ] Write tests for each recovery boundary, mismatched active IDs/missing Step, stale Step fail-closed behavior, safe pre-provider recovery, terminal no-op recovery, and no duplicate provider calls.
- [ ] Run focused recovery tests and observe missing recovery behavior.
- [ ] Implement load/invariant validation, stale-step settlement, and explicit-boundary result mapping.
- [ ] Run focused and all Core/Storage tests.

### Task 15: Add file-backed multi-process-style restart E2E and audit tests

**Files:**
- Create: `packages/core/test/run-controller-restart-e2e.test.ts`
- Create: `packages/core/test/run-controller-atomic-e2e.test.ts`
- Modify: `packages/storage/test/recovery.test.ts` if shared fixture coverage is needed
- Modify: `tests/architecture/package-boundaries.test.ts`
- Create/modify: `packages/core/test/architecture.test.ts`
- Create/modify: `packages/storage/test/architecture.test.ts`

**Interfaces:**
- Exercise real `openCaelushStorage`, `EventBus`, ProjectInspector, RelevantFilePlanner, ContextBuilder, injected LLM client/provider boundary, AgentLoop, and RunController against a temp SQLite file and temp project.

- [ ] Write the three-controller restart scenario: start to tool boundary, close; reopen/recover with zero calls; submit result and reach VERIFYING; close/reopen/recover exact candidate with still two total calls.
- [ ] Write assertions for conversation sequence/roles/source Steps, Step history, state revisions, continuation revisions, contiguous event replay, no `run.completed`, no Tool execution, and secret absence from errors/events/summaries.
- [ ] Write crash-before-provider and crash-mid-provider cases plus atomic rollback integration.
- [ ] Run focused E2E/architecture tests and observe failures before implementation gaps are addressed.
- [ ] Implement only fixture/adaptor corrections needed by the already-built runtime; run all focused tests, typecheck, build, and verify no `@caelush/storage` import from Core or AI SDK/network/child-process leakage.

### Task 16: Update architecture docs, AGENTS, README, and finish verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/agent-loop.md`
- Create: `docs/architecture/durable-agent-runtime.md` if a focused architecture document keeps the existing docs readable
- Modify: `docs/superpowers/plans/2026-08-29-caelush-phase-6c-run-controller-persistence.md`

- [ ] Write documentation tests or textual assertions for Phase 6 completion wording, no Phase 6D, database-first notification, sequence-over-timestamp chronology, synthetic-context boundary, continuation variants, durable tool-result acceptance, crash-mid-provider fail-closed behavior, and local-host scope.
- [ ] Run the docs/architecture tests and observe stale Phase 6B wording.
- [ ] Update docs without claiming Tool, Filesystem/Shell/Git, Permission/Security, Retry, Cancellation, Verification, CLI production host, or Web production host.
- [ ] Run changed-file Prettier checks only; record the original full-format baseline of 331 failures and ensure no new changed-file failures.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`, and `git diff --check`; report full-format/check failures only if they remain exactly historical.
- [ ] Safely remove generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` using explicit Node filesystem operations (never `git clean`), reinstall frozen dependencies, and rerun the complete verification commands.
- [ ] Inspect `git status --short` and `git diff`; create focused commits, push the actual Phase 6C branch without force, compare local and remote SHAs, and stop without merging master or creating a PR.

## Completion Checklist

- [ ] Phase 6B-containing base and dedicated `codex/phase-6c-run-controller-persistence` branch are recorded.
- [ ] Conversation ledger, continuation checkpoints, atomic Store, CAS, rollback, committed-event notification, RunController start/tool/final/failure/maxSteps/recovery, and file-backed restart E2E are implemented and tested.
- [ ] No Tool execution, Verification execution, Retry, run cancellation, budget/timeout orchestration, daemon execution endpoint, provider SDK leakage, secret leakage, or hidden CoT event exists.
- [ ] All focused tests and full verification have fresh command evidence; format debt is reported against baseline.
- [ ] Branch is pushed, local SHA equals remote SHA, and working tree is clean.

