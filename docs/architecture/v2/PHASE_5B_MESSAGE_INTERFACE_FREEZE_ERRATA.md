# Phase 5B — Message Interface Freeze Errata

```text
Errata     Message System V2 — Tool Result provenance and projection-policy provenance
Scope      Tool Result contracts only
Authority  supersedes the listed clauses, and nothing else
Status     ACCEPTED — resolves the Phase 5B Gate 3 blocker
```

---

## 1. Authority

This document is a **scoped authority layer** inside Phase 5B. It was created after the round correctly
halted at Gate 3, and it exists for exactly one reason: the frozen contract it corrects made a
statement about durable history that durable history does not support.

```text
1  the Phase 5B implementation prompt
2  PHASE_5B_MESSAGE_INTERFACE_FREEZE_ERRATA.md      ← this document
     only for the explicitly listed Tool Result contracts
3  the Message System V2 Interface Freeze
     every unaffected clause remains frozen
4  the Message System V2 Refactor Spec
5  PHASE_5_MESSAGE_SYSTEM_ROUND_PLAN.md
6  the Phase 5A frozen implementation
7  current source
```

```text
This errata is not a general unfreezing of the Message System.
```

The Message System V2 Interface Freeze and the Refactor Spec remain **externally supplied authorising
specifications** that are not present in the repository tree. No repository path is claimed for either.
This errata quotes them by clause intent rather than by committed text, because there is no committed
text to quote.

---

## 2. Reason

The blocker was recorded in
[PHASE_5B_MESSAGE_STORAGE_GATE3_BLOCKED_EVIDENCE.md](PHASE_5B_MESSAGE_STORAGE_GATE3_BLOCKED_EVIDENCE.md),
under the round's own Gate 3:

```text
before a legacy role = "tool" row can be backfilled, prove that the facts
AgentToolResultMessage requires can be legally recovered
```

The original frozen contract implied:

```text
every model-visible Tool Result necessarily corresponds to a ToolObservation
and necessarily knows the historical projection policy under which it was projected
```

**That implication is false**, and it is false for two independent reasons — one about _existing
durable history_, and one about _current Tool System V2 semantics_. The second is the stronger one,
because it means the implication is false for new messages too, not merely for old ones.

```text
this errata is NOT
  implementation convenience
  a shortcut around a migration problem
  a wish to store less

this errata IS
  the correction of a modelling defect that the frozen contract inherited by
  equating two different things:

      "a Tool Result reached the model"
      "a Tool executed and was observed"
```

---

## 3. Source evidence

### 3.1 Current Tool System V2 produces three outcome kinds

`packages/agent/src/tools/batch/batch-types.ts` — `ToolBatchItemOutcome`:

```text
OBSERVATION   a durable ToolObservation exists
REJECTED      a pre-execution refusal; no ToolInvocation and no ToolObservation is required
SKIPPED       a trailing call after an uncertain execution; no ToolObservation is required
```

### 3.2 All three project to a model-visible Tool Result

`packages/agent/src/tools/observation/model-feedback-projector.ts` turns **every** item — `OBSERVATION`,
`REJECTED` and `SKIPPED` — into exactly one `AIToolResultMessage` per original call, in original order.

```text
a model-visible Tool Result
is therefore NOT
always observation-backed
```

### 3.3 The Run Layer's own frozen Tool Result type has no observation field

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

This is the shape the Run Layer commits into the durable conversation. It carries no observation
identity, and it cannot: three of the five `ToolTurnResult` arms produce results for which no
invocation exists.

```text
AgentToolResult           has no observationId at all
AgentToolResultMessage    required one
```

Two contracts describing the same fact disagreed, and the durable message contract was the one making
a claim the Tool Layer never made.

### 3.4 Reachable production routes that produce observation-less results

```text
1  pre-execution rejection     a call refused before a handler ran creates NO ToolInvocation row
                               and still reaches the model as safe feedback
2  uncertain-execution skip    every trailing call after an UNCERTAIN_SIDE_EFFECT receives a
                               generic SKIPPED result and no observation
3  RESOURCE replan             core: "A REPLAN writes no Tool invocation at all"
4  budget-exceeded completed   completedResults carried on the BUDGET_EXCEEDED arm
```

### 3.5 The historical gap

