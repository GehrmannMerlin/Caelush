# Durable Approval Workflow

Phase 9B connects the pure Phase 9A Security Gate to a durable human approval boundary. Security still decides only `ALLOW`, `DENY`, or `REQUIRE_APPROVAL`; it never reads approval state, writes SQLite, executes a handler, or publishes an event.

## Ownership

```text
SecurityPolicyEvaluator / Gate
          │ decision
          ▼
ToolDispatcher ── exact approval key + invocation lifecycle
          │ injected ports
          ▼
Storage ApprovalRepository ── approval_requests + events
          ▲
          │ resolveApproval(runId, approvalId, resolution)
          │
RunController ── Run/State/Continuation boundary + Coordinator recovery
```

The only new durable entity is `approval_requests`. Its Protocol payload is JSON-safe and contains the safe title, reason, fact-driven redacted action descriptor, risk, scope, status, and timestamps. The SQLite `approval_key` is host-internal and is not part of the Protocol entity, model messages, or user-visible event payloads.

## Exact identity and grant semantics

The key is SHA-256 over canonical JSON containing `toolName`, canonical Tool arguments, `riskLevel`, sorted `requiredCapabilities`, `runtimeRequirements`, `permissionProfile`, and `approvalPolicy`. Presentation text, events, Provider/model identity, and raw secrets are excluded.

For every call the Dispatcher evaluates the current Gate first. Phase 9C input-aware policy is part of that current decision, so `DENY` is final even if an old grant exists. `ALLOW` executes immediately. Only `REQUIRE_APPROVAL` may query a grant, and only an APPROVED `RUN` grant for the same Run and exact key applies. An `ONCE` approval is bound to its original ToolInvocation and cannot authorize a later invocation. A grant never authorizes a different argument, Tool, policy, or Run. Redacted preview text never participates in the exact key.

## Creation and resolution

For a new required approval, one SQLite transaction writes the ToolInvocation transition `REQUESTED → WAITING_APPROVAL`, one PENDING ApprovalRequest protected by unique `tool_invocation_id`, and `approval.requested`. The transaction commits before live notification. The RunController then writes the Run/AgentState `WAITING_APPROVAL` status and a continuation pointer containing the `approvalId`, invocation identity, and untouched pending Tool decision. No handler runs and no trailing Tool call starts.

Resolution accepts exactly `APPROVE` with `ONCE`/`RUN` or `REJECT`. RUN is invalid when the request maximum scope is ONCE. Storage uses `BEGIN IMMEDIATE`: identical resolution is idempotent, a conflicting resolution is a conflict, and an expired pending approval cannot be approved. The terminal Approval state and `approval.resolved` are committed together.

Pending approvals have a default 15-minute TTL and an injected clock. There is no sweeper. Loading, recovery, or resolving a stale PENDING request lazily transitions it to EXPIRED and appends one resolved event.

## Resume and crash recovery

## Cancellation interaction

When a Run cancellation intent is present, the RunController cancels only still-pending approvals in the same durable approval boundary. Those requests become `CANCELLED` and emit the existing `approval.resolved` event; an already resolved approval is not rewritten. Approval resolution checks the Run intent before resuming the Tool continuation, so cancellation never resumes the LLM turn or trailing Tool calls. See [Run Cancellation](cancellation.md).

## Run deadline interaction

Approval TTL and Run deadline are separate clocks and separate authorities. Approval TTL lazily moves a stale PENDING request to `EXPIRED` and emits `approval.resolved`; it never extends `startedAt + limits.timeoutMs`. When the Run deadline wins while approval is pending, the Controller cancels the pending request, clears the Run continuation, and settles the Run as `TIMEOUT` with `run.timed_out`. An already resolved approval is not rewritten. After timeout, a late approval resolution is terminally rejected and cannot resume the Tool or LLM turn. See [Run Deadline and Timeout](timeout.md).

The RunController resolution method is locked per Run. It validates Run status, continuation approval pointer, Approval ownership, and ToolInvocation ownership; transitions Run and AgentState back to RUNNING through the canonical state machine; clears only the approval pointer; and invokes Coordinator recovery. It does not call the LLM.

The Coordinator re-enters the exact waiting Tool item. APPROVED starts that invocation once; REJECTED, EXPIRED, and CANCELLED produce a non-retryable `APPROVAL_REJECTED` Security-phase Tool Observation; then trailing calls continue in source order. Completed prefix calls are reused, and the pending LLM turn is resumed only after the complete result batch is durably accepted. A durable RUNNING invocation remains the existing uncertain-side-effect boundary and is never automatically rerun.

## Explicit non-goals

Phase 9B does not add OS sandboxing, cancellation, timeout, retry, budgets, Verification execution, CLI/Web approval UI, or a daemon route without a complete production composition root. Phase 9C adds the documented input-aware policy and high-confidence secret-safe projections; Phase 9D integrates logical/policy admission, sanitized child environments, helper hardening, and secure composition. Tool arguments are not encrypted at rest.
