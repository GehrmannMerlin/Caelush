# Execution Governance

Caelush has one lifecycle authority for cancellation, deadline, structural step exhaustion, budget, retry, and normal progression. Callers do not copy transition rules or infer completion from model text.

```text
terminal → cancellation → deadline → maxSteps → budget → retry → normal
```

Cancellation persists its first-writer-wins intent before aborting live work. A started Run deadline is the original `startedAt + timeoutMs`; it is never refreshed by retry, Tool execution, approval, or recovery. `maxSteps` remains a structural guard and produces `MAX_STEPS_REACHED`. Budget admission is performed before a Provider Step is durably created or a Tool handler starts. Retry is considered only after the current Provider attempt has settled in the budget ledger.

All durable changes are committed before live notification. Event sequence is the chronology authority. Terminal finalizers re-read the latest snapshot, give cancellation and deadline priority over a later budget observation, cancel pending approvals, clean owned resources, clear continuation, and commit the Run/State/Step/event projection together. If cleanup cannot be confirmed, the controller returns an explicit pending outcome and recovery performs cleanup only; it does not resume Agent work.

Provider adapters perform one Provider turn and never retry or execute Tools. The Gateway owns LLM call identity. Tool execution remains behind the Dispatcher and its immutable Registry. Runtime remains a replaceable execution substrate. A final model response is a verification candidate, not a completed Run.

Phase 10 is now sealed at 10A cancellation, 10B deadline/timeout, 10C bounded retry/backoff, and 10D budget enforcement and durable usage accounting. No additional Phase 10 round or later implementation is introduced here.
