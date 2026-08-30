# Caelush Phase 10A Run Cancellation and Abort Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, restart-safe user cancellation that aborts active Run work, cleans Run-owned resources, and settles a Run as `CANCELLED` only after safe cleanup.

**Architecture:** Protocol owns only JSON-safe cancellation intent and existing terminal statuses. Core owns the in-memory `RunExecutionScope`, the scope registry, the two-phase `RunController.cancel()` path, and abstract resource/approval ports. Storage persists intent and atomically settles Run execution; Tools, LLM, and Runtime receive the same ephemeral `AbortSignal`, while LocalProcessManager terminates only processes matching `ownerRunId`.

**Tech Stack:** TypeScript, Node.js 24, ESM, pnpm workspaces, Zod, SQLite/`node:sqlite`, Drizzle schema/migrations, Vitest, Node `AbortController`, `child_process`, and `node-pty`.

**Spec:** `docs/superpowers/specs/2026-08-30-caelush-phase-10a-run-cancellation-design.md`

## Global Constraints

- Phase 10A owns `USER_REQUESTED` cancellation only; do not implement timeout, deadline, retry, backoff, budget, VerificationRunner, daemon cancellation transport, or UI.
- Durable intent must be persisted before an active Run scope is aborted.
- Do not add `CANCELLING`; keep the existing RunStatus set and use durable intent plus in-memory scope for control state.
- `AbortSignal` is ephemeral and must never enter Protocol durable schemas, AgentRun, AgentState, continuation, Tool args, Approval identity/action, security facts, observations, events, or storage.
- Core must not import LocalRuntime, LocalProcessManager, `child_process`, `node-pty`, or concrete LLM adapters; all cross-package execution uses ports.
- Every production RunController execution path receives a required Run-owned signal; test-only helpers may explicitly create `new AbortController().signal`.
- Cancellation is not retryable; it must not become `FAILED`, `MODEL_ERROR`, `RUNTIME_ERROR`, `PROCESS_FAILED`, or `COMMAND_FAILED` when cancellation is authoritative.
- A Tool that completed before a late abort remains truthfully `COMPLETED`; `UNCERTAIN_SIDE_EFFECT` is never downgraded to clean cancellation.
- The normal Run lock remains for start/recover/tool-result/approval execution; `cancel` persists intent and aborts the scope before waiting on that lock.
- Use `apply_patch` for source edits; never run `prettier --write .`, `git reset --hard`, `git clean -fd`, force-push, automatic master merge, or automatic PR creation.
- Run focused tests after each red/green cycle; before completion run fresh `pnpm lint`, `pnpm typecheck`, plain `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`, and `git diff --check`.

## File map

Create/modify files only in these responsibility groups:

- Protocol: `packages/protocol/src/cancellation.ts`, `packages/protocol/src/index.ts`, and the Protocol schema/public-api tests.
- Core control plane: `packages/core/src/run-execution-scope.ts`, `packages/core/src/run-execution-store.ts`, `packages/core/src/run-controller-ports.ts`, `packages/core/src/run-controller-input.ts`, `packages/core/src/run-execution-state.ts`, `packages/core/src/agent-state.ts`, `packages/core/src/agent-loop-input.ts`, `packages/core/src/agent-loop-ports.ts`, `packages/core/src/agent-loop.ts`, `packages/core/src/run-controller-events.ts`, `packages/core/src/run-controller.ts`, `packages/core/src/index.ts`, plus focused Core tests.
- Storage: `packages/storage/src/schema.ts`, one migration under `packages/storage/drizzle/`, `packages/storage/src/cancellation-repository.ts`, `packages/storage/src/run-execution-store.ts`, `packages/storage/src/storage.ts`, `packages/storage/src/index.ts`, and Storage tests.
- Tools: `packages/tools/src/batch-types.ts`, `batch-coordinator.ts`, `dispatcher-types.ts`, `dispatcher.ts`, `handler.ts`, built-in registrations that call Runtime, exports, and focused Tool tests.
- Runtime: `packages/runtime/src/exec/contracts.ts`, `service.ts`, `process-manager.ts`, `pipe-process-adapter.ts`, `pty-process-adapter.ts`, `search/text-search.ts`, `search/ripgrep-runner.ts`, `git/contracts.ts`, `git/git-runner.ts`, patch service critical-section hooks, exports, and Runtime tests.
- Docs and audits: `docs/architecture/cancellation.md`, updates to AgentLoop/Tool/Runtime/Approval architecture docs, `README.md`, `AGENTS.md`, architecture tests, and integration/E2E fixtures under `tests/fixtures/`.

