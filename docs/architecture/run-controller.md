# Run Controller and Durable Runtime

Phase 6C is the final Phase 6 round. Phase 7C extends the same controller with an injected `ToolBatchCoordinator` while preserving the existing local SQLite execution store and replayable EventBus. The controller owns Run lifecycle orchestration and batch boundaries; the AgentLoop, Tool Dispatcher, Runtime, Permission, and Verification each remain separate injected boundaries.

```text
RunController
     │
     ▼
Atomic Execution Store
     │
 ┌───┼───────────────┐
 ▼   ▼       ▼       ▼
Run State   Step   Messages
         Continuation
             │
             ▼
       Durable Events
             │
          COMMIT
             │
             ▼
        EventBus notify
```

## Database first, UI second

Every execution-boundary command produces one atomic commit containing the Run projection, optional State snapshot, Step writes, conversation append, continuation update, and durable lifecycle events. The transaction commits before `EventBus.notifyCommitted()` publishes to live subscribers. A missed live notification is therefore recoverable from durable replay; the UI never infers execution state from an uncommitted callback.

Durable event `sequence` is the canonical chronology and recovery cursor. It is ordered strictly before `timestamp`, which is metadata only. Replay uses an exclusive sequence cursor, and live notification never appends a second copy of an already committed event.

The SQLite execution store uses optimistic revision checks for State and Continuation updates. A stale writer receives a conflict and cannot silently overwrite a newer projection. A failure at the end of a multi-row commit rolls back Run, State, Step, Messages, Continuation, and Events together.

## Conversation versus synthetic context

The conversation ledger contains only real user, assistant, and external tool-result messages. The original user message starts a conversation group; an assistant tool-call message is associated with its Step; normalized Tool Results use the pending continuation Step; and a resumed assistant response uses its new Step. System prompts, project instructions, relevant-file references, and other synthetic context are built for the provider request but are never written to the ledger.

## Durable boundaries

`WAITING_TOOL_RESULTS` stores the validated pending decision, assistant model-turn metadata, and requested tool identities. `RunController.submitToolResults()` normalizes the external batch, durably accepts it, and only then resumes the next provider turn. An equal already accepted batch is idempotent while pending; a semantically different batch is rejected as a conflict.

`AWAITING_VERIFICATION` stores the final candidate decision, candidate text, assistant message, source Step, and model-turn metadata. Recovery returns the exact `candidateText` without calling the provider. The Run remains `VERIFYING`, `finalResult` remains absent, and no `run.completed` event is emitted: only a future Verification boundary may complete it.

If a process restarts with a stale `RUNNING` Step, recovery fails closed, marks that Step and Run as failed, clears the active Step, and does not resend the provider request. The known safe pre-provider boundary is resumable only when no active Step, continuation, or conversation append indicates that a provider turn was already started. This is local-host durable recovery, not distributed exactly-once execution: Phase 6C has no lease coordinator.

## Phase 7C Tool batch drive loop

After a provider turn produces a Tool-call decision, the controller stores the pending decision in a `WAITING_TOOL_RESULTS` Continuation and passes its requests to the injected `ToolBatchCoordinator`. The coordinator preflights the entire batch and dispatches items strictly in source order through the Dispatcher. The controller never calls a handler directly and never creates a second Tool catalog.

```text
AgentLoop one turn
        │ TOOL_CALLS_REQUESTED
        ▼
WAITING_TOOL_RESULTS checkpoint
        │
        ├─ execute/recover ordered ToolBatch
        │       ├─ COMPLETED → identity-check → receivedResults checkpoint
        │       └─ WAITING_APPROVAL → Run/State WAITING_APPROVAL boundary
        │
        └─ accepted receivedResults → AgentLoop.resumeWithToolResults()
                                      one provider turn
```

The complete batch is durably accepted before the resumed provider call. A restart after acceptance resumes directly from `receivedResults` and does not redispatch. A restart during a batch uses `recoverOrDispatch`: terminal Invocations are reused, a stale `RUNNING` Invocation becomes an uncertainty result, and all trailing calls are explicit skipped results. The controller then resumes only with the complete ordered result batch. An approval boundary remains paused because Phase 7 has no Approval resolution endpoint.

The controller returns `WAITING_APPROVAL` separately from `WAITING_TOOL_RESULTS`; the latter remains the manual caller boundary used when no coordinator is injected by legacy tests or a future host. Both statuses retain canonical Run/State invariants, and neither is a completion claim. Final candidates still stop at `VERIFYING`.

The controller does not retry providers, persistence, Tools, or Verification; it does not cancel Runs or verify a candidate. It coordinates Tools only by calling the injected batch port. Provider lifecycle metadata distinguishes `NOT_STARTED`, `FAILED`, and `COMPLETED`, so `llm.completed` is emitted only after a provider returned a result, including the model-output rejection path, and never for a provider exception.
