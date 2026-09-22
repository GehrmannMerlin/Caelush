# Phase 5A — Message Domain Foundation Report

```text
Phase  5A  Message Domain Foundation
State  COMPLETE
Next   Phase 5B has not started
```

---

## 1. Git record

```text
base SHA                     6cbdfce6671221ceb3422c9b2a8bad0b2e9102db   (Phase 4F final tip)
branch                       deepseek/architecture-v2-phase-5a-message-domain-foundation
remote                       origin/deepseek/architecture-v2-phase-5a-message-domain-foundation
```

The three heads are recorded separately, because they are three different things and collapsing them
would hide which commits carry code and which carry evidence.

```text
documentation head    the commit that wrote the round plan and the acceptance map,
                      produced before any production code was modified
implementation head   the last commit that changed production source
verification head     the last commit that changed tests, guards or verification evidence
final branch tip      the commit the branch is pushed at
```

Filled in at §9 once the branch was pushed.

### 1.1 Branch ancestry

The branch was created from the Phase 4F tip directly, and the Phase 4F history was neither rebased,
reset nor force-pushed.

```text
git merge-base --is-ancestor 6cbdfce6671221ceb3422c9b2a8bad0b2e9102db HEAD   → 0 (is an ancestor)
Phase 4F history                                                              intact
rebase / reset / force push of completed history                              none
```

---

## 2. What Phase 5A established

The round's objective was to make `AgentMessage != AIMessage` true **in code**, and to put the codec,
projection, conversation, execution-unit and selection semantics under the right package authority.
What exists now:

```text
AIMessage                     @caelush/ai      the model protocol language
AgentMessage                  @caelush/agent   the conversation language
AgentMessage Codec            @caelush/agent
AgentMessage → AIMessage      @caelush/agent
ConversationTurn              @caelush/agent
AgentConversationSnapshot     @caelush/agent
Conversation Validator        @caelush/agent
ExecutionUnit                 @caelush/agent
ConversationSelector          @caelush/agent
```

```text
StoredAgentMessage
        ↓  saved projection version
AgentMessageProjectorRegistry
        ↓
AIConversationMessage[]
```

The three layers are independently explicable, which is the test that they are three things rather
than one type under three names:

```text
AgentMessage          what actually happened in the conversation
AIMessage             what the model protocol allows to be shown
AgentMessageRecord    how one durable semantic message is versioned and recorded
```

### 2.1 Source layout

```text
packages/agent/src/messages/
├── canonical-json.ts                     key-sorted JSON and its digest
├── types/
│   ├── ids.ts                            AgentMessageId, ConversationTurnId, both factories
│   ├── audience.ts                       model / transcript / debug, and the three default triples
│   ├── source.ts                         the five provenance arms
│   ├── content.ts                        text, attachment reference, assistant tool call
│   ├── message-base.ts                   the eight frozen base members, no sequence
│   ├── user-message.ts
│   ├── assistant-message.ts              content, model provenance, providerState
│   ├── tool-result-message.ts            projectedContent and its projection receipt
│   ├── custom-agent-messages.ts          the empty declaration-merging seam
│   ├── agent-message.ts                  the union, with no SYSTEM arm
│   └── message-factory.ts                the single creation authority
├── persistence/record.ts                 record, stored, draft, record draft, opaque record
├── codec/
│   ├── codec.ts                          the codec contract and its closed refusal set
│   ├── standard-codecs.ts                USER v1, ASSISTANT v1, TOOL_RESULT v1
│   ├── registry.ts                       the versioned registry and the version authority seam
│   └── registry-builder.ts               one immutable generation
├── projection/
│   ├── projector.ts                      the projection result and fingerprint assembler
│   ├── standard-projectors.ts            USER v1, ASSISTANT v1, TOOL_RESULT v1
│   ├── registry.ts                       the model-visibility boundary
│   └── errors.ts                         the closed four-code failure surface
├── conversation/
│   ├── conversation-turn.ts              the turn view and its status derivation
│   ├── conversation-snapshot.ts          the session snapshot
│   ├── validator.ts                      the target Message V2 authority
│   ├── execution-unit.ts                 derived identity, grouping, the compaction invariant
│   ├── token-estimator.ts                the narrow projected-token port
│   └── selector.ts                       the safe selection primitive
└── index.ts                              the domain's own barrel
```