---

### Task 1: Capture baseline and cancellation characterization

**Files:**
- Create: `docs/superpowers/specs/2026-08-30-caelush-phase-10a-run-cancellation-design.md`
- Create: `docs/superpowers/plans/2026-08-30-caelush-phase-10a-run-cancellation-abort-propagation.md`
- Test: `packages/core/test/cancellation-characterization.test.ts`
- Test: `packages/runtime/test/cancellation-characterization.test.ts`

**Interfaces:**
- Consumes: Phase 9D branch `5638fd6154e5f6a45ebe0d175738c22b701f46dc`.
- Produces: Documented facts that `withLock` rejects a busy Run, `AgentLLMClient.complete` has no signal, Tool requests have no signal, Runtime requests have no signal, and `LocalProcessManager` already records `ownerRunId`.

- [x] **Step 1: Write characterization assertions** that inspect source text and existing behavior rather than inventing a new cancellation implementation.
- [x] **Step 2: Run focused characterization tests** with `pnpm vitest run packages/core/test/cancellation-characterization.test.ts packages/runtime/test/cancellation-characterization.test.ts` and record the expected baseline.
- [x] **Step 3: Keep the approved design and plan** as the auditable implementation source; no production behavior changes belong in this task.

### Task 2: Add the strict Protocol cancellation intent

**Files:**
- Create: `packages/protocol/src/cancellation.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/cancellation.test.ts`
- Modify: `packages/protocol/test/public-api.test.ts`

**Interfaces:**
- Produces:

```ts
export const RunCancellationCauseSchema = z.literal("USER_REQUESTED");
export const RunCancellationIntentSchema = z.object({
  runId: RunIdSchema,
  cause: RunCancellationCauseSchema,
  requestedAt: TimestampMsSchema,
}).strict();
export type RunCancellationIntent = z.infer<typeof RunCancellationIntentSchema>;
export type RunCancellationCause = z.infer<typeof RunCancellationCauseSchema>;
```

- [ ] **Step 1: Write failing schema tests** for valid intent, invalid RunId, invalid timestamp, arbitrary cause rejection, arbitrary `reason` rejection, strict unknown-key rejection, and public root export.
- [ ] **Step 2: Run `pnpm vitest run packages/protocol/test/cancellation.test.ts`** and verify it fails because the module/export does not exist.
- [ ] **Step 3: Implement the minimal strict Zod schema** using existing ID/time schemas and export it only from `packages/protocol/src/index.ts`.
- [ ] **Step 4: Re-run the focused test**, then run `pnpm vitest run packages/protocol/test/*.test.ts`.

### Task 3: Persist first-writer-wins cancellation intent