```text
20260829090000_durable_runtime              CREATE TABLE agent_messages
20260829160000_tool_invocation_lifecycle    CREATE TABLE tool_invocations
20260829160000_tool_invocation_lifecycle    CREATE TABLE agent_observations
```

`agent_messages` predates `tool_invocations` and `agent_observations`. Every `role = "tool"` row
written before that migration has no invocation and no observation, and none can be reconstructed.

### 3.6 The historical policy was never recorded per message

`ToolObservationPolicySnapshot` is durably recorded **once per Run continuation**, never per message.
It is attached to the `WAITING_TOOL_RESULTS` checkpoint when a Tool boundary opens, and
`agent_run_continuations` is keyed `runId PRIMARY KEY` — one row per Run.

```text
turn N asks for tools    → checkpoint = WAITING_TOOL_RESULTS + policy P
tools settle             → results committed, continuation advances
turn N+1 asks for tools  → checkpoint = WAITING_TOOL_RESULTS + policy P'   (the row is replaced)
```

For any settled historical Tool row the checkpoint that governed it has been replaced. The surviving
value describes the **newest** Tool boundary, not the one that produced the row.

### 3.7 Why the Freeze's own `LEGACY_UNKNOWN` intent could not be expressed

The Freeze permits a `LEGACY_UNKNOWN` internal migration representation. Phase 5A's frozen type had no
room for it:

```ts
policy: ToolObservationPolicySnapshot; // two required positive safe integers
```

No optional arm, no unknown discriminant, no third message type. The intent was right and the
vocabulary was missing. This errata supplies the vocabulary.

### 3.8 Why approximation was refused

```text
a synthetic or random ObservationId    asserts an execution that never happened
a fake ToolObservation row             writes execution truth that does not exist
a default / 0-0 / maximum policy       asserts a historical bound that was never in force
the current checkpoint's policy        restates a present fact as a historical one
"first observation of the Step"        wrong-observation attribution
toolName-only or array-position match  ambiguous the moment a Step calls one Tool twice
```

Every one of those writes a fabricated fact into an **append-only, replayable** ledger, where a
fabricated value is indistinguishable from a true one forever. That is the corruption a versioned
ledger exists to prevent, so the fix belongs in the contract rather than in the migration.

---

## 4. Affected contracts

```text
superseded by this errata
  AgentMessageSource TOOL arm                       drops the duplicated observationId
  AgentToolResultMessage observation linkage        observationId → ToolResultObservationRef
  ToolFeedbackProjectionReceipt policy              ToolObservationPolicySnapshot → ToolFeedbackProjectionPolicy
  AgentMessageFactory.createToolResult() invariants accepts NO_OBSERVATION, refuses LEGACY_UNKNOWN
  TOOL_RESULT V1 codec payload                      observationId → observation; policy union
  TOOL_RESULT V1 projector                          documentation and invariant only
  AgentConversationValidator Tool linkage           unchanged behaviour, restated against the new shape
  ExecutionUnit tool-result linkage                 by message identity and toolCallId, never observation
  message-domain barrel and package root exports    the two new frozen names
```

## 5. Supersede scope

```text
This errata supersedes only the Message System V2
contracts governing Tool Result provenance and
projection-policy provenance:

  - AgentMessageSource TOOL arm
  - AgentToolResultMessage observation linkage
  - ToolFeedbackProjectionReceipt policy representation
  - Tool Result factory invariants
  - related standard codec/projector validation

All unrelated Message System V2 frozen contracts remain unchanged.
```

## 6. Contracts deliberately NOT affected

```text
AgentMessageId                          unchanged
ConversationTurnId                      unchanged
ConversationTurnIdFactory               unchanged
AgentMessageAudience                    unchanged
AgentUserMessage / USER content         unchanged
AgentAssistantMessage / ASSISTANT       unchanged
AgentAssistantModelProvenance           unchanged
AgentMessageBase fields                 unchanged — still no sequence
AgentMessageRecord envelope             unchanged
AgentMessageDraft / StoredAgentMessage  unchanged
Codec Registry architecture             unchanged
Projector Registry architecture         unchanged
ConversationTurn                        unchanged
AgentConversationSnapshot               unchanged
ExecutionUnit identity and grouping     unchanged
ConversationSelector                    unchanged
TokenEstimator port                     unchanged
AgentMessageProjectionError surface     unchanged
```

