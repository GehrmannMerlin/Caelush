# Caelush Phase 7C / Phase 7 Final Completion Plan

- Date: 2026-08-29
- Actual baseline: `origin/codex/phase-7b-tool-dispatcher-durable-lifecycle`
- Phase 7B SHA: `55242e0115fec1ecf6534cfad9d110e5c06ed6ef`
- Task branch: `codex/phase-7c-tool-batch-agent-integration`
- Worktree: `D:\\Develop\\Caelush\\.worktrees\\phase-7c-tool-batch-agent-integration`
- Phase boundary: Phase 7 contains exactly 7A, 7B, and 7C. No Phase 7D or later-phase runtime features.

## Actual Git baseline and verification

1. Fetch `origin --prune`, verify remote `https://github.com/GehrmannMerlin/Caelush.git`, confirm 7B is not on `origin/master`, and use the 7B remote branch as `BASE_REF`.
2. Establish the baseline with `pnpm install --frozen-lockfile`, lint, typecheck, test, build, format check, and `pnpm check`. Record the actual test/build/format results and historical formatting debt.
3. Preserve the clean 7B worktree and do all implementation in this dedicated worktree. Do not add a migration, batch table, production tool, retry, timeout, cancellation, verification runner, approval entity, or parallel executor.

## Current Phase 7B contracts to reuse

4. Reuse `ToolDispatcher.dispatch()` as normal live-process dispatch, `ToolDispatcher.recover()` for durable invocation recovery, `ToolDispatcherOutcome`, `ToolExecutionStorePort`, durable `ToolInvocation`/`ToolObservation`, lifecycle events, registry validation, gate, output policy, and committed event notification.
5. Reuse Core's `AgentToolCallsDecision`, `WaitingToolResultsContinuation`, `RunExecutionStorePort`, Conversation ledger, `normalizeToolResultBatch()`, `AgentLoop.run()`, and `AgentLoop.resumeWithToolResults()`. AgentLoop remains unaware of Dispatcher, persistence, and ToolInvocation/Observation.
6. Record Codex selective-parallelism research in implementation docs: mature runtimes gate parallel execution by explicit tool safety metadata and read/write/exclusive locks; Caelush has no such metadata, so Phase 7C is deterministic sequential source-order execution.

## Batch source of truth and contracts

7. Add provider-independent `ToolBatchItem`, `ToolBatchRequest`, `ToolBatchItemResult`, `ToolBatchOutcome`, typed `ToolBatchInputError`, and `ToolBatchInfrastructureError` under `@caelush/tools`. Validate session/run/step IDs, non-empty items, ToolName, JsonObject args, and reject duplicate `externalCallId` across the entire batch before any Dispatcher call.
8. Keep batch definition in `RunContinuation.pendingDecision.toolRequests`; use `ToolInvocation` and `ToolObservation` as per-call progress. Do not create a ToolBatch table, batch event, batch sequence, new continuation type, or migration.
9. Add the narrow `ToolDispatcher.modelDefinitions()` delegation to the active immutable registry and add explicit `recoverOrDispatch()`. Preserve normal duplicate-`RUNNING` behavior as Busy; recovery of existing RUNNING remains fail-closed and reports an explicit durable uncertainty marker in `AgentError.details`.
10. Add a pure `isUncertainToolExecution()` helper based on the machine-readable marker. Do not inspect content strings, raw arguments, stack traces, or secrets.

## Sequential coordinator and recovery safety

11. Implement `ToolBatchCoordinator` as a Tools-layer boundary that only calls Dispatcher. `execute()` dispatches items strictly in source order; known unavailable tools, gate denials, ordinary Tool errors, and handler `isError=true` become model-recoverable item results and do not stop later items.
12. Stop immediately at `WAITING_APPROVAL`; return only completed earlier results and a waiting pointer. Do not create or execute trailing calls. Partial results remain only in durable Tool observations, are not submitted, appended to Conversation, or written as `receivedResults`.
13. Implement `recover()` in source order. Reuse completed observations; recover existing invocations through `recoverOrDispatch()`; when an uncertain recovered RUNNING invocation appears, never re-execute it and convert all later unstarted items to deterministic `SKIPPED_AFTER_UNCERTAIN_EXECUTION` results without Invocation/Observation/events/handlers. Infrastructure failures abort immediately rather than fabricating a completed batch.
14. Add focused tests for contracts, preflight zero-side-effects, source order, maximum concurrent handlers = 1, ordinary errors/unknown tools, approval stop, uncertain marker, trailing skip, recovery idempotency, and infrastructure-failure mapping.