**Files:**
- Create: `packages/storage/drizzle/20260830180000_run_cancellation/migration.sql`
- Create: `packages/storage/src/cancellation-repository.ts`
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/storage.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/cancellation-repository.test.ts`
- Modify: `packages/storage/test/migrations.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CancellationRepository {
  get(runId: RunId): Promise<RunCancellationIntent | null>;
  request(intent: RunCancellationIntent): Promise<RunCancellationIntent>;
}
```

The concrete repository writes `run_cancellation_requests(run_id PRIMARY KEY, cause, requested_at_ms)` in `BEGIN IMMEDIATE`, returns the existing row unchanged on duplicate request, and never deletes an intent.

- [ ] **Step 1: Write failing migration/repository tests** for table creation, FK to `agent_runs`, intent persistence across close/reopen, first timestamp preservation, duplicate idempotency, and strict decoding of corrupt cause/timestamp.
- [ ] **Step 2: Run the focused Storage tests** and verify failure from the missing table/repository.
- [ ] **Step 3: Add exactly one narrow migration** and matching Drizzle table definition; do not add timeout/retry/budget tables.
- [ ] **Step 4: Implement codec-backed repository methods** with `RunCancellationIntentSchema`, `BEGIN IMMEDIATE`, and safe `StorageError` mapping.
- [ ] **Step 5: Run `pnpm vitest run packages/storage/test/cancellation-repository.test.ts packages/storage/test/migrations.test.ts`** and verify persistence/idempotency.

### Task 4: Expose intent through the execution store and add scope primitives

**Files:**
- Create: `packages/core/src/run-execution-scope.ts`
- Modify: `packages/core/src/run-execution-store.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/storage/src/run-execution-store.ts`
- Modify: `packages/storage/src/storage.ts`
- Test: `packages/core/test/run-execution-scope.test.ts`
- Test: `packages/storage/test/run-execution-store-cancellation.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RunExecutionScope {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  abort(): void;
  settle(): void;
}
export class RunExecutionScopeRegistry {
  open(runId: RunId): RunExecutionScope;
  get(runId: RunId): RunExecutionScope | undefined;
  abort(runId: RunId): boolean;
  close(runId: RunId, scope: RunExecutionScope): void;
}
```

`RunExecutionSnapshot` gains `cancellationIntent?: RunCancellationIntent`; `RunExecutionStorePort` gains `requestCancellation(runId, intent): Promise<RunExecutionSnapshot>`.

- [ ] **Step 1: Write failing scope tests** for signal ownership, duplicate `open`, abort, settlement, close, and one-Run isolation; write store tests for snapshot intent visibility.
- [ ] **Step 2: Run focused Core/Storage tests** and verify missing class/property/method failures.
- [ ] **Step 3: Implement the scope and registry** with one controller per Run and no serialization hooks.
- [ ] **Step 4: Extend Storage load/transaction code** to join/decode the cancellation row and atomically request the first intent.
- [ ] **Step 5: Run focused tests and `pnpm typecheck`** for all package contract consumers.

### Task 5: Add cancellation state/step helpers and approval cancellation port

**Files:**
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/agent-state.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/storage/src/repositories/approval-repository.ts`
- Modify: `packages/storage/src/storage.ts`
- Test: `packages/core/test/cancellation-state.test.ts`
- Test: `packages/storage/test/approval-cancellation.test.ts`

**Interfaces:**
- Produces:

```ts
markAgentRunCancelled(run: AgentRun, now: TimestampMs): AgentRun;
markAgentStateCancelled(state: AgentState, now: TimestampMs): AgentState;
interface ApprovalResolutionPort {
  cancelPendingByRun(runId: RunId, now: TimestampMs): Promise<readonly ApprovalRequest[]>;
}
```

The helpers clear `currentStepId`; AgentState cancellation does not append a generic error; approval cancellation changes only `PENDING` rows to `CANCELLED`, emits the existing `approval.resolved`, and leaves APPROVED/REJECTED/EXPIRED untouched.

- [ ] **Step 1: Write failing tests** for valid `PENDING`, `RUNNING`, `WAITING_APPROVAL`, `VERIFYING` cancellation transitions, terminal rejection/no-op behavior, current-step clearing, no error append, and approval idempotency.
- [ ] **Step 2: Run the focused tests** and verify missing helper/port/repository failures.
- [ ] **Step 3: Implement minimal helpers and the SQL `UPDATE ... WHERE status='PENDING'` transaction** with exactly-once event creation per changed approval.
- [ ] **Step 4: Run focused Core/Storage tests and all approval tests**.

