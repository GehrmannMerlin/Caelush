# Phase 5B — Gate 3 Blocker Evidence

```text
Gate      3 — can a legacy ToolResult be legally backfilled?
Verdict   BLOCKED
Class     source-verified frozen-contract contradiction
```

This document records the exact contract, the exact missing historical facts, the exact row evidence
and the minimum contract decision. It contains no fabricated data and proposes none.

---

## 1. The question Gate 3 had to answer

```text
before backfilling a legacy role = "tool" row, prove that the facts
AgentToolResultMessage requires can be legally recovered
```

```text
AgentToolResultMessage {           Phase 5A, frozen
  type: "TOOL_RESULT"
  toolCallId
  toolName
  observationId        REQUIRED, non-optional
  isError
  projectedContent
  projection           REQUIRED receipt
}

ToolFeedbackProjectionReceipt {    Phase 5A, frozen
  policy: ToolObservationPolicySnapshot   REQUIRED
  fingerprint: string
  version: 1
}

ToolObservationPolicySnapshot {    Phase 3, frozen
  maxSingleObservationTokens: number   a real positive safe integer
  maxObservationBatchTokens: number    a real positive safe integer
}
```

Two facts have to be recoverable. **Neither is**, and each is independently sufficient to block.

---

## 2. Missing fact 1 — `observationId`

### 2.1 What the legacy row actually holds

`packages/llm/src/messages.ts`:

```ts
export const LLMToolResultMessageSchema = z
  .object({
    role: z.literal("tool"),
    toolCallId: z.string().min(1),
    toolName: ToolNameSchema,
    content: z.string(),
    isError: z.boolean(),
    rawArtifactRef: z.string().min(1).optional(),
  })
  .strict();
```

There is no `observationId`, no invocation id and no observation pointer of any kind. Only a model
`toolCallId`.

### 2.2 The recovery route, and where it breaks

The intended route is sound where it applies:

```text
agent_messages.source_step_id   +   legacy toolCallId
        ↓
tool_invocations WHERE run_id AND step_id AND external_call_id = toolCallId
        ↓   (unique index: tool_invocations_run_step_external_call_unique)
agent_observations WHERE tool_invocation_id = <that invocation>
        ↓   (unique index: agent_observations_tool_invocation_unique)
ObservationId
```

The join key really is preserved: `packages/core/src/agent-tool-batch.ts` writes
`externalCallId: message.toolCallId`, so `tool_invocations.external_call_id` is the model's own
`toolCallId`. Where both rows exist, exactly one match is provable.

The route fails in two independent ways.

### 2.3 Failure A — the tables did not always exist

```text
20260829090000_durable_runtime              CREATE TABLE agent_messages
20260829160000_tool_invocation_lifecycle    CREATE TABLE tool_invocations
20260829160000_tool_invocation_lifecycle    CREATE TABLE agent_observations
```

`agent_messages` predates `tool_invocations` and `agent_observations` by the same day's later
migration. Every `role = "tool"` row written before that migration has no invocation and no
observation, and none can be reconstructed: the fact was never recorded.

### 2.4 Failure B — an observation-less tool result is a reachable production state

This is the stronger finding, because it is not historical — it is reachable today, by design.

`packages/agent/src/run/ports/tool-turn.ts`:

```ts
/** One model-facing Tool result. */
export interface AgentToolResult {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly content: string;
  readonly isError: boolean;
}
```

`AgentToolResult` — the frozen Phase 3 Tool-turn result, and the shape the Run Layer commits — has
**no observation field at all**. Four production routes produce results that were never observed:

```text
1  pre-execution rejection       a call rejected before a handler ran creates NO ToolInvocation row
                                 and still reaches the model as safe feedback
2  uncertain-execution skip      every trailing call after an UNCERTAIN_SIDE_EFFECT receives a
                                 generic SKIPPED result and no observation
3  RESOURCE replan               packages/core/src/run-controller.ts:
                                   "A REPLAN writes no Tool invocation at all"
4  budget-exceeded completed     completedResults carried on the BUDGET_EXCEEDED arm
```

`ModelToolFeedbackProjector` turns each of those into one `AIToolResultMessage` per call, and
`completedToolTurnResult` / `replanResults` map them onto the frozen `AgentToolResult`. The Run
Layer's transition planner turns the result into `messagesToAppend`, and
`RunExecutionStore.commit()` writes that through `appendConversationMessagesInTransaction` into
`agent_messages`.

So a durable `role = "tool"` row with no reachable observation is **not an edge case**. It is the
normal, designed consequence of a Tool that never ran.

### 2.5 Why it cannot be worked around

```text
a random / synthetic ObservationId          fabricates execution truth for a row that never ran
"the first observation of the Step"         wrong-observation attribution; the Step may have many
toolName-only matching                      ambiguous the moment a Step calls one Tool twice
array-position guess                        no durable ordering guarantees position correspondence
leaving observationId absent                the frozen contract requires it; decode fails
```