---

## 7. Old contracts

```ts
// AgentMessageSource, TOOL arm — observationId duplicated the message body
{
  readonly kind: "TOOL";
  readonly observationId: ObservationId;
}

// ToolFeedbackProjectionReceipt — a real snapshot was mandatory
export interface ToolFeedbackProjectionReceipt {
  readonly policy: ToolObservationPolicySnapshot;
  readonly fingerprint: string;
  readonly version: 1;
}

// AgentToolResultMessage — a real observation was mandatory
export interface AgentToolResultMessage extends AgentMessageBase {
  readonly type: "TOOL_RESULT";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly observationId: ObservationId;
  readonly isError: boolean;
  readonly projectedContent: string;
  readonly projection: ToolFeedbackProjectionReceipt;
}
```

```text
TOOL_RESULT v1 codec payload
  { toolCallId, toolName, observationId, isError, projectedContent, projection }
```

---

## 8. Corrected contracts

### 8.1 `ToolResultObservationRef` — new frozen contract

```ts
export type ToolResultObservationRef =
  | {
      readonly kind: "OBSERVATION";

      readonly observationId: ObservationId;
    }
  | {
      readonly kind: "NO_OBSERVATION";
    };
```

### 8.2 `ToolFeedbackProjectionPolicy` — new frozen contract

```ts
export type ToolFeedbackProjectionPolicy =
  | {
      readonly kind: "SNAPSHOT";

      readonly snapshot: ToolObservationPolicySnapshot;
    }
  | {
      readonly kind: "LEGACY_UNKNOWN";
    };
```

### 8.3 `AgentMessageSource` TOOL arm

```ts
{
  readonly kind: "TOOL";
}
```

### 8.4 `ToolFeedbackProjectionReceipt`

```ts
export interface ToolFeedbackProjectionReceipt {
  readonly policy: ToolFeedbackProjectionPolicy;
  readonly fingerprint: string;
  readonly version: 1;
}
```

### 8.5 `AgentToolResultMessage`

```ts
export interface AgentToolResultMessage extends AgentMessageBase {
  readonly type: "TOOL_RESULT";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly observation: ToolResultObservationRef;
  readonly isError: boolean;
  readonly projectedContent: string;
  readonly projection: ToolFeedbackProjectionReceipt;
}
```

### 8.6 `TOOL_RESULT` v1 codec payload

```text
{ toolCallId, toolName, observation, isError, projectedContent, projection }
```

---

## 9. Behavioral invariants

### 9.1 Observation semantics

```text
OBSERVATION       a real ToolObservation execution truth exists and is identified
NO_OBSERVATION    this model-visible Tool feedback has no ToolObservation by design
```

### 9.2 `NO_OBSERVATION` is a domain fact, not a failure state

```text
NO_OBSERVATION  !=  UNKNOWN_OBSERVATION_ID
NO_OBSERVATION  !=  NOT_LOADED
NO_OBSERVATION  !=  MIGRATION_FAILURE
NO_OBSERVATION  !=  "we forgot to populate it"
```

It is a **valid, terminal domain fact**: the feedback was produced by a path for which no execution
observation exists. It is never repaired, never re-derived and never replaced.

### 9.3 Policy semantics

```text
SNAPSHOT          the real projection policy was known when this Tool Result Message was created
                  and has been recorded
LEGACY_UNKNOWN    the historical durable row preserved the projectedContent the model actually saw,
                  but did not preserve the per-row projection policy, so the policy is not
                  recoverable today
```

```text
LEGACY_UNKNOWN is NOT  a default
LEGACY_UNKNOWN is NOT  the current policy
LEGACY_UNKNOWN is NOT  0 / 0
LEGACY_UNKNOWN is NOT  the latest or nearest continuation checkpoint
```

### 9.4 `LEGACY_UNKNOWN` is migration-only

```text
AgentMessageFactory.createToolResult()   REFUSES LEGACY_UNKNOWN
migration codec / migration-only factory ALLOWS it
```

A normal producer must not be able to create an unknown policy by accident. The refusal is structural,
not advisory.

### 9.5 The four canonical Tool Result states