### Task 6: Require the Run signal through AgentLoop and make cancellation a typed result

**Files:**
- Modify: `packages/core/src/agent-loop-input.ts`
- Modify: `packages/core/src/agent-loop-ports.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent-error-mapper.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-loop-cancellation.test.ts`
- Modify: existing Core AgentLoop tests through explicit test helpers

**Interfaces:**
- Produces:

```ts
interface AgentLoopCommonInput { readonly signal: AbortSignal; /* existing fields */ }
interface AgentLLMClient {
  complete(request: LLMRequest, options: { readonly signal: AbortSignal }): Promise<LLMTurnResult>;
}
type AgentProviderTurnState = "NOT_STARTED" | "FAILED" | "COMPLETED" | "CANCELLED";
interface AgentLoopCancelledResult {
  readonly status: "CANCELLED";
  readonly state: AgentState;
  readonly step?: AgentStep;
  readonly messagesToAppend: readonly LLMMessage[];
  readonly providerTurnState: "NOT_STARTED" | "CANCELLED";
}
```

- [ ] **Step 1: Write failing tests** for pre-aborted input, abort during inspector/planner, abort before step, abort during lifecycle, abort during provider, provider resolving after abort, no partial message/tool request, cancelled active Step, no `llm.completed`, and cancellation error mapping `retryable=false`.
- [ ] **Step 2: Run focused tests** and verify the input/type/result failures.
- [ ] **Step 3: Add `throwIfAborted` safe points** around existing awaits and context build; pass the signal to the LLM port; add a cancellation result that returns no messages.
- [ ] **Step 4: Add a post-provider signal check before classification and ensure started attempts settle usage once**; do not retry or map to FAILED.
- [ ] **Step 5: Run `pnpm vitest run packages/core/test/agent-loop-cancellation.test.ts packages/core/test/agent-loop*.test.ts`** and typecheck.

### Task 7: Propagate the signal through Tool Batch, Dispatcher, Handler, and lifecycle

