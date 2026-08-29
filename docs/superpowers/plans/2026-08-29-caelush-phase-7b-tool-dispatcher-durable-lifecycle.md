# Caelush Phase 7B — Tool Dispatcher & Durable Invocation Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Every behavior change follows `superpowers:test-driven-development`: write one failing test, run it, implement the smallest change, run it green, then refactor.

**Goal:** Build a single-tool dispatcher that validates a registered invocation, durably checkpoints every lifecycle boundary in SQLite, executes a handler only after `RUNNING`/`tool.started` commit, atomically settles an observation and terminal event, and fails closed during explicit recovery.

**Architecture:** The `@caelush/tools` package owns JSON-safe dispatcher contracts, lifecycle pure functions, gate and storage ports, event factories, validation, idempotency, active-call protection, and the dispatcher itself. It depends only on `@caelush/protocol` and the existing Ajv runtime. `@caelush/storage` implements the tools storage port with a new migration, read repositories, and one `BEGIN IMMEDIATE` transaction that writes invocation/observation/event rows; it reuses the existing run aggregate event-sequencing helper. The dispatcher never imports Core, Storage, Events, Runtime, Security, LLM, Context, Verification, or Daemon.

**Tech Stack:** TypeScript ESM, Node 24 `node:sqlite`, Drizzle schema metadata/migrations, Zod protocol schemas, existing Ajv schema runtime, Vitest, pnpm workspace.

**Spec:** User-provided Phase 7B specification, captured in the task prompt. The authoritative base is `origin/codex/phase-7a-tool-registry-schema-runtime` at `1c1027fb6cc050de18ab7928a0810dfa192f2a5e`, because that commit is not an ancestor of `origin/master` (`ea7efabd5b96dbce3103d80bfafa9ef949ff2241`).

## Global Constraints

- Phase 7 contains exactly 7A, 7B, and 7C; do not create another Phase 7 round.
- Phase 7B owns one `ToolInvocation`; batching, source-order result aggregation, `RunController.submitToolResults()`, and AgentLoop resumption remain Phase 7C.
- Tool side effects must never begin before a durable `RUNNING` invocation and durable `tool.started` event have committed.
- `REQUESTED` is a safe recovery point; an explicitly recovered `RUNNING` invocation has uncertain side-effect outcome and must fail closed without rerunning the handler.
- `WAITING_APPROVAL` is a durable boundary only; approval creation/resolution belongs to Phase 9.
- Expected handler failures are `ToolExecutionResult.isError === true` and become model-recoverable `ToolDispatcherOutcome` results; handler throws and output-contract failures are infrastructure failures.
- Tool lifecycle events are durable, user-visible, use the run aggregate sequence, and never include raw args or raw result content.
- `ToolInvocation` private data may retain required args; `ToolObservation` stores bounded model-facing content and validated structured details.
- `ToolDispatcher` must not mutate `AgentRun`, `AgentState`, `AgentStep`, Conversation, or RunContinuation.
- No automatic retry, timeout, cancellation lifecycle, parallelism, concrete filesystem/shell/process/git tool, real permission evaluator, approval entity, or LLM result conversion.
- `@caelush/tools` may depend only on `@caelush/protocol` plus existing Ajv; `@caelush/storage` may add only the workspace dependency on `@caelush/tools`.
- No AI SDK, network, filesystem, child-process, concrete runtime, or provider type may enter the tool kernel.
- Old migrations are immutable; all schema changes use a new formal migration.
- Do not run `prettier --write .` or `git clean`; only changed files may be formatted.

## Baseline and Execution Workspace