```text
A  new observation-backed feedback     observation = OBSERVATION { id }   policy = SNAPSHOT
B  new non-observation feedback        observation = NO_OBSERVATION       policy = SNAPSHOT
C  legacy row, observation recoverable observation = OBSERVATION { id }   policy = LEGACY_UNKNOWN
D  legacy row, no observation          observation = NO_OBSERVATION       policy = LEGACY_UNKNOWN
```

All four are legal. There is no fifth: `NO_OBSERVATION + LEGACY_UNKNOWN` and _new_` + LEGACY_UNKNOWN`
are respectively state D and a refusal.

### 9.6 Single observation authority

After this errata `ObservationId` appears in exactly one place on a Tool Result Message:

```text
AgentToolResultMessage.observation
```

It no longer appears in `source`, so `A != B` double-authority is impossible by construction.

`source` answers _who produced this message_; `observation` answers _does execution evidence exist_.
The two responsibilities do not overlap.

### 9.7 Recover when provable

```text
if exactly one valid Observation is provable    the migration MUST record OBSERVATION
if zero valid Observations are provable         NO_OBSERVATION
if more than one is possible                    FAIL CLOSED — ambiguous evidence is not
                                                evidence of absence
```

A migration must not take the cheaper `NO_OBSERVATION` arm when a real observation is provable.

### 9.8 `ToolObservation` authority is not weakened

```text
For observation-backed feedback:
  ToolObservation          = execution truth
  AgentToolResultMessage   = historical model-visible truth
  both must exist.

For non-observation feedback:
  no ToolObservation exists.
  AgentToolResultMessage   = historical model-visible truth.
```

A Tool that actually executed and was durably observed still must persist a real `ToolObservation`.
This errata only removes the requirement to **manufacture** an observation for feedback that has no
execution behind it.

### 9.9 No synthetic ToolObservation, no sentinel ObservationId

```text
forbidden   SYNTHETIC_TOOL_OBSERVATION, NO_EXECUTION_OBSERVATION, or any synthetic
            ToolObservation variant
forbidden   ObservationId("none") / ObservationId("legacy") / ObservationId("synthetic")
```

An `ObservationId` continues to mean exactly one thing: an `agent_observations` row exists.

### 9.10 Tool linkage does not depend on observation existence

```text
Conversation Validator   a Tool Call is answered when a model-visible ToolResult names its
                         toolCallId and toolName — never when it names an ObservationId
ExecutionUnit            a Tool Result closes a unit by message identity and toolCallId —
                         never by observation existence
```

So a `REJECTED` or `SKIPPED` result closes a Tool Call exactly as an observed one does, which is what
the Tool System already relies on.

### 9.11 AI projection is unaffected by both unions

```text
ToolResult projector   projectedContent → AIToolResultMessage.content, verbatim, always
LEGACY_UNKNOWN         does NOT change the model-visible content
LEGACY_UNKNOWN         does NOT fail the projection
NO_OBSERVATION         does NOT change the model-visible content
```

Historical model replay is therefore identical whether the policy is known or not — which is exactly
why recording the unknown honestly is safe.

### 9.12 Fingerprint semantics

```text
fingerprint = a canonical digest over the model-visible projected result
```

It is **not** a digest over policy metadata. A legacy row's fingerprint is computed deterministically
from its exact historical `content`, so a migrated row reproduces the same model-visible shape.

### 9.13 Projection policy unknown is not projection version unknown

```text
ToolFeedbackProjectionPolicy.LEGACY_UNKNOWN   "the historical truncation policy is unknown"

modelProjectionVersion                        STILL REQUIRED, still exact, still fail-closed
                                              it selects which AgentToolResult → AI ToolResult
                                              projector rebuilds the same canonical shape
```

Every `audience.model = true` message still records `modelProjectionVersion`, and an unavailable
projection version still fails closed. The two unknowns are different questions and must never be
conflated.

### 9.14 Factory invariants

```text
createToolResult() REQUIRES  source.kind === "TOOL"
createToolResult() REQUIRES  projection.policy.kind === "SNAPSHOT"
createToolResult() ACCEPTS   observation.kind ∈ { OBSERVATION, NO_OBSERVATION }
createToolResult() REFUSES   projection.policy.kind === "LEGACY_UNKNOWN"
createToolResult() no longer relates source.observationId to the message, because source
                   does not carry one
```

---

## 10. Migration semantics