**Files:**
- Modify: `packages/tools/src/batch-types.ts`
- Modify: `packages/tools/src/batch-coordinator.ts`
- Modify: `packages/tools/src/dispatcher-types.ts`
- Modify: `packages/tools/src/dispatcher.ts`
- Modify: `packages/tools/src/handler.ts`
- Modify: `packages/tools/src/errors.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: all Tool built-ins that invoke Runtime
- Test: `packages/tools/test/batch-cancellation.test.ts`
- Test: `packages/tools/test/dispatcher-cancellation.test.ts`

**Interfaces:**
- Produces:

```ts
interface ToolBatchRequest { readonly signal: AbortSignal; /* existing fields */ }
interface ToolDispatchRequest { readonly signal: AbortSignal; /* existing fields */ }
interface ToolExecutionRequest { readonly signal: AbortSignal; /* existing fields */ }
class ToolBatchCancelledError extends Error {}
```

`assertToolBatchRequest` and `assertToolDispatchRequest` include signal as an ephemeral field but do not put it in any JSON schema or identity comparison. Dispatcher preflight occurs before invocation creation, Gate, Approval, and Handler. Successful settlement wins over a late abort; uncertain side effects remain uncertain.

- [ ] **Step 1: Write failing tests** for pre-aborted batch/dispatcher (zero invocation/handler), trailing batch stop, abort between REQUESTED and RUNNING, cooperative handler cancellation, successful-before-abort, uncertainty precedence, and no normal ToolObservation for clean cancelled invocation.
- [ ] **Step 2: Run focused Tool tests** and verify expected missing signal/cancellation behavior.
- [ ] **Step 3: Add required signal fields and a typed cancellation error**; check signal before each item and each dispatcher side-effect boundary.
- [ ] **Step 4: Add cancellation lifecycle settlement and safe `AgentError` (`CANCELLED`, `TOOL`, `retryable:false`) without touching Security/Approval identity.
- [ ] **Step 5: Update built-in calls to forward the signal to Runtime** and run all Tool tests.

### Task 8: Propagate the signal through Runtime operations and structured helpers

**Files:**
- Modify: `packages/runtime/src/exec/contracts.ts`
- Modify: `packages/runtime/src/exec/service.ts`
- Modify: `packages/runtime/src/search/text-search.ts`
- Modify: `packages/runtime/src/search/ripgrep-runner.ts`
- Modify: `packages/runtime/src/git/contracts.ts`
- Modify: `packages/runtime/src/git/git-runner.ts`
- Modify: Runtime filesystem/discovery short-operation entry points as needed for pre/post checks
- Modify: `packages/runtime/src/runtime-errors.ts`, `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/runtime-cancellation.test.ts`
- Test: `packages/runtime/test/structured-helper-cancellation.test.ts`

**Interfaces:**
- Produces:

```ts
interface RuntimeExecRequest { readonly signal?: AbortSignal; /* existing fields */ }
interface RuntimeProcessInteractionRequest { readonly signal?: AbortSignal; /* existing fields */ }
class RuntimeOperationCancelledError extends RuntimeError {}
```

The signal is required at the Tool/Core boundary but may remain optional in low-level Runtime helpers for existing standalone consumers; all Run-owned production calls pass it. `rg`/Git use `shell:false`, abort their child, wait for close, and reject with the typed cancellation error.

- [ ] **Step 1: Write failing tests** for pre-aborted exec/interact, abort during process yield, zero stdin write on pre-abort, aborting `rg`, aborting Git, and cancellation not mapping to unavailable/command-failed.
- [ ] **Step 2: Run focused Runtime tests** and verify they fail because child operations ignore the signal.
- [ ] **Step 3: Implement a shared abort listener/settlement helper** for low-level child operations; remove listeners after close and keep `shell:false`.
- [ ] **Step 4: Add pre-operation checks to short filesystem/discovery operations and forward the signal from Runtime services.
- [ ] **Step 5: Run Runtime focused and regression tests.

### Task 9: Implement Run-owned LocalProcessManager cleanup for pipe, PTY, and yielded sessions

**Files:**
- Modify: `packages/runtime/src/exec/process-manager.ts`
- Modify: `packages/runtime/src/exec/pipe-process-adapter.ts`
- Modify: `packages/runtime/src/exec/pty-process-adapter.ts`
- Modify: `packages/runtime/src/exec/contracts.ts`
- Test: `packages/runtime/test/process-manager-cancellation.test.ts`
- Test: `packages/runtime/test/pipe-process-adapter.test.ts`
- Test: `packages/runtime/test/pty-process-adapter.test.ts`
- Create: `tests/fixtures/long-running-process.js`

**Interfaces:**
- Produces:

```ts
export interface RunOwnedCleanupSummary {
  readonly runId: RunId;
  readonly stoppedProcessIds: readonly string[];
  readonly confirmed: boolean;
}
class LocalProcessManager {
  cancelOwnedByRun(runId: RunId): Promise<RunOwnedCleanupSummary>;
}
```

The method targets all nonterminal entries with exact `ownerRunId`, calls adapter termination, waits for close/exit confirmation, removes terminal entries, and is idempotent. `waitForYield` races timer, terminal state, and request signal; `dispose` remains separate.

- [ ] **Step 1: Write failing tests** for two processes owned by A plus one by B, multiple A processes, yielded process cleanup, already exited cleanup, idempotent cleanup, pipe termination, supported PTY termination, and no live A entries after confirmed cleanup.
- [ ] **Step 2: Run focused process tests** and verify missing method/termination race failures.
- [ ] **Step 3: Implement `cancelOwnedByRun` and adapter termination state** using existing `KILLED` protocol semantics; do not add another registry.
- [ ] **Step 4: Pass signal into start/interact and ensure pre-aborted interaction writes zero characters.
- [ ] **Step 5: Run focused tests with the Node fixture and platform-appropriate PTY tests; do not use retry as a success condition.

### Task 10: Add Core resource port, two-phase `RunController.cancel`, and terminal settlement

**Files:**
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/run-controller-cancellation.test.ts`
- Test: `packages/core/test/run-controller-races.test.ts`