`packages/ai/src/messages/` gained exactly one file, `provider-state.ts`, and three additive edits.

---

## 3. Current → target

### 3.1 AI messages — what was reused, extended and aliased

```text
reused unchanged
  AISystemMessage, AIUserMessage, AIToolResultMessage, AIMessage
  JsonPrimitive, JsonObject, JsonValue, isJsonValue, isJsonObject
  ModelRef, AIFinishReason, ModelUsage
  assertAIMessage, assertAIMessages, assertAIAssistantContent, isAIAssistantContent

additive extension
  AIProviderOpaqueState + assertAIProviderOpaqueState + providerStateMatches
  AITextContent, AIToolCallContent, AIContent                    the canonical names
  AIConversationMessage + assertAIConversationMessage
  AIAssistantMessage.providerState                               optional, nothing else changed

compatibility alias
  AIAssistantTextContent      = AITextContent
  AIAssistantToolCallContent  = AIToolCallContent
  AIAssistantContent          = AIContent
  isAIAssistantContent / assertAIAssistantContent               one-line wrappers
```

**One declaration per shape.** The aliases are `export type` bindings, so there is no second
interface, no second validator and no second discriminant table. The wrappers are functions rather
than `const` aliases because TypeScript strips an assertion signature from a variable binding, which
would silently remove the narrowing every existing caller relies on.

**No second JSON vocabulary.** The Freeze names `AIJsonPrimitive` / `AIJsonValue` / `AIJsonObject`
and simultaneously requires an existing equivalent to be reused. Reuse won: the canonical
implementation stays single and the frozen names are not introduced as aliases either, because two
names for one shape invite a later reader to keep them in sync. Recorded as deviation D1.

**No second AI message implementation.** The round added one file and three edits.

### 3.2 Agent messages — what is new

```text
entirely new
  AgentMessage, AgentUserMessage, AgentAssistantMessage, AgentToolResultMessage
  AgentMessageId, ConversationTurnId, AgentMessageIdFactory, ConversationTurnIdFactory
  AgentMessageAudience, AgentMessageSource, AgentMessageBase
  AgentTextPart, AgentAttachmentRefPart, AgentAssistantTextPart, AgentAssistantToolCallPart
  AgentAssistantModelProvenance, ToolFeedbackProjectionReceipt
  CustomAgentMessages
  AgentMessageFactory
  AgentMessageRecord, StoredAgentMessage, AgentMessageDraft, AgentMessageRecordDraft,
    OpaqueAgentMessageRecord
  AgentMessageCodec, AgentMessageCodecRegistry, AgentMessageCodecRegistryBuilder,
    AgentMessageSchemaVersion, AgentMessageProjectionVersion
  AgentMessageAIProjection, AgentMessageProjector, AgentMessageProjectorRegistry,
    AgentMessageProjectionError
  ConversationTurn, ConversationTurnStatus, AgentConversationSnapshot,
    AgentConversationValidator
  ExecutionUnit
  TokenEstimator (port), ConversationSelector, SelectedAgentConversation

declared by import, never redeclared
  ModelRef, AIFinishReason, ModelUsage                 from @caelush/ai
  ToolObservationPolicySnapshot                        from the Agent Run/Loop layer
  RunId, SessionId, StepId, ObservationId, TimestampMs from @caelush/protocol
```

### 3.3 The old AI validator, and why it is still here

```text
packages/agent/src/loop/history/conversation-history.ts
  assertAgentTurnInput                    still called by the production AgentLoop
  assertPendingAssistantHistory           still called by the production AgentLoop
  assertConversationProtocolIntegrity     still called by the production AgentLoop
```