```text
legacy role = "tool" row
    ↓
projectedContent = the exact legacy content string, byte for byte
    ↓
observation:
    exactly one provable Observation            → OBSERVATION { observationId }
    zero provable Observations                  → NO_OBSERVATION
    more than one possible                      → FAIL CLOSED, no row written
    ↓
policy:
    per-row durable evidence exists             → SNAPSHOT (only when genuinely provable)
    otherwise                                   → LEGACY_UNKNOWN
    ↓
fingerprint = deterministic digest over the exact projectedContent
    ↓
TOOL_RESULT record
```

```text
never re-projected       the legacy content is history, not an input to a new projection
never truncated          migration is not a Context projection
never fabricated         no observation, no policy, no provenance is invented
never lost               an unprovable row is preserved, not deleted
```

`legacy` user rows map to `LEGACY / user` and legacy assistant rows to `LEGACY_MODEL_TURN`; neither
is promoted to a stronger claim, and neither gains a model, finish reason or usage it never had.

---

## 11. Production semantics

```text
new executed Tool feedback        observation = OBSERVATION,   policy = SNAPSHOT
new rejected / skipped feedback   observation = NO_OBSERVATION, policy = SNAPSHOT
```

Both are representable **today**, before Phase 5C, which is the point: Phase 5C will not need a second
Message shape change to carry `REJECTED` and `SKIPPED` feedback, because the corrected contract already
expresses it.

```text
Phase 5B still does not cut over the production writer.
Phase 5C owns the Tool pipeline → AgentMessage writer wiring.
```

---

## 11A. Second scoped correction — `AgentMessageDraft` must carry the encoded payload

This section was added while implementing the storage round, and it is recorded as part of the same
scoped errata because it is the same class of defect: a Phase 5A contract shape that cannot express what
Phase 5B must do.

### 11A.1 The defect

Phase 5A's implementation decided what `AgentMessageDraft.message` means:

```ts
encode(message: AgentMessage): AgentMessageDraft {
  const data = codec.encode(message);          // the type-specific payload
  assertJsonSafePayload(data, message.type);   // proved JSON-safe…
  // …and then DISCARDED
  return Object.freeze({ message, schemaVersion: codec.currentVersion, modelProjectionVersion });
}
```

```text
draft.message              the semantic AgentMessage          (asserted by the Phase 5A suite)
the encoded payload        computed, validated, then dropped
```

So the draft carries **no bytes**. The frozen definition reads:

```ts
export interface AgentMessageDraft<TMessage extends AgentMessage = AgentMessage> {
  readonly message: TMessage;
  readonly schemaVersion: AgentMessageSchemaVersion;
  readonly modelProjectionVersion?: AgentMessageProjectionVersion;
}
```

### 11A.2 Why that blocks the storage round

```text
AgentConversationRepository.append(runId, drafts)
  must write AgentMessageRecord.data        the encoded payload
  must write AgentMessageRecord.schemaVersion   the version the payload was encoded at
  must NOT re-select a codec                 the draft already names its version
```

The repository cannot obtain the payload:

```text
re-encoding it                  forbidden — it would re-choose the version the draft already carries
reaching into the codec registry
  for a codec by draft version  possible, but it makes the repository a second encoder and it
                                re-does work the draft's producer already did
```

This is the same defect class as Gate 3: a contract that cannot carry a fact its own consumer requires.

### 11A.3 The correction

```ts
export interface AgentMessageDraft<TMessage extends AgentMessage = AgentMessage> {
  readonly message: TMessage;

  /** The codec's encoded payload: exactly what `AgentMessageRecord.data` must contain. */
  readonly data: JsonObject;

  readonly schemaVersion: AgentMessageSchemaVersion;

  readonly modelProjectionVersion?: AgentMessageProjectionVersion;
}
```

```text
added     `data` — the bytes the record stores
kept      `message` is still the semantic message, matching the Phase 5A suite
kept      schemaVersion and modelProjectionVersion unchanged
changed   `data` is REQUIRED, because a draft that cannot supply its payload cannot be appended
```

### 11A.4 Why this is a correction and not a new capability

The registry already computes and validates exactly this value; the correction stops it discarding a
result it has already proved correct. No new encoding happens, no version is re-selected, and the codec
registry remains the only encoder.

### 11A.5 Invariants after the correction