**Interfaces:**
- Produces:

```ts
interface RunOwnedResourceControllerPort {
  cancelOwnedResources(runId: RunId): Promise<{
    readonly stoppedResourceIds: readonly string[];
    readonly confirmed: boolean;
  }>;
}
interface RunControllerDependencies {
  readonly scopes: RunExecutionScopeRegistry;
  readonly resources?: RunOwnedResourceControllerPort;
  /* existing dependencies */
}
class RunController {
  cancel(runId: RunId): Promise<RunControllerResult>;
}
```

`cancel` performs request intent → immediate scope abort → await scope settlement → approval/resource cleanup → one atomic terminal commit. It never calls `withLock` first. If cleanup is unconfirmed, it leaves the durable intent and returns a safe infrastructure/cancellation-pending result without clearing live state or claiming `CANCELLED`.

- [ ] **Step 1: Write failing concurrent tests** with Deferred/Latch synchronization: start holds a provider, cancel runs concurrently, cancel is not busy, provider signal aborts, start settles, cancel settles as `CANCELLED`; also cover cancel before scope open, scope closing after intent, duplicate cancel, terminal no-op, PENDING, WAITING_APPROVAL, VERIFYING, and resource-cleanup failure.
- [ ] **Step 2: Run the focused tests** and verify the current `withLock` behavior fails the concurrency contract.
- [ ] **Step 3: Add the out-of-lock durable request path** and scope creation/close around normal execution. Check durable intent before all work in start/recover/submit/approve.
- [ ] **Step 4: Implement `finalizeCancellationLocked`** with latest snapshot, pending approval cancellation, confirmed resource cleanup, active Step cancellation, state/run helpers, continuation CLEAR, exactly one `status.changed` and `run.cancelled` event, and no conversation append.
- [ ] **Step 5: Run focused Core tests and all existing RunController tests; resolve conflicts by reloading latest snapshots rather than duplicating transitions.

### Task 11: Integrate cancellation with all RunController Agent/Tool paths and recovery

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/agent-tool-batch.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Test: `packages/core/test/run-controller-agent-cancellation.test.ts`
- Test: `packages/storage/test/run-controller-cancellation-recovery.test.ts`

**Interfaces:**
- Consumes: `RunExecutionScopeRegistry`, `RunOwnedResourceControllerPort`, `RunExecutionSnapshot.cancellationIntent`, typed AgentLoop/Tool cancellation results.
- Produces: All `start`, `recover`, `submitToolResults`, and `resolveApproval` calls pass the scope signal; `recover` gives intent priority over stale Step, pending Approval, waiting Tool Results, and awaiting verification.

- [ ] **Step 1: Write failing recovery tests** for intent + RUNNING/stale Step, WAITING_APPROVAL, WAITING_TOOL_RESULTS, AWAITING_VERIFICATION, and intent persisted with zero provider/tool calls.
- [ ] **Step 2: Run the focused recovery tests** and verify the current implementation resumes/fails ordinary boundaries instead of cancelling.
- [ ] **Step 3: Add authoritative intent checks and cancellation branches** in every continuation path; never resume Tool Batch after intent.
- [ ] **Step 4: Add cancellation result handling in RunController** so provider/Tool/runtime cancellation cannot enter normal failure handling or retry.
- [ ] **Step 5: Run Core/Storage recovery and regression tests, including duplicate event assertions.

### Task 12: Patch critical section and Approval/cancel race semantics

