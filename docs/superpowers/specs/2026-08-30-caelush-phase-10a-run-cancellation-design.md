# Caelush V1 Phase 10A — Run Cancellation Control Plane

## Status

Approved design source: the Phase 10A task brief supplied by the user on 2026-08-30. This document translates that brief into the repository's existing contracts and package boundaries. It covers user-requested cancellation only; timeout, retry, backoff, budget enforcement, verification execution, daemon cancellation transport, and UI remain out of scope.

## Goal and invariants

When a Run is cancelled, Caelush must stop the active execution rather than only changing a database field. The authoritative sequence is:

```text
persist CancellationIntent
        ↓
abort the active RunExecutionScope
        ↓
unwind AgentLoop / LLM / Tool / Runtime work
        ↓
clean Run-owned processes and other resources
        ↓
atomically settle Run, State, Step, Continuation, and events as CANCELLED
```

The intent is durable and first-writer-wins. The scope and its `AbortController` are process-local and never durable. There is no `CANCELLING` status. A terminal Run other than `CANCELLED` is never overwritten, and repeated cancellation is an idempotent no-op.

## Existing-code characterization

- `packages/core` owns `RunController`, the AgentLoop port, the canonical state machine, and the atomic execution-store port. It currently guards normal entry points with an in-memory per-Run lock.
- `packages/storage` owns SQLite migrations and the concrete `RunExecutionStorePort`. The existing commit path uses `BEGIN IMMEDIATE`, and approval resolution already emits durable `approval.resolved` events.
- `packages/llm` already accepts an optional signal in the Gateway and maps provider aborts to `LLMAbortedError`; Phase 10A wires the Core-owned signal through `AgentLLMClient` without moving provider types into Core.
- `packages/tools` has durable invocation lifecycle, Security Gate, Approval, Tool Batch, and Handler boundaries. The signal will be an ephemeral execution field, never Tool args, security facts, approval identity, observations, or event payloads.
- `packages/runtime` has `LocalProcessManager` entries keyed by `ownerRunId`, pipe/PTY adapters, structured `rg` and Git helpers, and patch commit/rollback stages. The existing manager is extended with owner-scoped cleanup.
- The repository's Phase 9D baseline is the remote commit `5638fd6154e5f6a45ebe0d175738c22b701f46dc`; it is not an ancestor of `origin/master`, so the implementation branch is based on the Phase 9D branch.

## Domain and persistence model

Add to Protocol a strict, JSON-safe contract:

```ts
type RunCancellationCause = "USER_REQUESTED";

interface RunCancellationIntent {
  readonly runId: RunId;
  readonly cause: RunCancellationCause;
  readonly requestedAt: TimestampMs;
}
```

The schema validates `runId`, `requestedAt`, and the closed cause enum. It does not accept an arbitrary external reason and does not contain `AbortSignal`. The user-visible cancellation text is the constant `User requested cancellation.`

Add exactly one SQLite migration for `run_cancellation_requests`:

```text
run_id       PRIMARY KEY, FK agent_runs(id)
cause        NOT NULL
requested_at NOT NULL
```

The intent is never deleted. `RunExecutionSnapshot` exposes an optional decoded intent. The storage port adds a concurrency-safe `requestCancellation(runId, intent)` operation (or equivalent repository-shaped method) whose transaction persists only the first intent and returns the latest Run snapshot. It uses the existing SQLite transaction discipline and never changes a terminal outcome.

## Execution scope and locking

Core adds host-only `RunExecutionScope` and `RunExecutionScopeRegistry`:

```ts
interface RunExecutionScope {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  abort(): void;
  readonly settled: Promise<void>;
}
```

The registry supports `open`, `get`, `abort`, and `close`, rejects duplicate active scopes, and ensures one active scope per Run. `AbortController` and `AbortSignal` never enter Protocol entities, AgentState, AgentRun, continuation data, Approval data/key, Tool args, or events.

Normal `start`, `recover`, `submitToolResults`, and `resolveApproval` continue to use the existing busy guard. `cancel` is deliberately outside that guard:

1. Persist the durable intent.
2. Find and abort the active scope immediately, without waiting for the normal Run lock.
3. Await the active scope's settlement and run resource cleanup.
4. Re-load the latest snapshot and finalize cancellation if cleanup is confirmed.

If no active scope exists, cancellation finalization/recovery still happens from the durable intent. If resource cleanup cannot be confirmed, the intent remains durable, the Run is not falsely terminalized, and later recovery retries cleanup without resuming Agent work.

All normal execution entry points check the intent immediately after loading the snapshot and before any Agent, Tool, Approval resume, or continuation work. This closes the race where cancellation is committed just before a new scope opens.

## RunController cancellation settlement

`RunController.cancel(runId)` is transport-neutral and has no HTTP route in this phase. A centralized finalizer performs:

1. Load latest state and assert the intent.
2. Cancel pending approvals for the Run; already resolved approvals are unchanged.
3. Ask the Core resource port to cancel all Run-owned resources and require confirmed cleanup.
4. Cancel an active AgentStep with `cancelAgentStep`; a provider attempt that actually started still increments step usage when settled, while a pre-step cancellation does not.
5. Produce cancelled Run and AgentState (`status=CANCELLED`, `finishedAt=now`, `currentStepId` cleared); clear every continuation kind.
6. Commit Run/State/Step/Continuation and durable events atomically through `RunExecutionStorePort`.

Cancellation emits exactly one `status.changed` transition from the current nonterminal status and one existing `run.cancelled` event with only the safe reason. It does not emit `run.failed`, append a synthetic conversation message, or overwrite a terminal outcome. Pending approvals become `CANCELLED` and emit the existing `approval.resolved` event with that status. Optional `llm.cancelled` and `tool.cancelled` events contain only safe identifiers/metadata and are not required for correctness.