```text
draft.data is the payload of draft.message, encoded at draft.schemaVersion
the repository copies draft.data verbatim into AgentMessageRecord.data
neither the repository nor Storage ever re-encodes a message
```

---

## 12. Non-goals

```text
this errata does NOT
  unfreeze the Message System V2 in general
  add a second Tool Result message type (no LEGACY_TOOL_RESULT / MIGRATED_TOOL_RESULT)
  make observationId optional rather than discriminated
  add a synthetic ToolObservation variant
  add a sentinel ObservationId
  permit a fabricated or default projection policy
  change the ExecutionUnit identity model
  change the ConversationSelector
  change the AgentMessageRecord envelope
  bump TOOL_RESULT schemaVersion to 2
  bump the TOOL_RESULT projection version
  modify the Tool System contracts
  modify ToolBatchItemOutcome, ToolObservation, ToolInvocation or ToolTurnResult
  start Phase 5C
```

### 12.1 Why a second Tool Result message type is refused

```text
ConversationValidator, ExecutionUnit, AI Projection and Context replay would each have to
understand a second Tool-Call-closing message kind forever, and it would still not solve
the problem for NEW rejected and skipped feedback — which is precisely why no second type
is introduced.
```

### 12.2 Why `schemaVersion` stays 1

```text
Phase 5A shipped no durable Storage and no migration. A TOOL_RESULT v1 record has never been
written to any database, so v1 has never become an external persisted compatibility contract.
The correction therefore lands inside the pre-storage v1 contract rather than as a v2.
```

Source evidence: the Phase 5A report records that no migration was added, and the repository's
committed migration set is unchanged at 12.

### 12.3 Why the projection version stays 1

```text
The projection output did not change:
  toolCallId, toolName, content, isError are identical
Only receipt metadata changed, and projection version describes
  AgentMessage → AI model-visible form
not persistence payload metadata.
```

---

## 13. Tests

```text
contract          ToolResultObservationRef exact union
                  ToolFeedbackProjectionPolicy exact union
                  AgentMessageSource TOOL exact shape
                  AgentToolResultMessage exact corrected shape

four-state matrix A new executed        OBSERVATION    + SNAPSHOT
                  B new rejected/skipped NO_OBSERVATION + SNAPSHOT
                  C legacy + observation OBSERVATION    + LEGACY_UNKNOWN
                  D legacy, no observation NO_OBSERVATION + LEGACY_UNKNOWN
                  each verified through encode/decode, AI projection, fingerprint,
                  validator and ExecutionUnit

new feedback      REJECTED through the real ModelToolFeedbackProjector
                  SKIPPED through the real ModelToolFeedbackProjector
                  executed OBSERVATION path unbroken

migration         legacy executed row with an exact Observation
                  legacy rejected row with none
                  legacy skipped row with none
                  legacy row with the historical policy missing
                  legacy row with ambiguous Observation linkage → fails closed

negative          empty toolCallId / toolName
                  invalid observation kind
                  OBSERVATION without observationId
                  unknown policy kind
                  SNAPSHOT without a snapshot
                  new factory + LEGACY_UNKNOWN → refused

guard             only the affected contracts changed; USER, ASSISTANT, AgentMessageBase,
                  the record envelope, the codec registry and the projector registry are
                  asserted unchanged
```

---

## 14. Consequences for Phase 5C

```text
5C may now represent every Tool feedback outcome in the Message language:
  executed            → OBSERVATION    + SNAPSHOT
  rejected / skipped  → NO_OBSERVATION + SNAPSHOT

So 5C does not need to change the Message shape again. It changes the *writer*: the Run
execution path begins persisting AgentMessage records instead of AIMessage, and the Tool
pipeline begins producing them.

Nothing in this errata performs that cutover, and nothing in it pre-empts 5C's decisions
about the tool-turn commit, the Observation policy wiring, or the Run transaction.
```

---

## 15. Status

```text
Gate 3  INITIAL     frozen ToolResult required ObservationId + a policy snapshot
        BLOCKED     existing durable history and current Tool System semantics disproved it
        ERRATA      explicit observation provenance + explicit policy provenance
        RESOLVED    all four Tool Result states are representable
        IMPLEMENTED pending — Phase 5B resumes with the corrected contract
```

```text
This errata authorises the correction. It is not itself the completion of Phase 5B.
```