```text
AgentConversationValidator      the NEW authority — the target Message V2 question
AI history validator            the OLD one — temporary production compatibility
```

The old validator was **neither deleted nor extended**. Deleting it would break the loop that still
speaks `AIMessage`, and extending it would put a new rule in the compatibility layer where it would
never reach the target. It retires in 5C / 5D together with the language it validates. A Phase 5A
guard asserts it contains no Message Domain concept.

---

## 4. `modelProjectionVersion` authority — the round's central audit item

This is the one place where three frozen statements had to be satisfied together, so it is recorded
in full.

### 4.1 The three statements

```text
AgentMessageCodecRegistry.encode(message) → AgentMessageDraft
AgentMessageDraft carries modelProjectionVersion?
every new audience.model = true message must record its modelProjectionVersion
```

So `encode()` must know the current projector version **at encode time**. But the frozen
`AgentMessageCodecRegistry` interface has no field to carry one, and the target layout keeps
`type → projectorRegistry` wiring out of the persistence layer.

### 4.2 The resolution: the authority is injected

```ts
createAgentMessageCodecRegistry({ codecs, projectionVersionOf });
createAgentMessageCodecRegistryBuilder(projectionVersionOf);

type AgentMessageProjectionVersionResolver = (
  type: string,
) => AgentMessageProjectionVersion | undefined;
```

```text
the codec registry owns the RULE     a model-visible message records the current projector
                                     version, and cannot be encoded without one
the projector registry owns the VALUE  currentVersion(type), computed from what is registered
the composition root joins them      projectionVersionOf: (type) => projectors.currentVersion(type)
```

`createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type))` is the
production wiring and is what the Phase 5A tests exercise. Neither frozen interface changes, and no
layer has to hardcode a version.

### 4.3 The refused alternatives

```text
a hardcoded default of 1              a second authority over a version the projector owns
a literal scattered per codec         the same, in more places
letting Storage guess or default it   the writer would not be recording it at all; 5B would inherit
                                      the ambiguity with no way to detect it
calling a real projector to ask       a model projection is not a version lookup, and a projector
                                      has no such method
saving audience.model = true with
  an undefined version                the exact failure the field exists to prevent: a later
                                      projector would silently re-mean history
```

### 4.4 The fail-closed behaviour

```text
modelProjectionVersion is recorded      when audience.model = true and a resolver answers
modelProjectionVersion is absent        when audience.model = false — no model view exists, so
                                        recording a version would claim a projection that never
                                        happens
PROJECTION_VERSION_UNAVAILABLE          when audience.model = true and no resolver was injected,
                                        or the resolver has no version for the type
```

A registry built with no resolver therefore encodes a non-model-visible message normally and refuses
a model-visible one. It does **not** fall back to `1`.

### 4.5 Why Storage never guesses

```text
the version is decided where the projectors are, before the message is handed over
the store receives an AgentMessageDraft that already carries it
the store has nothing to infer, so it cannot infer it wrongly
```

Phase 5B's obligation is stated by the contract it receives: write `draft.modelProjectionVersion`
beside the row and read it back on decode. Nothing about the version is derivable from the schema
version or from the row's shape.

### 4.6 Why a model-visible message can never lack a version

```text
encode() cannot return a draft without one for audience.model = true   it throws instead
decode() reads the version from the stored row                          it never recomputes it
project() refuses a model-visible message with no version               PROJECTION_VERSION_UNAVAILABLE
project() selects the projector by that exact version                    never "the latest"
```

```text
PROJECTION_VERSION_UNAVAILABLE          the row has no version
UNKNOWN_MODEL_VISIBLE_MESSAGE           the row has a version no projector implements
```

The second is deliberately distinct from the first: a row written by a newer build must produce "I
cannot read this" rather than "this was never versioned", because only the second is corruption.

---

## 5. `TokenEstimator` boundary

### 5.1 Why the Agent Domain does not depend on `@caelush/context`

```text
@caelush/agent -X-> @caelush/context      the frozen dependency direction
@caelush/context owns Utf8HeuristicTokenEstimator
```