**Files:**
- Modify: `packages/runtime/src/patch/service.ts`
- Modify: `packages/runtime/src/patch/committer.ts`
- Modify: `packages/tools/src/dispatcher.ts`
- Modify: `packages/core/src/run-controller.ts`
- Test: `packages/runtime/test/patch-cancellation.test.ts`
- Test: `packages/tools/test/approval-cancellation-race.test.ts`
- Test: `packages/core/test/approval-cancellation-race.test.ts`

**Interfaces:**
- Consumes: the same signal and cancellation finalizer; existing Prepare/Dry Apply/Hash Guard/Commit/Verify/Rollback stages.
- Produces: cancellation checkpoints before commit, deferred abort through commit/rollback, and intent checks immediately before approval resume.

- [ ] **Step 1: Write failing latch tests** for cancellation before commit (zero mutation), prepared-before-commit, cancellation during commit, cancel-then-approve, approve-then-cancel, and RUN grant not blocking cancellation.
- [ ] **Step 2: Run focused tests** and verify patch currently has no cancellation critical-section contract and approval resume can proceed after intent.
- [ ] **Step 3: Add cancellation checks before commit and a non-abortable critical-section guard** that completes commit/rollback safely before observing cancellation.
- [ ] **Step 4: Check intent before `resolveApproval` resumes Tool work and make cancelled Approval terminal/non-resumable.
- [ ] **Step 5: Run patch, approval, and security regression tests; verify signal is absent from Approval keys/action and Security facts.

### Task 13: Add event and architecture audits