```text
ToolObservation = execution truth
```

An `ObservationId` that names no `agent_observations` row is a durable assertion that something
executed. Nothing in `AgentToolResultMessage` distinguishes a real observation from an invented one,
so a fabricated value would be indistinguishable from a true one forever. That is exactly the class
of corruption a versioned, append-only, replayable ledger exists to prevent.

---

## 3. Missing fact 2 — `projection.policy`

### 3.1 Where the policy actually lives

`ToolObservationPolicySnapshot` **is** durably recorded — but once per _Run continuation_, never per
message.

`packages/core/src/run-controller.ts`:

```text
The observationPolicy that travelled with this turn's PreparedModelContext ...
a non-Tool-requesting effect, or a checkpoint that already carries a policy, is returned unchanged
```

It is attached to the `WAITING_TOOL_RESULTS` continuation checkpoint when a Tool boundary opens
(`observationPolicyProvenance`, and `ToolObservationPolicySnapshotSchema` on
`WaitingToolResultsContinuationSchema`).

`agent_run_continuations` is keyed `runId PRIMARY KEY` — **one row per Run**. The lifecycle is:

```text
turn N asks for tools   → checkpoint = WAITING_TOOL_RESULTS + policy P
tools settle            → results committed, continuation advances
turn N+1 asks for tools → checkpoint = WAITING_TOOL_RESULTS + policy P'   (the single row is replaced)
run completes           → the row holds the last continuation, or none
```

### 3.2 Why that is not the historical value

For any settled historical tool row, the checkpoint that carried its policy has been replaced. The
only surviving value is the Run's _current_ checkpoint policy, which is a statement about the newest
Tool boundary — not about the boundary that produced this row.

```text
using the current continuation policy as the row's historical policy   asserts a fact about a
                                                                       boundary it did not govern
using today's default policy                                          asserts that history matches
                                                                       today's configuration
using 0/0, or the maximum limits                                      is a fabricated policy
```

All four are the same error: manufacturing a historical fact from present configuration. The
`schema.ts` comment on `maxSingleObservationTokens` is explicit that these are real bounds that shaped
what the model was shown; inventing them would make the migration an author of model-visible history.

### 3.3 Why the Freeze's `LEGACY_UNKNOWN` cannot rescue it

The Freeze permits a `LEGACY_UNKNOWN` _internal migration representation_. That intent is sound and
Phase 5B endorses it. It cannot be expressed in the Phase 5A contract:

```ts
policy: ToolObservationPolicySnapshot; // required
// and that type is exactly two required positive safe integers
```

There is no optional arm, no `unknown` discriminant, and no third message type. Expressing it would
mean either

```text
widening ToolFeedbackProjectionReceipt.policy            a frozen Phase 5A contract change
adding a LEGACY_UNKNOWN discriminant to the policy        a Phase 3 contract change
making policy optional                                   a frozen Phase 5A contract change
```

each of which is a contract decision reserved to the architecture owner, not a migration decision this
round may take. §6 states the minimum such decision.

---

## 4. What _is_ legally recoverable, so the record is complete

```text
recoverable and exact
  messageId            deterministic from (runId, sequence), clock-free
  conversationTurnId   createDeterministicConversationTurnIdFactory().forRun(runId)
  runId, sequence      the legacy row itself
  sessionId            agent_runs.session_id
  createdAt            agent_messages.created_at_ms
  sourceStepId         agent_messages.source_step_id, validated to belong to the Run
  messageType          role: user → USER, assistant → ASSISTANT, tool → TOOL_RESULT
  audience             the Phase 5A per-kind defaults
  source               LEGACY / user | LEGACY / assistant | LEGACY / tool
  projectedContent     the legacy content string, byte for byte
  fingerprint          computable over that exact durable content
  schemaVersion        1, the only codec version registered for these types

recoverable ONLY when the Tool actually ran
  observationId        via (runId, stepId, externalCallId) → invocation → observation
                       PROVEN exactly-one, but NOT universally available (§2)

not recoverable from any durable source
  projection.policy    the per-row historical observation policy (§3)

already correct and requiring no recovery
  model.kind           LEGACY_MODEL_TURN; never promoted to MODEL_TURN
  content order        the legacy assistant parts are preserved in order
```

User and assistant rows therefore migrate faithfully and completely today. Only `role = "tool"` rows
are affected, and only for the two facts above.

---

## 5. Affected row classes