## Core bridge and catalog consistency

15. Add Core-only `toLLMToolResultMessages()` conversion. Validate each result against the corresponding request in source order with `LLMToolResultMessageSchema.parse()`; expose only externalCallId/toolName/content/isError, never Observation.details, Invocation.args, or AgentError.details. Keep `normalizeToolResultBatch()` active as settlement defense-in-depth.
16. Remove `RunExecutionConfig.tools`. Add `toolCoordinator` to RunController dependencies; obtain model tools only through `toolCoordinator.modelDefinitions()`, omitting the LLM `tools` field when the catalog is empty. Add catalog drift tests proving model and Dispatcher use the same registry snapshot.
17. Add WAITING_APPROVAL continuation pointer and state/run helpers while retaining `WAITING_TOOL_RESULTS` and omitting `receivedResults`. Extend execution invariants: synchronized Run/State status, no current Step, pointer present, no approval entity/resolution. Reuse canonical state transitions.

## RunController integration

18. Refactor public `start()`, `recover()`, and `submitToolResults()` into `withLock()` plus private locked operations. Add a bounded while-loop `driveToolBoundariesLocked()`; never invoke a public locked method recursively.
19. On normal AgentLoop Tool Calls, build a ToolBatchRequest from the source decision, execute one complete batch, persist approval boundary or submit exactly one complete normalized result batch via the locked equivalent, then resume AgentLoop. On an infrastructure failure, clear continuation, retain already durable Tool history, fail Run with generic TOOL/RUNTIME error, and make zero provider calls after the fatal boundary.
20. Upgrade recovery: if complete `receivedResults` is already durable, skip all Tool coordinator calls and resume the provider directly; otherwise recover the pending batch, apply uncertain/approval semantics, and continue only after a complete result batch is durably accepted.
21. Add result/status tests for one Tool turn, multiple Tool turns, unknown/ordinary errors, maxSteps, accepted-results restart, all-tools-before-submit restart, WAITING_APPROVAL restart, mid-batch crash recovery, trailing skip, duplicate batch input, and infrastructure failure.

## End-to-end, architecture, docs, and gates

22. Add at least two file-backed SQLite E2E paths using the real storage/EventBus/Core/AgentLoop/Dispatcher/Coordinator composition: Tool calls→ordered results→final VERIFYING; and mid-batch crash→uncertain recovery→trailing skip→model-facing complete error batch→final.
23. Prove conversation order (user, assistant tool-call message, tool result messages in source order, final assistant), durable Invocation/Observation counts, aggregate event sequence, no run.completed, and no hidden handler retry.
24. Update architecture tests and package declarations: `core → tools` allowed; `tools → core/llm/storage/events/runtime/security/context/verification/apps` forbidden; AgentLoop has no Dispatcher dependency; no new migrations/tables; no Promise.all tool execution.
25. Update `docs/architecture/tool-system.md`, `agent-loop.md`, `run-controller.md`, `AGENTS.md`, and `README.md` to describe the same-registry catalog, sequential source order, durable source of truth, approval boundary, uncertainty barrier, and Phase 7 completion without claiming Filesystem/Shell/Process/Git/Approval UI features.
26. Run focused tests and the fresh full gates: clean generated outputs via Node fs only where required, `pnpm install --frozen-lockfile`, lint, typecheck, test, build, changed-file formatting, full format check, `pnpm check`, `git diff --check`, migration diff gate, static audits, clean status. Push the dedicated branch and verify local/remote SHA equality; do not merge master or create a PR.

## Commit checkpoints

- `docs: plan Phase 7C tool batch integration`
- `feat(tools): add deterministic tool batch coordination`
- `feat(core): integrate durable tool batches with RunController`
- `test: cover Phase 7C recovery and Agent E2E`
- `docs: complete Phase 7 tool system`

Commits may be combined reasonably, but avoid one giant commit and keep every checkpoint buildable where practical.