The Context package already answers "how many tokens is this text?" and it is the right answer. But
importing it would invert a boundary the whole migration exists to establish, so the Agent Domain
declares the narrowest port it can use and leaves the algorithm where it lives:

```ts
export interface TokenEstimator {
  estimateMessages(messages: readonly AIConversationMessage[]): number;
}
```

### 5.2 Why the port speaks projected AI rather than `AgentMessage`

```text
StoredAgentMessage → projector → AIConversationMessage[] → TokenEstimator → a number
```

The only honest answer to "how much of the model's budget does this cost?" comes from what the model
would actually receive. A port typed against `AgentMessage` would invite an implementation to
serialize the durable envelope — id, Run, session, turn, source, audience, schema version,
observation pointer — and count characters the model never sees, which would systematically
over-estimate and drop history that fits. A Phase 5A test proves two records differing only in those
fields cost the same.

### 5.3 How the Context estimator adapts, and what the Agent default is

```text
production    the composition root injects an adapter that projects through the registry and
              then applies the Context implementation to the projected text
fallback      STRUCTURAL_TOKEN_ESTIMATOR — a documented floor, not a second algorithm
```

`STRUCTURAL_TOKEN_ESTIMATOR` counts the UTF-8 bytes of the semantic text a projected message carries
and nothing else. It knows no Tool names, applies no head-plus-tail treatment and adds no per-message
constant for provider framing. Its doc comment states that a production host injects the Context
implementation, and an architecture guard asserts that the Agent default carries no Tool-specific
behaviour — which is what keeps it a floor rather than a silently degraded copy.

### 5.4 What the selector does with it

```text
selection measures the projection, never the message
audience.model = false contributes exactly zero and is never a drop candidate
a Tool result is measured only through its projected content; no observation is loaded
```

---

## 6. What Phase 5A does not do

```text
5A DOES NOT
  modify the agent_messages schema or add any migration
  switch RunExecutionStore, RunExecutionMessageAppend or its messagesToAppend shape
  switch AgentLoopAdvanceInput.history
  switch ContextPrepareInput.history or the Context Engine
  switch hydrateSessionTranscript or the Client transcript
  enable Coding custom messages or CodingCommandExecutionMessage
  delete legacy columns, backfill rows or retire LLMMessage ownership
  modify ToolCallPreparer, DurableToolExecutionCoordinator, ToolBatchCoordinator,
    ToolResultPipeline, ToolSettlementCoordinator or the Coding builtins
  modify RunController authority, CompletionGate, verification authority or Run terminal semantics
  change provider request semantics, Tool execution, Run execution, Context output,
    Client transcript or database schema
  add a second AI message implementation, a second JSON vocabulary, a second
    ToolObservationPolicySnapshot or a second Tool/Provider registry
  add a DB table, protocol field or storage dependency to @caelush/agent
```

Each of those is asserted by a Phase 5A architecture guard as well as stated here, so a later round
cannot quietly do one of them under this round's name.

---

## 7. Verification

Full results, including the parallel-versus-serial record and the inherited format baseline, are in
[PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md](PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md) §15.

```text
pnpm build                       PASS
pnpm typecheck                   PASS
pnpm lint                        PASS
pnpm check:architecture:ci       PASS — 26 baseline entries, 0 new, 0 stale, READY
pnpm exec vitest run             PASS — 452 files, 3263 passed, 5 skipped, 0 failed (112 s)
pnpm exec vitest run --maxWorkers=1
                                 PASS — 452 files, 3263 passed, 5 skipped, 0 failed (428 s)
changed-file Prettier            PASS — 38 of 38
git diff --check                 PASS
pnpm format:check                FAIL — 784 files, the inherited Phase 4F CRLF baseline
```

### 7.1 Phase 5A test files