- Worktree: `D:\Develop\Caelush\.worktrees\phase-7b-tool-dispatcher-durable-lifecycle`
- Branch: `codex/phase-7b-tool-dispatcher-durable-lifecycle`
- Base: `origin/codex/phase-7a-tool-registry-schema-runtime` / `1c1027fb...`
- Baseline install: `pnpm install --frozen-lockfile` passed.
- Baseline `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed.
- Baseline `pnpm test`: 135 files, 463 passed, 2 skipped, 0 failed.
- Baseline `pnpm format:check` failed only because 381 existing files are unformatted; preserve that debt and require zero warnings in changed Phase 7B files.

## File Map

### `packages/tools`

- `src/dispatcher-types.ts`: public `ToolDispatchRequest`, `ToolDispatcherOutcome`, `ToolResultOutcome`, and factory/clock/notifier types.
- `src/dispatcher-ports.ts`: `ToolExecutionGatePort`, gate input/decision, and `ToolCommittedEventNotifier`.
- `src/dispatcher-errors.ts`: input, busy, infrastructure, and invariant errors.
- `src/execution-store.ts`: `ToolExecutionStorePort`, snapshot/commit/event draft contracts, and storage conflict/invariant errors exposed to the dispatcher.
- `src/invocation-lifecycle.ts`: pure creation, transitions, terminal, and timestamp/error invariants.
- `src/observation.ts`: immutable ToolObservation construction and relation invariants.
- `src/event-factory.ts`: pure sanitized lifecycle event factories.
- `src/result-validation.ts`: defensive runtime result-shape/schema/detail-budget validation.
- `src/dispatcher.ts`: one-call dispatch/recover orchestration, active-call guard, idempotency, and notification ordering.
- `src/output-policy.ts`: extend existing policy with `maxDetailsBytes` and non-lossy details budget validation.
- `src/json-canonical.ts`: reuse existing canonical semantics and add a frozen JSON clone helper if needed.
- `src/index.ts`: export only the public tools contracts/errors/dispatcher; no concrete storage or event types.
- `test/invocation-lifecycle.test.ts`: lifecycle transitions and invariants.
- `test/dispatcher-input.test.ts`: request/runtime/identity/args byte validation and unknown-tool behavior.
- `test/dispatcher-validation.test.ts`: input/output result validation and budgets.
- `test/dispatcher-gate.test.ts`: allow/deny/approval decisions.
- `test/dispatcher-execution.test.ts`: durable checkpoint-before-handler and success/ordinary-error paths.
- `test/dispatcher-recovery.test.ts`: explicit recovery matrix.
- `test/dispatcher-idempotency.test.ts`: duplicate/conflict/active lock behavior.
- `test/dispatcher-failure.test.ts`: persistence/handler/output failure domains.
- `test/dispatcher-privacy.test.ts`: args/result/throw sentinel leakage.

### `packages/storage`

- `drizzle/<next timestamp>_tool_invocation_lifecycle/migration.sql`: create `tool_invocations` and `agent_observations` with required indexes/FKs/unique constraints.
- `src/schema.ts`: add Drizzle table metadata only; leave old tables untouched.
- `src/repositories/tool-invocation-repository.ts`: decode/query invocation rows with protocol validation and relation checks.
- `src/repositories/observation-repository.ts`: decode/query observations with protocol validation.
- `src/tool-execution-store.ts`: implement `ToolExecutionStorePort` with transaction-local preconditions, CAS, atomic rows/events, rollback, and sanitized error mapping.
- `src/storage.ts` and `src/index.ts`: expose read repositories and `toolExecution` while preserving every existing API member.
- `package.json`: add only `@caelush/tools: workspace:*`.
- `test/tool-invocation-repository.test.ts`, `test/observation-repository.test.ts`, `test/tool-execution-store.test.ts`: migration, decode, CAS, relation, rollback, and persist-before-notify contracts.

### Integration, architecture, and docs

- `tests/integration/tool-dispatcher-storage.test.ts`: file-backed successful/failed dispatch and no Run aggregate mutation.
- `tests/integration/tool-dispatcher-restart.test.ts`: close/reopen recovery and final-settlement failure recovery.
- `tests/architecture/package-boundaries.test.ts` or a focused new architecture test: assert tools imports and public declarations stay clean.
- `docs/architecture/tool-system.md`: document 7A/7B lifecycle, failure domains, security/approval/7C/8 boundaries, and one-host active lock limitation.
- `AGENTS.md`: append the exact Phase 7B invariants from the specification.
- `README.md`: mark 7B current/completed only after verification and state the limited capability precisely.

## Task 1: Characterize Codex tool execution semantics

**Files:** no production changes; record findings in the implementation report/plan notes.

- [ ] Read the current primary-source files `codex-rs/tools/src/tool_executor.rs`, `tool_output.rs`, `function_call_error.rs`, `core/src/tools/registry.rs`, `router.rs`, `lifecycle.rs`, and `approvals.rs`.
- [ ] Record the adopted semantics: executable runtime is separate from registry/router orchestration; model-facing output is projected separately from internal diagnostics; `RespondToModel` is recoverable while `Fatal` is infrastructure failure; approval is a policy-stage boundary rather than tool execution.
- [ ] Record explicitly that Caelush does not copy Codex's Rust types, hook system, sandbox runtime, approval implementation, parallel exposure, or provider-specific output shapes.

## Task 2: Add and prove ToolInvocation lifecycle helpers

**Files:** Create `packages/tools/src/invocation-lifecycle.ts`, `packages/tools/src/observation.ts`; modify `packages/protocol/src/tool.ts` only if the existing schema cannot express the required fields; test `packages/tools/test/invocation-lifecycle.test.ts`.

**Interfaces:**

- `createRequestedToolInvocation(input: { id; runId; stepId; toolName; externalCallId; args; riskLevel; createdAt }): ToolInvocation`
- `markToolInvocationWaitingApproval(invocation): ToolInvocation`
- `startToolInvocation(invocation, startedAt): ToolInvocation`
- `completeToolInvocation(invocation, finishedAt): ToolInvocation`
- `failToolInvocation(invocation, error, finishedAt): ToolInvocation`
- `assertToolInvocationTransition(from, to): void`
- `assertToolInvocationInvariant(invocation): void`
- `createToolObservation(input): ToolObservation`
- `assertToolObservationInvariant(observation, invocation): void`

- [ ] Write tests first for every allowed transition (`REQUESTED → WAITING_APPROVAL/RUNNING/FAILED`, `RUNNING → COMPLETED/FAILED`), terminal rejection, timestamp/error requirements, and observation relation/isError requirements.
- [ ] Run `pnpm vitest run packages/tools/test/invocation-lifecycle.test.ts`; confirm the tests fail because the helpers do not exist.
- [ ] Implement pure Zod-parse-backed immutable helpers; clone/freeze JSON values and never mutate the input object.
- [ ] Run the focused test and the existing protocol tests; refactor only while green.
- [ ] Commit `feat(tools): define durable tool execution contracts`.

## Task 3: Define dispatcher and storage ports

**Files:** Create `dispatcher-types.ts`, `dispatcher-ports.ts`, `dispatcher-errors.ts`, `execution-store.ts`; modify `src/index.ts`; test `packages/tools/test/dispatcher-input.test.ts` and public API tests.

**Interfaces:**

```ts
interface ToolDispatchRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
}

