# Run Controller and Durable Runtime

Phase 6C is the final Phase 6 round. It connects the resumable `AgentLoop` to a local SQLite execution store and a replayable EventBus. The controller owns Run lifecycle orchestration; Tool execution, Runtime, Permission, and Verification remain injected boundaries owned by later or separate packages.

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

The controller does not retry providers, persistence, Tools, or Verification; it does not cancel Runs, execute a Tool, or verify a candidate. Provider lifecycle metadata distinguishes `NOT_STARTED`, `FAILED`, and `COMPLETED`, so `llm.completed` is emitted only after a provider returned a result, including the model-output rejection path, and never for a provider exception.