```text
packages/ai/test/message-system-v2.test.ts                        20 tests
packages/agent/test/messages/message-domain.test.ts               46 tests
packages/agent/test/messages/codec.test.ts                        33 tests
packages/agent/test/messages/projection.test.ts                   36 tests
packages/agent/test/messages/validator.test.ts                    32 tests
packages/agent/test/messages/execution-unit.test.ts               26 tests
packages/agent/test/messages/selector.test.ts                     24 tests
packages/agent/test/messages/independent-use.test.ts               5 tests
tests/architecture/phase-5a-message-domain-boundaries.test.ts     56 tests
                                                                ─────────
                                                                 278 tests
```

### 7.2 Two findings the tests produced

Both were defects in the guard or the rule, and both were fixed rather than accommodated.

```text
F1  the validator's unanswered-call rule was wrong
    The first implementation required every announced model-visible tool call to be answered.
    That refuses a Run in the middle of a Tool batch — the normal state of a live Tool turn, and
    exactly the conversation a recovery has to load. The rule is positional: an unanswered call
    must be the trailing model-visible material of the turn, because a call the conversation
    moved past is the genuine violation. A second defect surfaced in the same test: the check ran
    only on the fall-through branch, so an assistant continuation skipped it entirely.
    Now: the check runs before each new model-visible message and before announcing a new batch.

F2  the architecture guard re-scanned the workspace per assertion
    7 timeouts under host parallelism, 0 in serial. Fixed by caching comment-stripped production
    source once — the discipline the Phase 4F guard already uses. 31 s → 0.6 s.
```

---

## 8. Compatibility

```text
production paths that still work, unchanged
  RunExecutionStore commits AIMessage through RunExecutionMessageAppend
  Storage owns the pre-V2 agent_messages table and its repository
  ContextEngine assembles AIMessage history for ContextPrepareInput
  AgentLoop validates AIMessage history with the legacy validator
  Client hydrates a run-based transcript
  CodingAgent composes no custom message

no global replace was performed
  LLMMessage → AgentMessage     not performed
  AIMessage → AgentMessage      not performed
```

Two existing architecture guards were amended, both narrowly, and both recorded as deviations D8 and
D9 in the acceptance map:

```text
Phase 3A   the clock rule, restated per file with exactly one named exception —
           packages/agent/src/messages/types/ids.ts, whose whole contract is minting a new
           identity. Host modules, Math.random and every other kernel file are unchanged.
Phase 2C   the frozen root export inventory, extended by 98 recorded names under a Phase 5A
           heading. Still asserted exactly; nothing removed, nothing can widen by accident.
```

---

## 9. Final git state

The three heads are fixed by the commit chain; the tip and remote are recorded after the push.

```text
base SHA                     6cbdfce6671221ceb3422c9b2a8bad0b2e9102db
documentation head           3d5c0a8  docs(architecture): freeze phase 5 message implementation rounds
implementation head          b55dc6a  feat(agent): add versioned message codecs and projection registry
verification head            recorded in §9.1
final branch tip             recorded in §9.1
remote branch tip            recorded in §9.1
```

### 9.1 Recorded after the push

```text
verification head   the commit that added the Phase 5A tests, the architecture guard and the
                    two narrow guard amendments
documentation head  the commit that wrote the round plan and the acceptance map, produced
                    before any production code was modified
final branch tip    the tip of deepseek/architecture-v2-phase-5a-message-domain-foundation
remote branch tip   origin/deepseek/architecture-v2-phase-5a-message-domain-foundation
ahead / behind      origin/deepseek/architecture-v2-phase-4f-tool-system-final-assembly
working tree        clean at the final tip
```

The measured values for those four rows are printed by the round's final `git` commands and reported
in the round's closing message rather than transcribed here, so this document never carries a hash
that could drift from the repository it describes.

---

```text
Phase 5A COMPLETE.

The Message System V2 domain foundation is established.

AgentMessage and AIMessage are now separate domain languages.

Versioned persistence codecs, model projectors, conversation validation, ExecutionUnit
identity, and projected conversation selection are implemented in @caelush/agent.

No database migration has started.
No production durable-conversation cutover has started.
No Context production cutover has started.
No Transcript/Client cutover has started.
Phase 5B has not started.
```
