# Run Cancellation Architecture

Phase 10A adds user-requested Run cancellation as a control-plane operation. The durable cancellation intent is the recovery authority; the in-memory execution scope is the live abort mechanism. There is no `CANCELLING` Run status.

```text
cancel(runId)
   │
   ├─ SQLite: first-writer-wins USER_REQUESTED intent
   ├─ RunExecutionScope.abort()
   ├─ AgentLoop → LLM / ToolBatch → Dispatcher → Handler → Runtime signal
   ├─ cancel pending approvals and Run-owned resources
   └─ atomic Run/State/Step/Continuation commit → CANCELLED
```

`RunController.cancel()` is deliberately outside the normal per-Run execution lock. It writes the intent first, aborts the active scope without waiting for a provider or Tool, waits for the active operation to unwind, and then reloads the latest snapshot. Normal `start`, `submitToolResults`, `resolveApproval`, and `recover` calls open one scope per Run and refuse new Agent work when an intent is already present.

The Protocol contract is JSON-safe and contains only `runId`, `cause=USER_REQUESTED`, and `requestedAt`. SQLite stores it in `run_cancellation_requests` with `run_id` as the primary key. A later request never replaces the first one, and the row is never deleted. The scope, `AbortController`, signal, runtime objects, process handles, credentials, Tool arguments, approval keys, and security facts remain host-only.

Cancellation settles from `PENDING`, `RUNNING`, `WAITING_APPROVAL`, or `VERIFYING`. A pending Run gets no AgentState, Step, provider call, Tool invocation, or conversation message. An active provider attempt produces a cancelled Step and increments `usage.steps` exactly once; an interrupted preparation produces no Step. Provider results arriving after abort are discarded, so no partial assistant message or `llm.completed` event is persisted.

The same signal is passed through the Core/LLM/Tool/Runtime host contracts. Tool batches check between items, so completed durable prefix invocations remain truthful and trailing calls do not start. Dispatcher/handler/runtime cancellation never becomes a model failure. Uncertain side effects remain uncertain. Patch commit and rollback are cancellation-deferred critical sections.

`LocalProcessManager.cancelOwnedByRun()` targets only entries whose exact `ownerRunId` matches, marks termination as `KILLED`, closes pipe/PTY adapters, removes the entries, and returns a confirmation summary. `rg` and Git child helpers terminate on abort. This is managed-process cleanup, not a claim of OS sandboxing or an unconditional process-tree guarantee.

Pending approvals transition to `CANCELLED` in their existing transaction and emit the existing `approval.resolved` event. Already resolved approvals are untouched. A successful cancellation emits exactly one `status.changed` transition and one `run.cancelled` event; it clears continuation state and appends no synthetic conversation message. Recovery gives durable cancellation priority over stale Steps, approvals, Tool continuations, and verification candidates, and never resumes Agent work for an intent-marked Run.

## Phase 10B deadline interaction

Phase 10B uses the same `RunExecutionScope` and signal fan-out, but has a distinct authority. A user cancellation is durable `USER_REQUESTED` intent and settles as `CANCELLED`; a deadline is an ephemeral `DEADLINE_EXCEEDED` abort cause derived from `startedAt + timeoutMs` and settles as `TIMEOUT`. The cause is Core-only and is never written to the durable cancellation contract. The first in-memory cause wins, while the durable cancellation intent remains the priority when both are observed during settlement.

Timeout follows the same resource cleanup boundary as cancellation, but owns its own `status.changed` plus `run.timed_out` event pair and returns `TIMEOUT_PENDING` when cleanup is not yet confirmed. See [Run Deadline and Timeout](timeout.md) for timer lifecycle, idle boundary behavior, Provider timeout separation, and restart recovery.

Phase 10A intentionally did not add retry/backoff, budgets, Verification execution, daemon cancellation routes, CLI/Web UI, remote/MCP/browser/computer-use runtimes, or a hard OS sandbox. Phase 10B added only the documented Run deadline and timeout recovery behavior; Phase 10C adds provider-only bounded retry while preserving this cancellation authority.

## Phase 10C retry interaction

An idle `WAITING_RETRY` boundary has no live execution Scope to abort. A user
cancellation first persists `USER_REQUESTED`, then disarms the retry registry;
the stale timer token cannot reopen the Run. If cancellation races a retry wake,
the controller reloads the durable intent before starting a new Provider Step,
so cancellation wins and no Tool or Provider call is replayed. An in-flight
Provider attempt still uses the existing Scope signal and settles its Step as
cancelled exactly once. Retryable Provider errors are never retried after an
abort has become the cancellation authority.