**Files:**
- Modify: `packages/protocol/src/events/run.ts` only if payload validation needs the existing safe cancellation event contract
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/tools/src/event-factory.ts`
- Create: `tests/architecture/cancellation-boundaries.test.ts`
- Modify: `tests/architecture/package-boundaries.test.ts`
- Modify: `tests/architecture/process-runtime-boundaries.test.ts`
- Modify: `packages/core/test/architecture.test.ts`
- Modify: `packages/tools/test/public-api.test.ts`

**Interfaces:**
- Produces: safe optional `llm.cancelled`/`tool.cancelled` events only if their existing event union can validate them; mandatory `run.cancelled`, `status.changed`, `approval.resolved(CANCELLED)`, and `process.stopped(KILLED)` remain exactly-once.

- [ ] **Step 1: Write failing static audits** that reject `AbortSignal` in Protocol/AgentRun/AgentState/Approval key/Tool args/events, Core concrete Runtime imports, Runtime/LLM → Core imports, direct Core `child_process`, and Dispatcher/Security bypass paths.
- [ ] **Step 2: Run architecture tests** and confirm they detect at least one intentionally absent new boundary.
- [ ] **Step 3: Implement only the minimal exports/events/audit rules required by the actual source graph; keep event payloads free of command, stdin, patch, args, prompt, output, and secrets.
- [ ] **Step 4: Run all architecture tests and full package tests.

### Task 14: Real integration, crash recovery, and no-fake-cancellation E2E

**Files:**
- Create: `tests/integration/run-cancellation.integration.test.ts`
- Create: `tests/integration/cancellation-crash-recovery.test.ts`
- Create: `tests/e2e/run-cancellation.e2e.test.ts`
- Create: `tests/fixtures/long-running-process.js`
- Modify: test support factories in `packages/core/test`, `packages/storage/test`, and `apps/daemon/test` only where needed for Core-only composition

**Interfaces:**
- Consumes: full Core/Storage/Tools/Runtime ports, a fake LLM, `LocalRuntime`, `LocalProcessManager`, SQLite reopen, and latch-based synchronization.
- Produces: a reproducible proof for AgentLoop → RunController → ToolBatch → Dispatcher → `exec_command` → LocalRuntime → ProcessManager, plus resource-cleanup failure behavior.

- [ ] **Step 1: Write failing true E2E tests** for a fake LLM requesting `exec_command`, `process.started`, concurrent `cancel`, provider no-next-turn, trailing tool barrier, process cleanup, empty activeProcesses, cleared continuation, terminal Run, finishedAt, and exactly-once events.
- [ ] **Step 2: Write failing crash tests** that persist intent, close/reopen SQLite, recover each boundary, and assert `providerCalls=0`/`toolCalls=0`; add a fake resource controller whose `confirmed=false` keeps the Run nonterminal and allows cleanup retry.
- [ ] **Step 3: Run the new tests** and verify the missing end-to-end cancellation path.
- [ ] **Step 4: Wire production-like composition and fixture lifecycle**; use Deferred/Latch, not `sleep(100)`, and use platform-neutral Node fixture arguments.
- [ ] **Step 5: Run integration/E2E tests repeatedly enough to characterize PTY/platform behavior, then run the focused set once without `--retry` as the gate.

### Task 15: Documentation, README/AGENTS rules, and final verification

**Files:**
- Create: `docs/architecture/cancellation.md`
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/architecture/tool-system.md`
- Modify: `docs/architecture/runtime.md`
- Modify: `docs/architecture/approval-workflow.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: all changed source/test files as needed to satisfy formatting

**Interfaces:**
- Produces: documentation of ownership, durable intent, scope/lock sequence, signal fan-out, Tool/Runtime/process/Approval/Patch semantics, recovery/races/events, managed-process limitations, and explicit Phase 10A exclusions. README reports Phase 9 and 10A completion while Phase 10 remains in progress.

- [ ] **Step 1: Write documentation assertions/checklist** for every required topic and forbidden overclaim (no timeout/retry/budget/hard-sandbox/arbitrary descendant guarantee).
- [ ] **Step 2: Update the docs and durable `AGENTS.md` rules** without running whole-repository formatting.
- [ ] **Step 3: Run changed-file formatting checks** using `pnpm exec prettier --check <changed-file-list>` and adjust only changed files with `apply_patch`.
- [ ] **Step 4: Remove generated `dist`/`*.tsbuildinfo` safely with explicit Node/PowerShell paths if a clean build is required; never use `git clean`.
- [ ] **Step 5: Run, in strict serial order, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`; record the existing 579-file formatting baseline and prove changed files have zero warnings.
- [ ] **Step 6: Run `git diff --check`, `git status --short`, inspect `git diff`, and verify all required scope/security/no-fake-cancellation assertions before making completion claims.
- [ ] **Step 7: Commit coherent changes with messages such as `feat(core): add durable run cancellation control`, `feat(core): propagate run cancellation`, `feat(tools): add cooperative cancellation`, `feat(runtime): cancel run-owned processes`, `feat(storage): persist cancellation intent`, `test: cover cancellation races`, and `docs: document phase 10a`; do not merge master or create a PR.
- [ ] **Step 8: Push the dedicated branch with `git push -u origin codex/phase-10a-run-cancellation-abort-propagation`, compare local and remote SHA using `git ls-remote`, and report the actual working-tree/remote state.

## Plan self-review

- Spec coverage: durable Protocol contract, one migration, store visibility, scope registry, lock exception, RunController settlement, all four execution entry points, AgentLoop/LLM, Tool Batch/Dispatcher/Handler, Runtime helpers, process ownership, patch critical section, Approval, recovery, events, races, crash E2E, architecture audits, docs, and full verification are covered by Tasks 2–15.
- Placeholder scan: no `TBD`, `TODO`, “implement later”, or unspecified “handle edge cases” steps are used; each behavior-changing task includes concrete red/green commands and interfaces.
- Type consistency: `RunExecutionSnapshot.cancellationIntent`, `RunExecutionScopeRegistry`, `RunOwnedResourceControllerPort`, required `signal`, `AgentLoopCancelledResult`, `ToolBatchCancelledError`, `RuntimeOperationCancelledError`, and `RunController.cancel` are named consistently across tasks.
- Scope check: no daemon route, timeout, retry, budget, VerificationRunner, UI, remote runtime, MCP, browser, or hard sandbox work is included.
