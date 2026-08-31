# Budget Architecture

Phase 10D adds bounded Tool-call, LLM-token, and estimated-cost governance. The durable authority is the `run_budget_entries` ledger; `AgentState.usage` is a reconciled projection and is never used as an independent admission counter.

## Reserve, execute, settle

Every externally effectful attempt follows this order:

```text
admission → durable RESERVED → durable IN_FLIGHT → external work → SETTLED/CONSERVATIVE
```

Ledger ownership is unique on `(run_id, kind, owner_id)`. LLM attempts use the Step ID as `owner_id`; Tool invocations use the Tool Invocation ID. `RESERVED` capacity is included in admission snapshots. `IN_FLIGHT` is never released after a crash: an unknown LLM attempt becomes `CONSERVATIVE`, and a stale running Tool becomes an uncertain side-effect boundary without rerun.

Security denial, invalid arguments, unavailable Tools, approval waiting or rejection, and handlers that never start consume zero Tool calls. A handler consumes one exactly at the durable start boundary, including ordinary errors, cancellation and uncertain execution. Tool batches preflight the executable segment before the first handler so a segment that cannot fit does not partially mutate the workspace.

## Token and cost dimensions

`maxTokens` is the canonical total-token budget across all Provider attempts, including retries and known failed usage. Cached-input and reasoning fields are subsets and are not added a second time. Missing or inconsistent usage is conservative rather than zero. Request admission uses a provider-independent estimator over the complete model request, including context, messages, Tool definitions, schemas and Tool results; the configured output allowance is clamped before the Provider call.

`maxCost` is external USD but is calculated internally as integer micro-USD with overflow-safe arithmetic and ceiling rounding. Pricing is an injected, versioned snapshot persisted with the reservation. No live pricing or billing API is consulted, and estimated cost is governance accounting rather than a billing guarantee. Without a safe estimator or required pricing snapshot, admission fails closed with `BUDGET_ENFORCEMENT_UNAVAILABLE` before the external call.

## Terminal governance

The canonical priority is terminal state, durable user cancellation, Run deadline, structural max steps, budget, retry, then normal execution. Budget exhaustion settles as `BUDGET_EXCEEDED`; it disarms retry/deadline timers, cancels approvals, cleans Run-owned resources, clears continuation, and atomically projects Run/State/Step and the durable events. Cleanup uncertainty returns `BUDGET_EXCEEDED_PENDING` from the controller and remains recoverable; it is not a Protocol Run status.

Successful finalization emits exactly one sanitized `budget.exceeded` and one `status.changed`, never `run.failed`, and never directly completes a final candidate. `VERIFYING` remains the final candidate boundary.

## Scope

Phase 10D does not add public budget routes or UI, live billing, Verification execution, `COMPLETED` transition, MCP, Browser, Computer Use, remote/Docker execution, hard sandboxing, or a new Phase 10 round.