```text
class                                              observationId     policy        verdict
--------------------------------------------------------------------------------------------
tool row written before 20260829160000             unrecoverable     unrecoverable BLOCKED
tool row for a rejected call (no handler ran)      unrecoverable     unrecoverable BLOCKED
tool row for a SKIPPED trailing call               unrecoverable     unrecoverable BLOCKED
tool row for a RESOURCE replan synthetic result    unrecoverable     unrecoverable BLOCKED
tool row for a budget-exceeded completed result    unrecoverable     unrecoverable BLOCKED
tool row whose invocation AND observation exist    provable          unrecoverable BLOCKED
--------------------------------------------------------------------------------------------
user row                                           n/a               n/a           migratable
assistant row                                      n/a               n/a           migratable
```

Every class of tool row is blocked, because the policy is unrecoverable for all of them. The
observationId is additionally unrecoverable for five of the six.

---

## 6. Minimum contract decision required

One of the following, decided by the architecture owner. Any is sufficient; the first is smallest.

```text
Option 1 — express "unknown policy" in the receipt
  Let ToolFeedbackProjectionReceipt carry an explicit unknown state, for example
      policy: ToolObservationPolicySnapshot | { readonly kind: "LEGACY_UNKNOWN" }
  or  legacyUnknownPolicy: true with policy absent.
  This is the Freeze's own LEGACY_UNKNOWN intent, given a legal Phase 5A spelling.
  It fixes the policy half for every tool row.

Option 2 — express "no observation" for a Tool result that never executed
  Let observationId be absent or carry an explicit NO_OBSERVATION arm, so a result for a call
  that was rejected, skipped or replanned is representable without inventing an execution.
  This is the honest shape: the frozen AgentToolResult already has no observationId, so the
  Tool layer is already expressing exactly this.

Option 3 — a dedicated legacy message type
  Permit the migration to emit a record whose messageType is migration-only, carrying the
  legacy five fields (toolCallId, toolName, content, isError, rawArtifactRef) and an explicit
  provenance marking, instead of a TOOL_RESULT.
  Requires the Freeze to admit a non-canonical messageType for migrated rows.
```

```text
Options 1 and 2 are both required for a complete backfill.
Option 3 substitutes for both for legacy rows only.
```

### 6.1 What is NOT an acceptable resolution

```text
a default policy constant                        fabricates a historical bound
0/0 or maximum limits                            fabricates a historical bound
reading the Run's current checkpoint policy      restates a present fact as a historical one
a synthetic or random ObservationId              fabricates execution truth
"first observation of the Step"                  wrong-observation attribution
toolName-only matching                           ambiguous for repeated calls
array-position matching                          no durable guarantee
deleting or skipping unprovable rows             loses durable conversation history
rewriting data_json to make it fit               destroys the compatibility surface 5C needs
widening a frozen contract inside a migration    a contract decision taken by the wrong round
```

### 6.2 Why this is a contract contradiction and not a migration bug

```text
a migration bug        the correct output exists and the code is wrong
this                   the correct output does not exist, because the required input fact was
                       never durably recorded, and the contract admits no way to say so
```

No amount of SQL, TypeScript, retry or transaction design recovers a fact that was never written. The
gap is in the contract's vocabulary, so the fix belongs in the contract.

---

## 7. Consequence for Phase 5B

```text
gate 1     RESOLVED      additive-column strategy; Stage A activation stays with 5C
gate 2     RESOLVED      v2_data_json alongside data_json; one authority per fact
gate 3     BLOCKED       no legal faithful TOOL_RESULT backfill
gate 4     RESOLVED      injected conversation run metadata reader
```

### 7.1 Why a partial backfill is not an acceptable fallback

Migrating only the rows that _can_ be represented is worse than not migrating, and the Phase 5A
contract proves it rather than merely suggesting it.

`AgentConversationValidator.validateModelVisibleToolStructure` requires that a model-visible assistant
message announcing a Tool call be answered by a model-visible Tool result before the conversation
moves past it. So a conversation backfilled in part becomes a conversation the target validator
**refuses**:

```text
ASSISTANT row   backfilled to a V2 record, model-visible, announcing call_1
TOOL row        left legacy-only because it cannot be represented
        ↓
loadSnapshot()  builds a turn whose model-visible Tool protocol is incomplete
        ↓
validate()      refuses it — the exact conversation history the repository holds becomes
                unreadable by the authority Phase 5A installed
```

A partial backfill therefore does not produce a smaller-but-valid result. It produces history that the
target authority rejects, and it would do so for every Run that ever called a Tool — which is every
Run that did any work.

```text
conclusion   partial backfill is not a legal fallback for Gate 3
             the tool-row representation must be decided before any backfill runs
```

Phase 5B's own Gate 3 text is explicit that this is the legitimate blocking condition:

```text
"如果源码 + frozen interfaces 证明 ... 则 Phase 5B BLOCKED
 这是合法 architecture contradiction"
```

```text
Phase 5B BLOCKED.
Phase 5C has not started.
```

No fabricated value was written, no frozen contract was widened, no existing row was modified, and no
migration was added. The repository is exactly as Phase 5A left it apart from this round's
documentation.
