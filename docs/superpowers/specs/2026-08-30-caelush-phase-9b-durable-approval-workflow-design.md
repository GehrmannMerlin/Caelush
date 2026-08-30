# Caelush Phase 9B Durable Approval Workflow — Design

## Goal

Add a durable, restart-safe approval workflow between the Phase 9A Security Gate and Tool handler execution. A policy decision of `REQUIRE_APPROVAL` must create one durable pending approval, stop the current batch, and allow an explicit resolution to resume the exact Tool boundary without replaying the LLM turn or executing a Tool more than once.

## Boundaries

- `@caelush/security` remains pure. It only returns `ALLOW`, `DENY`, or `REQUIRE_APPROVAL`; it does not read or write approvals.
- `@caelush/tools` owns approval-key derivation, Gate precedence, Dispatcher lifecycle integration, safe approval event construction, and the approval port contracts. It never imports Storage or SQLite.
- `@caelush/storage` owns the `approval_requests` table, repository codec/query behavior, lazy expiration, resolution transaction, and atomic creation alongside the waiting Tool invocation.
- `@caelush/core` owns the public `resolveApproval(runId, approvalId, resolution)` orchestration, canonical Run/AgentState transitions, continuation pointer validation, and Coordinator recovery.
- Daemon, CLI, Web, Runtime, LLM providers, command parsing, redaction, sandboxing, cancellation, retry, budgets, and Verification remain out of scope.

## Durable model

The Protocol `ApprovalRequest` is reused without adding provider/runtime/database types. Storage adds only `approval_requests` with `id` as primary key, unique `tool_invocation_id`, foreign keys to `agent_runs` and `tool_invocations`, indexed `run_id`, `status`, and `(run_id, approval_key)`, and JSON data containing the protocol entity. `approval_key` is host-internal and is never returned in Protocol payloads or user-visible events.

Approval identity is SHA-256 over a deterministic canonical JSON object containing the Tool name, canonical arguments, risk level, sorted required capabilities, runtime requirements, permission profile, and approval policy. The key excludes action/title text, events, provider/model information, and secrets beyond the already validated Tool arguments. A RUN grant matches only the same Run and exact key.

Approval creation is part of the ToolExecutionStore transaction: the Tool invocation transitions `REQUESTED → WAITING_APPROVAL`, the pending ApprovalRequest is inserted idempotently by its unique invocation identity, and `approval.requested` is appended before commit notification. The RunController then durably records the Run/State `WAITING_APPROVAL` boundary and continuation pointer.

The default pending TTL is 15 minutes. The clock is injected. There is no sweeper: repository reads, recovery, and resolution lazily convert an expired pending request to `EXPIRED` and append exactly one `approval.resolved` event. Resolution uses `BEGIN IMMEDIATE`; a repeated identical resolution is idempotent, a conflicting resolution is an explicit conflict, and an expired request cannot be approved.

## Lifecycle and recovery

Tool lifecycle transitions add `WAITING_APPROVAL → RUNNING` for an approved request and `WAITING_APPROVAL → FAILED` for reject/expire/cancel. Rejection is a model-safe `APPROVAL_REJECTED`, non-retryable, security-phase error with a durable Observation. A resolved approval is rechecked against the current Gate: `DENY` wins over any cached grant; `ALLOW` proceeds; `REQUIRE_APPROVAL` may proceed only when the durable approved request has the exact key and an applicable `ONCE`/`RUN` grant.

The Dispatcher recovers pending approvals as waiting, approved approvals by starting the exact waiting invocation, and rejected/expired/cancelled approvals as a failed Tool result. The batch coordinator stops only at the first pending approval; once that invocation produces a result, it continues trailing calls in source order. The RunController clears only the approval pointer, preserves the pending decision and already completed prefix, transitions Run/State back to `RUNNING` through the canonical state machine, and calls Coordinator recovery. It never starts a new provider turn for approval resolution.

Crash recovery follows the existing durable boundary rules: pending waiting requests stay waiting; approved waiting invocations resume; rejected/expired requests resume as Tool errors; uncertain `RUNNING` invocations remain fail-closed; terminal invocations and completed runs are never rerun.

## Transaction and notification order

All durable records and durable events are committed before `notifyCommitted`. Approval resolution commits the terminal Approval state and `approval.resolved` atomically. Tool start/settlement remains unchanged and continues to notify only after commit. EventBus replay remains the source of truth; no UI or route infers approval state from in-memory callbacks.

## Testing strategy

Use focused tests first for key canonicalization, lifecycle transitions, resolution schema, repository/migration behavior, atomic creation, idempotency/conflict/expiry, Gate precedence, Dispatcher recovery, batch continuation, and RunController resolution. Then run the complete package suite and repository quality checks. Existing Phase 9A behavior must remain unchanged for DENY, ALLOW, policy context validation, and safe event/error payloads.
