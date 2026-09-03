# Execution Governance

Caelush has one lifecycle authority for cancellation, deadline, structural step exhaustion, budget, retry, and normal progression. Callers do not copy transition rules or infer completion from model text.

```text
terminal → cancellation → deadline → maxSteps → budget → retry → normal
```

Cancellation persists its first-writer-wins intent before aborting live work. A started Run deadline is the original `startedAt + timeoutMs`; it is never refreshed by retry, Tool execution, approval, or recovery. `maxSteps` remains a structural guard and produces `MAX_STEPS_REACHED` for legacy limits; Adaptive runs use their operational lease and explicit hard ceilings. The Resource Governor renews bounded operational leases, records progress fingerprints durably, injects a safe replan boundary for repeated no-progress batches, and moves to `WAITING_RESOURCE` after the configured replan pause threshold. Budget admission is performed before a Provider Step is durably created or a Tool handler starts. Retry is considered only after the current Provider attempt has settled in the budget ledger.

All durable changes are committed before live notification. Event sequence is the chronology authority. Terminal finalizers re-read the latest snapshot, give cancellation and deadline priority over a later budget observation, cancel pending approvals, clean owned resources, clear continuation, and commit the Run/State/Step/event projection together. If cleanup cannot be confirmed, the controller returns an explicit pending outcome and recovery performs cleanup only; it does not resume Agent work.

Provider adapters perform one Provider turn and never retry or execute Tools. The Gateway owns LLM call identity. Tool execution remains behind the Dispatcher and its immutable Registry. Runtime remains a replaceable execution substrate. A final model response is a verification candidate, not a completed Run.

`WAITING_RESOURCE` is a durable, cancellable recovery boundary. Its continuation retains the unexecuted Tool decision, while the public `resource.guard` event exposes only the no-progress reason and bounded counts. Continue uses the canonical Run action and may renew the operational lease, but cannot raise Enterprise hard limits, bypass Approval, or bypass Verification. Raw arguments, output, hashes, credentials, and provider reasoning never enter the guard projection.

Phase 11A adds an intent-only Verification boundary. A final candidate can enter `VERIFYING` only in the same atomic execution commit as its immutable VerificationPlan, ordered Checks, `AWAITING_VERIFICATION` continuation, and `verification.planned` event. The planner and evaluator are pure; no check executes in this round, and no path reaches `COMPLETED`. Recovery loads the existing plan and never replans it. See [Verification Architecture](verification.md).

Phase 11C keeps verification under the same governance authority. Workspace/Git inspection and the no-tools Task reviewer use injected ports and bounded evidence; reviewer LLM usage is recorded as `VERIFICATION_LLM` in the existing budget ledger. Phase 11D makes Core/RunController the only Completion Authority: a pass must survive candidate, workspace, Git, evidence, seal, revision, and cancellation guards before one atomic `COMPLETED` commit. Verification errors and repair exhaustion fail the Run; recovery never replays stale `RUNNING` checks. See [Verification Completion](verification-completion.md) and [Verification Recovery](verification-recovery.md).

Phase 10 is now sealed at 10A cancellation, 10B deadline/timeout, 10C bounded retry/backoff, and 10D budget enforcement and durable usage accounting. No additional Phase 10 round or later implementation is introduced here.