The finalizer is valid from `PENDING`, `RUNNING`, `WAITING_APPROVAL`, and `VERIFYING`. `PENDING` has no AgentState, Step, LLM call, or Tool call. A Run whose intent is present on restart always takes the cancellation path before stale-step, approval, Tool continuation, or verification recovery.

## Signal propagation

The same Run-owned signal is passed through these host-only interfaces:

```text
RunExecutionScope.signal
  → AgentLoop input
  → AgentLLMClient.complete(request, { signal })
  → existing LLM Gateway signal

RunExecutionScope.signal
  → ToolBatchRequest
  → ToolDispatchRequest
  → ToolExecutionRequest
  → Runtime exec / interaction / structured helper operations
```

AgentLoop checks cancellation at context safe points (before/after inspector and planner, before/after context build, before step, before/after lifecycle, before/after provider, and before decision classification). It returns a typed `CANCELLED` execution result with no appended messages. A started provider attempt settles as `providerTurnState=CANCELLED`; a provider that ignores abort is guarded by a post-resolution signal check and its entire result is discarded. No partial assistant text, Tool calls, or `llm.completed` event is persisted.

Tool Batch checks before every item and stops all trailing calls. Dispatcher checks before invocation creation, Security Gate, Approval creation, and Handler execution. A pre-aborted request creates no invocation. A requested-but-not-started invocation can settle as `CANCELLED`; cooperative cancellation maps to the existing `AgentError` code `CANCELLED`, `retryable=false`, `phase=TOOL`. A handler result that durably completes before a late abort remains truthfully `COMPLETED`. `UNCERTAIN_SIDE_EFFECT` always wins over clean cancellation and remains non-replayable.

## Runtime and process cancellation

Runtime operation contracts receive the same signal. Short filesystem operations use pre/post checks. `rg` and Git child processes use `shell:false`, terminate on abort, and map abort to a typed runtime cancellation error instead of unavailable/command-failed. Patch mutation treats commit/rollback as a cancellation-deferred critical section: cancellation is accepted before commit, deferred through commit/rollback, and observed after safe settlement.

`LocalProcessManager.cancelOwnedByRun(runId)` finds every nonterminal entry with the matching `ownerRunId`, requests adapter termination, waits for controlled terminal confirmation, emits/retains `KILLED` semantics, removes terminal entries, and returns a bounded summary with stopped IDs and confirmation. It never touches another Run. It supports multiple processes per Run, yielded `exec_command` sessions, pipe and supported PTY adapters, and idempotent cleanup. `waitForYield` races process terminal state against abort; `interact` writes zero bytes when already aborted. Core depends only on a structural Run-owned resource port and never imports `LocalProcessManager`, `child_process`, `node-pty`, or `LocalRuntime`.

The implementation proves that a cancelled Run has no live owned manager entry before terminal cancellation is committed. This is managed-process cleanup, not an OS hard-sandbox guarantee; platform process-tree limitations remain documented.

## Recovery and race semantics

The authoritative ordering is terminal status first, then durable intent, then normal recovery. Intent wins these races:

- active `start`/Tool/LLM work: signal aborts immediately and the active operation unwinds;
- intent persisted while a scope closes: latest snapshot is reloaded and finalizer wins;
- intent persisted before scope creation: the entry point refuses Agent work;
- intent persisted before final candidate settlement: cancellation wins over `VERIFYING`;
- `cancel` versus `approve`: the intent check prevents resume, and a pending approval is cancelled;
- already terminal Run versus `cancel`: existing outcome is returned unchanged.

Recovery never resumes an intent-marked Run. It cancels stale active Steps, pending approvals, Tool continuations, verification continuations, and owned resources, then retries only the cancellation cleanup/finalization path. Cancellation is not retryable and is never mapped to model, runtime, process, or network failure.

## Verification plan

Tests are written first and must demonstrate a real red phase. Coverage includes strict Protocol/schema and SQLite restart persistence, first-writer/idempotent/terminal cancellation, scope lifecycle and lock races, pre-aborted and provider-ignoring AgentLoop, no partial conversation, Tool Batch/Dispatcher lifecycle and uncertainty precedence, Runtime helpers, pipe/PTY/process ownership and yielded sessions, patch critical-section safety, Approval/cancel races, recovery priority, durable event exactly-once, and a real AgentLoop → Tool Batch → Dispatcher → `exec_command` → LocalRuntime → LocalProcessManager cancellation path using a Node fixture.

Architecture tests forbid durable or security-boundary leakage of signals, Core imports of concrete Runtime, and bypasses around Dispatcher/Security. The final checks run the required fresh lint, typecheck, plain tests, build, `git diff --check`, changed-file formatting, and `pnpm check`, while preserving the measured repository formatting debt baseline.

## External references absorbed

The design adopts the narrow ideas relevant to Caelush from current upstream implementations without importing their runtimes: OpenAI Codex passes a parent cancellation token into each turn and derives child tokens for nested work; OpenCode tracks interrupted tool calls and avoids treating unfinished work as a normal completed turn. Caelush uses Node.js `AbortController`/`AbortSignal` and its own Kernel contracts instead of Tokio, Effect, or either framework's session architecture.

- https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/regular.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/run-state.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts

## Explicit exclusions

This phase does not add `CANCELLING`, deadlines, timeout orchestration, `TIMEOUT` settlement, retry/backoff, budgets, `VerificationRunner`, daemon execution/cancel routes, CLI/Web UI, Docker/remote/MCP/browser/computer-use/sub-agent functionality, or a hard OS sandbox.