type ToolDispatcherOutcome = ToolResultOutcome | WaitingApprovalOutcome;
interface ToolResultOutcome {
  readonly kind: "RESULT";
  readonly invocation: ToolInvocation;
  readonly observation: ToolObservation;
}
interface WaitingApprovalOutcome {
  readonly kind: "WAITING_APPROVAL";
  readonly invocation: ToolInvocation;
}

interface ToolExecutionStorePort {
  load(invocationId: ToolInvocationId): Promise<ToolExecutionSnapshot | null>;
  findByExternalCall(runId: RunId, stepId: StepId, externalCallId: string): Promise<ToolExecutionSnapshot | null>;
  commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult>;
}
```

- [ ] Write compile-time/public API tests that import these contracts from `@caelush/tools` and assert no `@caelush/storage`, `@caelush/events`, or database row type appears in declarations.
- [ ] Run the focused test and public declaration test to establish the intended red state.
- [ ] Add JSON-safe event draft types derived from the existing `AgentEvent` union, a `ToolClock`, three ID factories, a narrow notifier, and gate decision types `ALLOW | DENY | REQUIRE_APPROVAL`.
- [ ] Add typed errors with generic public messages and optional internal causes; do not include args, result content, stack traces, or raw exceptions in public fields.
- [ ] Run tools typecheck and public API tests; commit `feat(tools): add dispatcher and execution ports`.

## Task 4: Extend output policy and defensive result guards

**Files:** Modify `packages/tools/src/output-policy.ts`, create `src/result-validation.ts`, update `src/index.ts`; test `dispatcher-validation.test.ts` and `output-policy.test.ts`.

- [ ] Write failing tests for `maxDetailsBytes` default `256 * 1024`, canonical UTF-8 byte measurement, malformed result prototypes, non-string content, non-boolean `isError`, non-object details, invalid output schema, and details exceeding the budget.
- [ ] Run the focused tests and verify they fail for the missing details policy/guard.
- [ ] Implement `validateToolExecutionResult(value)` using an own-property/plain-object check, clone/freeze result fields, `resolvedTool.outputValidator.validate(details)`, and non-lossy byte rejection.
- [ ] Reuse `boundToolModelContent` for stored content; never truncate structured details. Return sanitized validation metadata capped at 16 issues and never include raw values/schema bodies.
- [ ] Run focused tests and commit `feat(tools): guard tool results and output budgets`.

## Task 5: Add formal migration and read repositories

**Files:** Create the next migration under `packages/storage/drizzle/`, modify `packages/storage/src/schema.ts`, create `repositories/tool-invocation-repository.ts` and `repositories/observation-repository.ts`, update storage exports; test the two repository files and `migrations.test.ts`.

- [ ] Determine the next migration directory from the actual 7A migrations; create a new timestamped migration only. Do not edit `20260827152057_square_firelord` or `20260829090000_durable_runtime`.
- [ ] Write failing migration/repository tests against a fresh file-backed DB and a DB created from the old migrations: tables, FK relationships, indexes, `(run_id, step_id, external_call_id)` uniqueness, nullable observation invocation FK with unique non-null semantics, and intact old rows.
- [ ] Run focused tests to confirm failure before implementation.
- [ ] Add `tool_invocations` columns `id`, `run_id`, `step_id`, `external_call_id`, `tool_name`, `status`, `risk_level`, `revision`, `protocol_version`, `created_at_ms`, `started_at_ms`, `finished_at_ms`, `data_json`; add required indexes and FK constraints.
- [ ] Add `agent_observations` columns `id`, `run_id`, `step_id`, `kind`, nullable `tool_invocation_id`, `protocol_version`, `is_error`, `created_at_ms`, `data_json`; enforce unique `tool_invocation_id` and tool observation relation at write time without adding a future verification FK.
- [ ] Decode every row via `decodeProtocol(ToolInvocationSchema/ToolObservationSchema, ...)` and compare indexed columns to decoded values; throw storage decode errors on drift.
- [ ] Run migration/repository tests and commit `feat(storage): persist tool invocations and observations`.

## Task 6: Implement atomic `SqliteToolExecutionStore`

**Files:** Create `packages/storage/src/tool-execution-store.ts`; modify `storage.ts`, `index.ts`, `package.json`; test `packages/storage/test/tool-execution-store.test.ts`.

**Transaction contract:** `commit()` opens one `BEGIN IMMEDIATE`, verifies the Run exists and its `sessionId`/status (`RUNNING`) and source Step exists and belongs to the Run with status `COMPLETED` for first creation, validates the invocation candidate and expected revision, writes invocation, optional observation, and all durable lifecycle events via `appendDurableEventsInTransaction`, then commits. Any failure rolls the entire unit back; notification is not part of this port.

- [ ] Write failing tests for initial precondition rejection, create revision `1`, exact CAS update, stale writer conflict, duplicate initial creation race, event sequence sharing with existing run events, deliberate duplicate event ID rollback, and no nested transaction.
- [ ] Run the focused storage tests and verify failure is caused by missing store.
- [ ] Implement row codecs and `ToolExecutionSnapshot` loading. A terminal invocation must load exactly one observation; missing terminal observation throws `ToolExecutionInvariantError`; non-terminal invocation with observation also fails.
- [ ] Implement insert/update CAS: `expectedRevision === null` means no invocation exists; numeric expected revision must match exactly; each mutation increments revision. Normalize unique/PK failures as `ToolExecutionConflictError` and preserve sanitized storage/invariant errors.
- [ ] Reuse existing run aggregate sequencing helper so tool events have no separate chronology. Never call `EventBus.publish()`.
- [ ] Run focused storage tests, then existing storage tests; commit `feat(storage): add atomic tool execution commits`.

## Task 7: Add gate boundary and event factories

**Files:** Modify `dispatcher-ports.ts`, create/modify `event-factory.ts`; test `packages/tools/test/dispatcher-gate.test.ts` and event-factory coverage.

- [ ] Write failing tests for gate input containing only request and resolved definition metadata, and exact `ALLOW`, `DENY`, `REQUIRE_APPROVAL` decisions without free-text policy reason.
- [ ] Run focused tests and confirm missing gate/factory failures.
- [ ] Define `ToolExecutionGatePort.decide(input): Promise<ToolExecutionGateDecision>` with no default allow-all production implementation.
- [ ] Build sanitized durable drafts for `tool.requested` (`invocationId`, `toolName`, `externalCallId`, `riskLevel`), `tool.started` (`invocationId`), `tool.completed` (`invocationId`, `observationId`), and `tool.failed` (sanitized `AgentError`). All are `DURABLE`, `USER_VISIBLE`, use injected event ID/clock factories, and contain no args/content.
- [ ] Run focused tests and commit `feat(tools): add tool execution gate boundary`.

## Task 8: Implement request validation, unknown tool, and durable REQUESTED

**Files:** Create `packages/tools/src/dispatcher.ts`; update `src/index.ts`; test `dispatcher-input.test.ts`, `dispatcher-validation.test.ts`.

- [ ] Write failing tests for invalid IDs/request shape, empty/over-512-byte `externalCallId`, over-256-KiB canonical args, unknown tool, registered-tool invalid args, REQUESTED commit failure, and event privacy.
- [ ] Run the focused tests and verify red before dispatcher implementation.
- [ ] Implement runtime boundary validation using existing Protocol schemas and canonical UTF-8 bytes. Resolve only through immutable `ToolRegistry.resolve`; unknown tools return a model-recoverable `UNAVAILABLE_TOOL` result with no invocation and no fabricated risk level.
- [ ] For a registered tool, validate args before persistence; on failure create a failed invocation plus bounded observation and atomically write `tool.requested` and `tool.failed` with `TOOL_ARGUMENT_ERROR`, then return `RESULT`. A failed REQUESTED commit makes zero gate/handler calls.
- [ ] For valid args, clone/deep-freeze args, create `REQUESTED`, and atomically commit the invocation plus `tool.requested` before calling the gate.
- [ ] Run focused tests and commit `feat(tools): durably record requested tool calls`.

## Task 9: Implement gate paths and pre-execution RUNNING checkpoint

**Files:** Extend `dispatcher.ts`; test `dispatcher-gate.test.ts`, `dispatcher-execution.test.ts`.

- [ ] Write failing tests for `DENY` (failed invocation/observation/`PERMISSION_DENIED`, zero handler), `REQUIRE_APPROVAL` (WAITING_APPROVAL only, zero handler/observation), and `ALLOW` where the handler's first line reads durable `RUNNING` plus `tool.started` from SQLite.
- [ ] Run focused tests and confirm red.
- [ ] Implement deny and approval as atomic state transitions from the existing REQUESTED revision. For deny use fixed observation text `Tool execution was denied by the active execution policy.`; for approval do not create an ApprovalRequest.
- [ ] For allow, commit `REQUESTED → RUNNING` and `tool.started` in one store call, notify only after commit returns, then construct `ToolExecutionRequest` with frozen args and execute exactly once.
- [ ] Ensure a pre-execution commit failure prevents every handler call and gate calls are not repeated by recovery logic.
- [ ] Run focused tests and commit `feat(tools): checkpoint running before tool side effects`.

## Task 10: Implement success and ordinary Tool error settlement

**Files:** Extend `dispatcher.ts`, `result-validation.ts`, `observation.ts`; test `dispatcher-execution.test.ts`, `dispatcher-failure.test.ts`.

- [ ] Write failing tests for valid success (`COMPLETED`, non-error observation, `tool.completed`), valid ordinary failure (`FAILED`, error observation, `TOOL_EXECUTION_ERROR`, sanitized `tool.failed`), cloned result/details, and bounded model content.
- [ ] Run focused tests and verify red.
- [ ] After the handler returns, defensively validate the full result and output schema, clone/freeze content/details, and atomically settle `RUNNING → COMPLETED` or `RUNNING → FAILED` with observation and terminal event.
- [ ] Return `ToolDispatcherOutcome.kind === "RESULT"` for both success and ordinary `isError` failures; never throw a dispatcher fatal for an expected Tool error and never put handler content in lifecycle `AgentError`.
- [ ] Notify committed events after the transaction and assert subscriber reads the settled rows immediately.
- [ ] Run focused tests and commit `feat(tools): settle tool results durably`.

## Task 11: Implement fatal handler/output failure handling

**Files:** Extend `dispatcher.ts`, `dispatcher-errors.ts`, `result-validation.ts`; test `dispatcher-failure.test.ts`, `dispatcher-privacy.test.ts`.

- [ ] Write failing tests for handler throw and output schema/details-budget failure, requiring sanitized durable `FAILED` observation/event before throwing `ToolDispatcherInfrastructureError`.
- [ ] Run focused tests and confirm red.
- [ ] On handler throw, settle with generic `RUNTIME_ERROR`, `phase: "RUNTIME"`, `retryable: false`, and fixed content `Tool execution failed because the tool runtime encountered an internal error.`; retain the original exception only as internal `Error.cause`.
- [ ] On output contract failure, settle with generic `TOOL_OUTPUT_ERROR`, `phase: "TOOL"`, `retryable: false`, `{}` details (or sanitized dispatcher metadata), never persist invalid returned details, then throw infrastructure error.
- [ ] If final settlement commit fails after the handler ran, throw infrastructure error without rerunning the handler; leave the durable invocation RUNNING for explicit recovery.
- [ ] Run focused tests and commit `feat(tools): fail closed on handler and output contract failures`.

## Task 12: Add idempotency, conflict detection, and active-call guard

**Files:** Extend `dispatcher.ts`, `dispatcher-errors.ts`, canonical helpers; test `dispatcher-idempotency.test.ts`.

- [ ] Write failing tests for exact duplicate dispatch returning the same observation with handler count `1`, mismatched tool/semantic args conflict, concurrent same-process dispatch returning busy, and DB unique initial-create race.
- [ ] Run focused tests to verify red.
- [ ] Key active calls by `runId + stepId + externalCallId`; reject a second live dispatch with `ToolDispatcherBusyError` and remove the lock in `finally`.
- [ ] Before creating an invocation, call `findByExternalCall`, compare tool name and canonical JSON args, and route exact matches to existing recovery/idempotent handling. Never use raw `JSON.stringify` order-sensitive comparison and never treat an ordinary duplicate as crash recovery.
- [ ] Keep DB unique/CAS enforcement even with the in-memory guard; document that V1 assumes one local execution host per active Run and provides no distributed claim.
- [ ] Run focused tests and commit `feat(tools): enforce idempotent single-tool dispatch`.

## Task 13: Implement explicit recovery semantics

**Files:** Extend `dispatcher.ts`; test `dispatcher-recovery.test.ts`.

- [ ] Write failing tests for `recover()` on REQUESTED, WAITING_APPROVAL, RUNNING, COMPLETED, FAILED, terminal missing observation, and registry drift.
- [ ] Run focused tests and confirm red.
- [ ] `recover(REQUESTED)` verifies the registered tool still resolves, reuses the durable request, re-enters the gate, checkpoints RUNNING before executing, and never creates a second invocation/event.
- [ ] `recover(WAITING_APPROVAL)` returns WAITING_APPROVAL with zero handler calls; no approval entity/resolution is added.
- [ ] `recover(RUNNING)` never executes the handler. Atomically settle to FAILED with generic `TOOL_EXECUTION_ERROR`, `phase: "TOOL"`, `retryable: false`, and uncertainty text that says the operation may have partially or fully executed and must not be automatically repeated.
- [ ] `recover(COMPLETED/FAILED)` loads and returns the durable observation with zero handler calls. Terminal invocation without observation throws invariant error; a durable tool missing from the current immutable registry throws registry-drift invariant error without fabricating Unknown Tool output.
- [ ] Run focused tests and commit `feat(tools): recover interrupted tool execution safely`.

## Task 14: Add file-backed integration and restart tests

**Files:** Create `tests/integration/tool-dispatcher-storage.test.ts` and `tool-dispatcher-restart.test.ts`; reuse existing storage test fixtures without changing Core.

- [ ] Write the file-backed success E2E first: create Session, RUNNING Run, COMPLETED Step, registry with FakeEchoTool, EventBus notifier adapter, ALLOW gate, dispatch, and assert the handler's first line sees RUNNING/requested/started durable state.
- [ ] Run the integration test and confirm it fails before the complete composition is available.
- [ ] Implement only test fixtures needed to compose existing repositories; do not add production filesystem/shell tools or daemon integration.
- [ ] Assert event order/requested→started→completed, shared run sequence, observation content/details/isError, and all existing Run/State/Step/Conversation/Continuation values unchanged.
- [ ] Close/reopen the same SQLite file, create a fresh registry/dispatcher, call `recover(invocationId)`, and assert handler count remains `1`.
- [ ] Add final-settlement failure E2E: handler count `1`, invocation remains RUNNING with no completed observation/event, restart recovery performs zero handler calls and produces uncertainty failure.
- [ ] Run both integration tests and commit `test: cover durable tool execution recovery`.

## Task 15: Add replay, privacy, rollback, relation, and architecture guards

**Files:** Extend storage/tools/integration tests; modify `tests/architecture/package-boundaries.test.ts` if needed.

- [ ] Write tests for missed notification replay through a new `EventBus`, deliberate event conflict rollback (`0` partial settlement), wrong session/run/step/status preconditions, no `tool.output` events, and all three secret sentinels.
- [ ] Run focused tests and confirm each new guard fails for the intended missing behavior.
- [ ] Verify commit happens before notifier callback; notifier callback can query committed invocation/observation. A skipped notifier never loses events because replay reads the durable store.
- [ ] Verify event payloads, public errors, AgentError, and handler-throw/output-failure observations never contain arg/throw/bad-output secrets; private invocation args and valid model result content remain available only in their intended persistence records.
- [ ] Add source/declaration architecture checks: tools imports only protocol/Ajv; storage imports tools; no AI SDK, network, child process, concrete runtime, Core, EventBus, LLMToolResultMessage, AgentLoop, RunController, or retries in the tool kernel/public declarations.
- [ ] Run all focused tests and commit `test: cover tool lifecycle boundaries and privacy`.

## Task 16: Update docs, verify, commit, push, and report

**Files:** Modify `docs/architecture/tool-system.md`, `AGENTS.md`, `README.md`; no unrelated formatting changes.

- [ ] Update tool-system documentation with the final execution graph, contracts, lifecycle invariants, atomic transaction/notification ordering, recovery distinction, failure domains, privacy boundary, one-host lock limitation, and Phase 7C/8/9 boundaries.
- [ ] Append the required Phase 7B rules to `AGENTS.md` and update README Phase 7 status: 7A complete, 7B current/completed after gates, 7C pending. Do not claim autonomous end-to-end tool use or filesystem/shell capability.
- [ ] Run changed-file formatting check with `pnpm exec prettier --check <each changed Prettier-supported file>`; do not format historical files. Run full `pnpm format:check` and record final warning count/path baseline comparison.
- [ ] Remove generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` safely with a Node fs script only if they are generated artifacts; never run `git clean`.
- [ ] Run fresh `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, and `git diff --check`. Treat a `pnpm check` failure caused only by the known historical Prettier debt honestly.
- [ ] Inspect `git status --short` and `git diff`; require no unrelated files and zero changed-file format warnings. Commit docs separately as `docs: document phase 7b tool lifecycle`.
- [ ] Push with `git push -u origin codex/phase-7b-tool-dispatcher-durable-lifecycle`, compare `git rev-parse HEAD` with `git ls-remote --heads origin refs/heads/codex/phase-7b-tool-dispatcher-durable-lifecycle`, and do not merge master or create a PR.
- [ ] Produce the exact 55-section `Caelush Phase 7B Completion Report` requested by the specification, including baseline, Codex research, 7A reuse, data model, CAS/rollback/replay/recovery evidence, TDD red-green evidence, verification results, commits, remote SHA, worktree cleanliness, capability statement, and Phase 7 status.

## Self-Review Checklist

- [ ] Every Phase 7B gate in the user specification maps to a task above: contracts, lifecycle, formal migration, repositories, atomic store/CAS, gate, requested/running/terminal events, result/fatal handling, idempotency, recovery, restart E2E, privacy, architecture, docs, and verification.
- [ ] No task requires a Phase 7C or Phase 8/9 feature; continuation, batching, AgentLoop, concrete runtime, approval entity, and permission implementation remain explicitly out of scope.
- [ ] All interfaces referenced by later tasks are defined in Tasks 2–3, and all transaction/error semantics are defined in Task 6.
- [ ] No placeholder implementation step is used; every test-first step names the behavior and command that proves red/green.
