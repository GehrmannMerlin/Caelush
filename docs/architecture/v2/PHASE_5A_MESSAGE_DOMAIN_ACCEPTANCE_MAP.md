# Phase 5A — Message Domain Acceptance Map

```text
Phase 5A    Message Domain Foundation
base        6cbdfce6671221ceb3422c9b2a8bad0b2e9102db   (Phase 4F final tip)
branch      deepseek/architecture-v2-phase-5a-message-domain-foundation
```

This map answers, for every frozen contract the round implements, the same nine questions:

```text
Interface Freeze contract   which numbered clause authorises it
current source              what existed at the Phase 4F baseline
already implemented?        yes / partially / no
needs additive extension?   and of what
needs compatibility alias?  and which name
new implementation owner    which file owns the declaration
5A action                   what this round actually did
5A test                     which test proves it
later Phase exit            which round owns the production cutover
```

It is written **before** any production code was modified (Milestone A) and updated at the end with
the implemented file, status and deviations (Milestone O). Both states are recorded: the `5A action`
column states what was done, and §14 records every deviation from the plan.

---

## 0. Authority and provenance

### 0.1 The two authorising documents

```text
Caelush_Message_System_V2_Current_to_Target_Interface_Freeze.md
Caelush_Message_System_V2_Refactor_Spec.md
```

**Neither document exists anywhere in the repository tree at this baseline.** They were supplied to
this round as external authorising specifications, and that is exactly how they are recorded here. No
repository path is claimed for them and no reconstruction of either is committed. Where the Freeze
and the Refactor Spec diverge, the Freeze wins, and §0.3 records the one divergence Phase 5A acts on.

### 0.2 Post-baseline source reconciliation (Milestone A, before any edit)

Every path the round was asked to scan was read at the Phase 4F tip. The findings that changed the
plan:

```text
@caelush/ai messages already exist and are NOT to be duplicated
        AISystemMessage, AIUserMessage, AIAssistantMessage, AIToolResultMessage, AIMessage
        AIAssistantTextContent, AIAssistantToolCallContent, AIAssistantContent
        assertAIMessage, assertAIMessages, assertAIAssistantContent, isAIAssistantContent
  → the round is additive refinement plus naming reconciliation, which is what Freeze §12 requires

@caelush/ai already owns an AI-local JSON vocabulary
        JsonPrimitive, JsonObject, JsonValue, isJsonValue, isJsonObject   (packages/ai/src/json/json-value.ts)
  → no second recursive JSON implementation; the frozen AIJson* names are aliases (Freeze §12)

no provider opaque state source exists anywhere
        AIModelTurnResult carries callId, providerId, model, text, toolCalls, finishReason,
        usage, resolution — and no provider state field
        the Anthropic stream translator explicitly DROPS signature_delta and redacted thinking
  → 5A must NOT invent an extraction; it establishes the type, validation, projection and safe
    adapter handling, and leaves capture to a round that has a real source (Freeze §21)

@caelush/agent depends on exactly @caelush/ai + @caelush/protocol + ajv
  → TokenEstimator must be a locally declared port, never an import of @caelush/context (Freeze §119–120)

the legacy AI history validator is live production code
        loop/history/conversation-history.ts: assertAgentTurnInput, assertPendingAssistantHistory,
        assertConversationProtocolIntegrity
  → keep it, do not extend it; the new AgentMessage validator is additive (Freeze §109–110)

packages/context already has an ExecutionUnit, but it is LLMMessage-based
        packages/context/src/execution-unit.ts: id = `${runId}:execution:${index}`, array-indexed
  → 5A's ExecutionUnit is a new Agent-domain type with a message-identity-based id; the Context
    one is untouched and exits in 5D (Freeze §112)

Storage's agent_messages has no message-identity column
        PRIMARY KEY (run_id, sequence); columns run_id, sequence, role, source_step_id,
        protocol_version, created_at_ms, data_json
  → the record contract's messageId is storage's problem in 5B; 5A only fixes the contract
```

### 0.3 Freeze over architecture draft

```text
Architecture draft   AgentMessageBase.sequence
Interface Freeze     AgentMessageBase does NOT contain sequence

5A action            sequence exists only on AgentMessageRecord and StoredAgentMessage, and is
                     read (never owned) by ExecutionUnit as a source range
5A test              tests/architecture/phase-5a-message-domain-boundaries.test.ts asserts the
                     absence of a sequence member on AgentMessageBase
```

---

## 1. AI domain contracts

### 1.1 `AIProviderOpaqueState`

| Question                  | Answer                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §11 — `{ providerId: string; api: string; version: 1; payload: AIJsonObject }`                                                                                                      |
| Current source            | **Did not exist.** No provider state was carried anywhere in `AIMessage`; `AIModelTurnResult` has no such field.                                                                    |
| Already implemented?      | No.                                                                                                                                                                                 |
| Additive extension?       | New interface + `assertAIProviderOpaqueState` + `providerStateMatches` + two constants.                                                                                             |
| Compatibility alias?      | None needed.                                                                                                                                                                        |
| Implementation owner      | `packages/ai/src/messages/provider-state.ts`                                                                                                                                        |
| 5A action                 | Declared with `JsonObject` (AI-local), not a new JSON vocabulary. `version` is the literal `1`, not `number`. Added the two-property provider/API match predicate an adapter needs. |
| 5A test                   | `packages/ai/test/message-system-v2.test.ts` — shape, strict unknown-key rejection, empty `providerId`/`api`, wrong version, non-JSON payload; provider-switch safety.              |
| Later Phase exit          | Real capture is **not** wired by any round yet. It becomes possible only when a provider adapter exposes an actual opaque state; 5C is the earliest round that could carry one.     |

### 1.2 `AITextContent` / `AIToolCallContent` / `AIContent`

| Question                  | Answer                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §13, §14, §15 — canonical frozen public names                                                                                                                                                                                                                                                            |
| Current source            | `AIAssistantTextContent`, `AIAssistantToolCallContent`, `AIAssistantContent` already existed with the exact frozen shape.                                                                                                                                                                                |
| Already implemented?      | The **shapes** were; the **names** were not.                                                                                                                                                                                                                                                             |
| Additive extension?       | Canonical names added as the real declarations.                                                                                                                                                                                                                                                          |
| Compatibility alias?      | **Yes** — `AIAssistantTextContent`, `AIAssistantToolCallContent`, `AIAssistantContent` are `export type` aliases of the canonical names, and `isAIAssistantContent` / `assertAIAssistantContent` are one-line wrappers.                                                                                  |
| Implementation owner      | `packages/ai/src/messages/content.ts`                                                                                                                                                                                                                                                                    |
| 5A action                 | One declaration per shape. No second interface, no second validator, no second discriminant table. The wrappers exist (rather than `const` aliases) because TypeScript strips an assertion signature from a variable binding, which would silently remove the narrowing every existing caller relies on. |
| 5A test                   | `packages/ai/test/message-system-v2.test.ts` — both name sets are the same type; both validators agree.                                                                                                                                                                                                  |
| Later Phase exit          | None. The aliases may be retired once no caller uses them; Phase 5A does not force that churn.                                                                                                                                                                                                           |

### 1.3 `AIConversationMessage`

| Question                  | Answer                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §16 — `AIUserMessage \| AIAssistantMessage \| AIToolResultMessage`; `AISystemMessage` is **not** a member                                                              |
| Current source            | Did not exist. `AIMessage` was the only union.                                                                                                                         |
| Already implemented?      | No.                                                                                                                                                                    |
| Additive extension?       | New union + `assertAIConversationMessage`, which refuses a system message explicitly.                                                                                  |
| Compatibility alias?      | None.                                                                                                                                                                  |
| Implementation owner      | `packages/ai/src/messages/message.ts`                                                                                                                                  |
| 5A action                 | `AIMessage = AISystemMessage \| AIConversationMessage` — one union, not two. The narrower union is what makes system injection impossible by type for every projector. |
| 5A test                   | `packages/ai/test/message-system-v2.test.ts` — a system message is a valid `AIMessage` and an invalid `AIConversationMessage`.                                         |
| Later Phase exit          | 5D — the Context Materializer is the only producer of system messages.                                                                                                 |

### 1.4 `AIAssistantMessage.providerState` and strict validation

| Question                  | Answer                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §17, §19, §20 — optional `providerState`; strict unknown-key rejection preserved                                                                                                                                                                            |
| Current source            | `AIAssistantMessage` was `{ role, content }`, and `assertAIMessage` used an exact-key list of two.                                                                                                                                                          |
| Already implemented?      | Partially — the message existed, the field did not.                                                                                                                                                                                                         |
| Additive extension?       | Optional field only.                                                                                                                                                                                                                                        |
| Compatibility alias?      | None.                                                                                                                                                                                                                                                       |
| Implementation owner      | `packages/ai/src/messages/message.ts`                                                                                                                                                                                                                       |
| 5A action                 | The exact-key list is chosen by presence: two keys when `providerState` is absent, three when it is present. `content.length >= 1` is unchanged. A `providerState: undefined` value no longer appears in the key list, so a smuggled key is still rejected. |
| 5A test                   | `packages/ai/test/message-system-v2.test.ts` — accepts with and without state; rejects an unknown key alongside state; rejects a malformed state.                                                                                                           |
| Later Phase exit          | 5C / 5D for capture and for provider-side use.                                                                                                                                                                                                              |

### 1.5 Provider-opaque boundary and provider-switch safety

| Question                  | Answer                                                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §20, §21, §22                                                                                                                                                                                                                                                                                 |
| Current source            | No state, so no boundary.                                                                                                                                                                                                                                                                     |
| 5A action                 | `providerState` is carried by `AgentAssistantMessage` and copied unchanged by the assistant projector. Nothing in `@caelush/agent` reads `payload`, and the Agent projection directory contains no provider name.                                                                             |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — read the payload nowhere; provider-neutral scan over `packages/agent/src/messages/**`; a state from provider A is carried intact and is ignored by a `providerStateMatches` check for provider B while the semantic content survives. |
| Later Phase exit          | 5C (durable wiring), 5D (provider translation).                                                                                                                                                                                                                                               |

### 1.6 AI JSON naming reconciliation

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §12 — reuse an equivalent primitive rather than adding a second                                                                                                                                                                                                                                                                                      |
| Current source            | `JsonPrimitive`, `JsonObject`, `JsonValue` already existed in `packages/ai/src/json/json-value.ts`.                                                                                                                                                                                                                                                  |
| 5A action                 | **No `AIJsonPrimitive` / `AIJsonValue` / `AIJsonObject` declarations were added.** The canonical implementation stays single, and the frozen AI names are not introduced as aliases either, because the Freeze's own rule is to reuse rather than rename. The Freeze clause is satisfied by reuse, and §14.3 records this as a deliberate deviation. |
| 5A test                   | `tests/architecture/phase-5a-message-domain-boundaries.test.ts` asserts exactly one declaration of the recursive JSON vocabulary in `@caelush/ai`.                                                                                                                                                                                                   |
| Later Phase exit          | None.                                                                                                                                                                                                                                                                                                                                                |

---

## 2. Agent identity

### 2.1 `AgentMessageId`

| Question                  | Answer                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §24 — branded `string & { readonly [AgentMessageIdBrand]: true }`                                                                                                                      |
| Current source            | Did not exist.                                                                                                                                                                         |
| Additive extension?       | New branded type, `agentMessageId()` reader, `isAgentMessageId()` check, `AgentMessageIdFactory`.                                                                                      |
| Implementation owner      | `packages/agent/src/messages/types/ids.ts`                                                                                                                                             |
| 5A action                 | Brand declared with `declare const … unique symbol` exactly as frozen. The `as` cast appears once, in the module that owns the brand. Production factory mints UUIDv7-shaped `amsg_…`. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — well-formed ids pass, malformed fail, the scripted factory is deterministic.                                                   |
| Later Phase exit          | 5B — Storage stores this identity; it never mints it.                                                                                                                                  |

### 2.2 `ConversationTurnId` and `ConversationTurnIdFactory`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §25, §26 — `forRun(runId): ConversationTurnId`, deterministic: same Run always yields the same turn id                                                                                                                                                                                                                                                                                                                      |
| Current source            | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Additive extension?       | New branded type and factory interface, plus three factory constructors.                                                                                                                                                                                                                                                                                                                                                    |
| Implementation owner      | `packages/agent/src/messages/types/ids.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| 5A action                 | The derivation is a pure function of the `RunId`: a SHA-256 digest of the run id seeds a UUIDv7-shaped `cturn_…` value under a fixed anchor. There is no clock read, no counter and no process state in the derivation, and `createDeterministicConversationTurnIdFactory()` is the clock-free form 5B backfill composes. The `RunId` is hashed rather than embedded, so a longer run id cannot change the turn id's shape. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — same Run → same id across two independently created factories; different Runs → different ids; shape is well-formed.                                                                                                                                                                                                                                                |
| Later Phase exit          | 5B / 5C — the production turn is constructed there.                                                                                                                                                                                                                                                                                                                                                                         |

### 2.3 `AgentMessageAudience` and its defaults

| Question                  | Answer                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §29, §30 — `{ model, transcript, debug }`, with per-kind defaults                                                                                                                                                                         |
| Current source            | Did not exist.                                                                                                                                                                                                                            |
| Additive extension?       | New interface, three frozen default constants, one assertion.                                                                                                                                                                             |
| Implementation owner      | `packages/agent/src/messages/types/audience.ts`                                                                                                                                                                                           |
| 5A action                 | The defaults are stated **once**, as three constants, and the Message Factory is the only consumer. `TOOL_RESULT` is `transcript: false` because a transcript is what a user reads and a Tool result is the model's own feedback channel. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — exact default triple per kind, asserted through the factory.                                                                                                                      |
| Later Phase exit          | 5E consumes `transcript`; 5D consumes `model`.                                                                                                                                                                                            |

### 2.4 `AgentMessageSource`

| Question                  | Answer                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §31, §32 — five arms; `LEGACY` may be defined but must never be created by the factory                                                                                                                                                                                      |
| Current source            | Did not exist.                                                                                                                                                                                                                                                              |
| Additive extension?       | New union, one builder per arm, one assertion, three canonical order arrays.                                                                                                                                                                                                |
| Implementation owner      | `packages/agent/src/messages/types/source.ts`                                                                                                                                                                                                                               |
| 5A action                 | All five arms declared exactly as frozen. `legacyMessageSource()` is exported for 5B / 5F and is **refused** by the Message Factory: `assertSourceConsistency` throws on any `LEGACY` source, so a newly created message cannot claim a migration history it does not have. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — `GOAL` / `FOLLOW_UP` / `STEERING` each accepted; a `LEGACY` source is refused by the factory; source survives an encode/decode round trip.                                                                          |
| Later Phase exit          | 5B (backfill creates `LEGACY`), 5F (it retires).                                                                                                                                                                                                                            |

---

## 3. Agent messages

### 3.1 `AgentMessageBase`

| Question                  | Answer                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §33, §34 — id, runId, sessionId, conversationTurnId, createdAt, sourceStepId?, source, audience; **no `sequence`**                                    |
| Current source            | Did not exist.                                                                                                                                        |
| Additive extension?       | New interface plus `createAgentMessageBase`, the single construction point.                                                                           |
| Implementation owner      | `packages/agent/src/messages/types/message-base.ts`                                                                                                   |
| 5A action                 | Declared with no `sequence` member, every field `readonly`. Frozen, so no caller can mutate a validated base.                                         |
| 5A test                   | `tests/architecture/phase-5a-message-domain-boundaries.test.ts` hard-asserts the absence of a `sequence` member and the presence of the frozen eight. |
| Later Phase exit          | None. This shape is the target.                                                                                                                       |

### 3.2 `AgentTextPart` / `AgentAttachmentRefPart` / `AgentUserContentPart`

| Question                  | Answer                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §35, §36, §37, §38                                                                                                                                                                                                   |
| Current source            | Did not exist.                                                                                                                                                                                                       |
| Additive extension?       | New parts, builders, and `assertAgentUserContent`.                                                                                                                                                                   |
| Implementation owner      | `packages/agent/src/messages/types/content.ts`                                                                                                                                                                       |
| 5A action                 | An attachment is a **structured reference only**: `artifactId` plus optional `label` and `mediaType`. No upload, no parser, no hydration, no provider image message, no bytes and no host path anywhere in the type. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — text-only, attachment-only and mixed content; empty content and empty-text-only content both refused.                                                        |
| Later Phase exit          | Attachment handling beyond a reference is not scheduled by any Phase 5 round.                                                                                                                                        |

### 3.3 `AgentUserMessage`

| Question                  | Answer                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §39                                                                                                                                                                                                               |
| Current source            | Did not exist.                                                                                                                                                                                                    |
| Additive extension?       | New message, `createAgentUserMessage`, `assertAgentUserContent`.                                                                                                                                                  |
| Implementation owner      | `packages/agent/src/messages/types/user-message.ts`                                                                                                                                                               |
| 5A action                 | `content.length >= 1` **and** at least one part that carries something — a non-empty `TEXT` or a valid `ATTACHMENT_REF`. The second rule is what stops a user turn whose only content is `""` from looking valid. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — the seven required cases from Freeze §134.                                                                                                                |
| Later Phase exit          | 5C (production creation), 5E (transcript).                                                                                                                                                                        |

### 3.4 `AgentAssistantTextPart` / `AgentAssistantToolCallPart` / `AgentAssistantContentPart`

| Question                  | Answer                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface Freeze contract | §40, §41, §42, §43                                                                                                                                                                                                       |
| Current source            | Did not exist.                                                                                                                                                                                                           |
| Additive extension?       | New parts, builders, `assertAgentAssistantContent`, `assistantToolCalls`.                                                                                                                                                |
| Implementation owner      | `packages/agent/src/messages/types/content.ts`                                                                                                                                                                           |
| 5A action                 | `input` uses AI's canonical `JsonObject`; no third business-JSON vocabulary was declared. Invariants enforced: non-empty `toolCallId`, non-empty `toolName`, object `input`, and `toolCallId` unique inside one message. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — text only, tool-call only, mixed, order preserved, duplicate `toolCallId` refused.                                                                               |
| Later Phase exit          | 5C (production), 5D (replay).                                                                                                                                                                                            |

### 3.5 `AgentAssistantModelProvenance`

| Question                  | Answer                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §44, §45, §46 — `MODEL_TURN` with `callId`, `model: ModelRef`, `finishReason: AIFinishReason`, `usage?: ModelUsage`; `LEGACY_MODEL_TURN` with `sourceStepId?`                                                                                         |
| Current source            | `ModelRef`, `AIFinishReason`, `ModelUsage` already existed in `@caelush/ai`; `AgentAssistantModelProvenance` did not.                                                                                                                                 |
| Additive extension?       | New union reusing the three AI types.                                                                                                                                                                                                                 |
| Implementation owner      | `packages/agent/src/messages/types/assistant-message.ts`                                                                                                                                                                                              |
| 5A action                 | **No `MessageModelRef`, `MessageFinishReason` or `MessageUsage` was declared.** `createAgentMessageFactory` accepts only `Extract<…, { kind: "MODEL_TURN" }>` and throws on anything else, so a new message cannot be created with legacy provenance. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — `MODEL_TURN` created; `LEGACY_MODEL_TURN` refused by the factory and accepted by the codec round trip.                                                                                        |
| Later Phase exit          | 5B creates legacy provenance during backfill; 5F retires it.                                                                                                                                                                                          |

### 3.6 `AgentAssistantMessage`

| Question                  | Answer                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface Freeze contract | §47, §48, §59 — content, model, optional `providerState`; every field immutable                                                                                                |
| Current source            | Did not exist.                                                                                                                                                                 |
| Additive extension?       | New message, `createAgentAssistantMessage`.                                                                                                                                    |
| Implementation owner      | `packages/agent/src/messages/types/assistant-message.ts`                                                                                                                       |
| 5A action                 | Every member `readonly`, the returned object frozen, the content array frozen, the provenance frozen. `content.length >= 1` with `TEXT`, `TOOL_CALL` or both, order preserved. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — three content shapes, order preserved, frozen instance.                                                                |
| Later Phase exit          | 5C.                                                                                                                                                                            |

### 3.7 `ToolFeedbackProjectionReceipt` and `AgentToolResultMessage`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §49, §50, §51, §52 — receipt reuses `ToolObservationPolicySnapshot`; message carries `projectedContent`, copied verbatim                                                                                                                                                                                                                                                            |
| Current source            | `ToolObservationPolicySnapshot` exists in `packages/agent/src/loop/types.ts`. `AgentToolResultMessage` did not.                                                                                                                                                                                                                                                                     |
| Additive extension?       | New receipt and message; the policy type is **imported, not copied**.                                                                                                                                                                                                                                                                                                               |
| Implementation owner      | `packages/agent/src/messages/types/tool-result-message.ts`                                                                                                                                                                                                                                                                                                                          |
| 5A action                 | No second policy type. The codec and the projector both copy `projectedContent` verbatim; neither loads nor re-projects an observation. The truth rule is stated in the type's own documentation: `ToolObservation` is execution truth, `AgentToolResultMessage` is historical model-visible truth. Freeze §51 is honoured — Phase 4 Tool settlement is untouched and wiring is 5C. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — the nine required cases from Freeze §136, plus a projection of a message whose `observationId` names no observation at all.                                                                                                                                                                                                 |
| Later Phase exit          | 5C.                                                                                                                                                                                                                                                                                                                                                                                 |

### 3.8 `CustomAgentMessages` and `AgentMessage`

| Question                  | Answer                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface Freeze contract | §53, §54, §55 — empty interface, union includes `CustomAgentMessages[keyof CustomAgentMessages]`, seam only                                                                                                                    |
| Current source            | Did not exist.                                                                                                                                                                                                                 |
| Additive extension?       | New empty interface and the union.                                                                                                                                                                                             |
| Implementation owner      | `packages/agent/src/messages/types/custom-agent-messages.ts`, `agent-message.ts`                                                                                                                                               |
| 5A action                 | Compile-time seam only. **No `CodingCommandExecutionMessage` and no product message was implemented** — that proof belongs to 5E. The interface is empty rather than an index signature so a kind has to be declared to exist. |
| 5A test                   | `tests/architecture/phase-5a-message-domain-boundaries.test.ts` asserts the seam is declaration-merged and that no `SYSTEM` arm or `AgentSystemMessage` exists.                                                                |
| Later Phase exit          | 5E.                                                                                                                                                                                                                            |

### 3.9 Message Factory

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §28, §56, §57, §58 — `createUser` / `createAssistant` / `createToolResult`, owning id, scope, time, source, audience defaults and base invariants                                                                                                                                                                                                                                     |
| Current source            | Did not exist; message creation was scattered across the Run/Storage boundary.                                                                                                                                                                                                                                                                                                        |
| Additive extension?       | New factory with injected id authority and clock.                                                                                                                                                                                                                                                                                                                                     |
| Implementation owner      | `packages/agent/src/messages/types/message-factory.ts`                                                                                                                                                                                                                                                                                                                                |
| 5A action                 | Owns identity (minted **before** anything durable is attempted), `createdAt` from the injected clock, audience defaults from the three constants, and scope/provenance consistency. Writes no database, reads no Runtime, calls no provider, executes no Tool, selects no context and projects no transcript. `@caelush/agent` gained **no** SQLite, daemon or filesystem dependency. |
| 5A test                   | `packages/agent/test/messages/message-domain.test.ts` — determinism under a scripted id factory and a fixed clock; scope and provenance refusals.                                                                                                                                                                                                                                     |
| Later Phase exit          | 5C makes it the production creation authority.                                                                                                                                                                                                                                                                                                                                        |

---

## 4. Persistence contracts only

| Contract                        | Freeze | Current source | 5A action                                                                                                      | Owner                            | Test                                                         | Later exit                        |
| ------------------------------- | ------ | -------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `AgentMessageSchemaVersion`     | §61    | Did not exist  | `number` + assertion that it is a positive safe integer                                                        | `messages/persistence/record.ts` | architecture guard asserts the declaration and the assertion | 5B                                |
| `AgentMessageProjectionVersion` | §62    | Did not exist  | Same, plus distinctness from the schema version stated in the type's documentation                             | `messages/persistence/record.ts` | architecture guard                                           | 5B                                |
| `AgentMessageRecord`            | §63    | Did not exist  | Envelope declared exactly; `sequence` lives here and nowhere else                                              | `messages/persistence/record.ts` | codec tests build records and round-trip them                | 5B                                |
| Record sequence invariant       | §64    | Did not exist  | `assertAgentMessageSequence`; 5A allocates **no** real durable sequence — fixtures use their own               | `messages/persistence/record.ts` | validator and codec tests use fixture sequences only         | 5B becomes the sequence authority |
| `StoredAgentMessage`            | §65    | Did not exist  | Declared; the only carrier of a settled sequence next to a message                                             | `messages/persistence/record.ts` | projection and selector tests                                | 5B                                |
| `AgentMessageDraft`             | §66    | Did not exist  | Declared **without** `sequence`; this is `registry.encode()`'s result                                          | `messages/persistence/record.ts` | codec registry tests assert the absence                      | 5B                                |
| `AgentMessageRecordDraft`       | §67    | Did not exist  | Declared without `runId` (bound by `append(runId, records)`) and without `sequence`                            | `messages/persistence/record.ts` | architecture guard asserts both absences                     | 5B                                |
| No store port implementation    | §68    | Did not exist  | **No `AgentMessageRecordStorePort`, no `AgentConversationRepository`, no SQL, no migration, no schema change** | —                                | architecture guard scans the messages tree for persistence   | 5B                                |
| `OpaqueAgentMessageRecord`      | §82    | Did not exist  | Declared with the two frozen reasons; the preserve _policy_ is explicitly left to 5B                           | `messages/persistence/record.ts` | architecture guard asserts the reason set                    | 5B                                |

---

## 5. Codec system

### 5.1 `AgentMessageCodec`

| Question                  | Answer                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §69, §70 — `type`, `currentVersion`, `canDecode`, `encode`, `decode`                                                                                  |
| Current source            | Did not exist.                                                                                                                                        |
| Additive extension?       | New interface and a typed refusal `AgentMessageCodecError` with a closed four-reason set.                                                             |
| Implementation owner      | `packages/agent/src/messages/codec/codec.ts`                                                                                                          |
| 5A action                 | Declared exactly. The refusal carries only schema metadata — never the payload — so a decode failure cannot leak Tool output or user text into a log. |
| Later Phase exit          | 5B implements the store around it.                                                                                                                    |

### 5.2 Standard codecs `USER v1` / `ASSISTANT v1` / `TOOL_RESULT v1`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §71, §72, §73, §74 — three codecs; the envelope and `data` never duplicate authority; identity validated on decode; encoding deterministic                                                                                                                                                                                                                                                                                                                            |
| Current source            | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Additive extension?       | Three codecs and `assertJsonSafePayload`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Implementation owner      | `packages/agent/src/messages/codec/standard-codecs.ts`                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5A action                 | `data` carries only type-specific payloads — `content` for USER, `content`/`model`/`providerState?` for ASSISTANT, and the six Tool fields for TOOL_RESULT. `runId`, `sessionId`, `conversationTurnId`, `sourceStepId`, `createdAt`, `source` and `audience` are read from the envelope and written **only** there, so the two can never disagree. Decode validates `messageType == codec.type`, the version, and every envelope field before constructing a message. |
| 5A test                   | `packages/agent/test/messages/codec.test.ts` — the twelve required cases from Freeze §137 for each standard type.                                                                                                                                                                                                                                                                                                                                                     |
| Later Phase exit          | 5B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 5.3 `AgentMessageCodecRegistry` and its builder

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §75, §76, §77, §83 — `has`, `get`, `encode`, `decode`; `register`/`build`; immutable generation; duplicate and invalid versions refused; unknown version fails closed                                                                                                                                                                                                                                         |
| Current source            | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                                |
| Additive extension?       | Registry, builder, typed registry refusal with a closed five-reason set.                                                                                                                                                                                                                                                                                                                                      |
| Implementation owner      | `packages/agent/src/messages/codec/registry.ts`, `registry-builder.ts`                                                                                                                                                                                                                                                                                                                                        |
| 5A action                 | `encode` writes the newest registered version for the type; `decode` uses the record's own version and never falls forward. `decode` distinguishes `CODEC_UNAVAILABLE` (unknown type) from `UNSUPPORTED_SCHEMA_VERSION` (known type, unreadable version) so a persistence caller can build the right `OpaqueAgentMessageRecord`. `build()` is terminal: a second `build()` or a `register()` after it throws. |
| 5A test                   | `packages/agent/test/messages/codec.test.ts` — the seven required registry cases from Freeze §138 and the immutability rules.                                                                                                                                                                                                                                                                                 |
| Later Phase exit          | 5B.                                                                                                                                                                                                                                                                                                                                                                                                           |

### 5.4 Projection-version reconciliation (the round's central contract point)

| Question                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract     | §78, §79, §80, §81 — `encode` returns an `AgentMessageDraft` carrying `modelProjectionVersion`; any new `audience.model = true` message must record one; the resolution must be a private injected resolver and must not modify a frozen interface                                                                                                                                                                   |
| Current source                | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Resolution                    | **The version authority is injected.** `createAgentMessageCodecRegistry({ projectionVersionOf })` and `createAgentMessageCodecRegistryBuilder(projectionVersionOf)` take a `type → current projector version` resolver. The codec registry owns the _rule_; the projector registry owns the _value_. In production the composition root passes `projectorRegistry.currentVersion`. Neither frozen interface changes. |
| Forbidden resolutions refused | A hardcoded default of `1`; a literal scattered per codec; letting Storage guess; saving a model-visible message with an undefined version; calling a real projector just to ask for a version. With no resolver injected, a model-visible message fails closed with `PROJECTION_VERSION_UNAVAILABLE` and a non-model-visible one encodes normally — it has no model view to version.                                |
| 5A test                       | `packages/agent/test/messages/codec.test.ts` — `model=false` message encodes without a version; `model=true` message with a resolver records it; `model=true` without a resolver fails closed; a second test delegates the resolver to a real projector registry's `currentVersion`.                                                                                                                                 |
| Later Phase exit              | 5B consumes the recorded version; 5D wires the composition root.                                                                                                                                                                                                                                                                                                                                                     |

---

## 6. AI projection

### 6.1 `AgentMessageAIProjection` and `AgentMessageProjector`

| Question                  | Answer                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface Freeze contract | §84, §85, §86, §92 — `messages: readonly AIConversationMessage[]`, `fingerprint: string`; projectors pure, deterministic, provider-neutral, side-effect-free                                                                                           |
| Current source            | Did not exist.                                                                                                                                                                                                                                         |
| Additive extension?       | New projection result and projector interface, plus `createAgentMessageAIProjection`, which computes the fingerprint itself.                                                                                                                           |
| Implementation owner      | `packages/agent/src/messages/projection/projector.ts`                                                                                                                                                                                                  |
| 5A action                 | A projector never states its own fingerprint: the assembler computes it from the frozen messages, so a digest cannot disagree with what it describes. The messages are copied and frozen so a later mutation cannot invalidate a certified projection. |
| 5A test                   | `packages/agent/test/messages/projection.test.ts` — stable fingerprint for equal semantic projections, different fingerprint for different ones.                                                                                                       |
| Later Phase exit          | 5D.                                                                                                                                                                                                                                                    |

### 6.2 Standard projectors

| Projector        | Freeze   | Rules implemented                                                                                                                                                                                                                                                                                                                              | Test                                                                                             |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `USER v1`        | §88, §89 | Text parts in order, each attachment reference replaced at its own position by the fixed, versioned, tested marker `[attachment v1 artifactId="…" label="…" mediaType="…"]`; every field `JSON.stringify`-escaped so a quote or newline cannot break the marker; no host path, no secret URI, no artifact read; absent optional fields omitted | `projection.test.ts` — text, multiple text parts, marker, order, determinism, stable fingerprint |
| `ASSISTANT v1`   | §90      | `AgentAssistantTextPart → AITextContent`, `AgentAssistantToolCallPart → AIToolCallContent`; part order, `toolCallId`, `toolName` and `input` preserved exactly; `providerState` copied unchanged                                                                                                                                               | `projection.test.ts` — text, tool call, mixed, order, input preserved, provider state preserved  |
| `TOOL_RESULT v1` | §91      | Returns `{ role: "tool", toolCallId, toolName, content: projectedContent, isError }` using `projectedContent` **verbatim**; performs no observation lookup and no re-truncation                                                                                                                                                                | `projection.test.ts` — verbatim text with a non-existent observation id                          |

The attachment marker format is fixed, versioned (`v1`) and tested, as Freeze §88 requires. It contains
no host absolute path and no secret URI: the projector adds no path of its own and reads no artifact.

### 6.3 `AgentMessageProjectorRegistry`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §93, §94, §95, §96, §98 — `has`, `get`, `project`; immutable generation; `model=false → []`; `model=true` with no projector throws; `modelProjectionVersion` is authority and is never replaced by the latest projector                                                                                                                                                                                                                                                                                                    |
| Current source            | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Additive extension?       | Registry plus a `currentVersion(type)` accessor on a widened registry type.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Implementation owner      | `packages/agent/src/messages/projection/registry.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5A action                 | Three decisions, each fail-closed: `model=false` → the canonical empty projection with the canonical empty fingerprint and no projector consulted; `model=true` + missing version → `PROJECTION_VERSION_UNAVAILABLE`; `model=true` + no such projector → `UNKNOWN_MODEL_VISIBLE_MESSAGE`. `currentVersion` is _optional_ on the interface, because the frozen registry contract does not name it — a registry implementing only the frozen three methods is complete, and a codec registry wired to one then fails closed. |
| 5A test                   | `projection.test.ts` — all four visibility cases from Freeze §142.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Later Phase exit          | 5D.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 6.4 `AgentMessageProjectionError`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §97 — exactly four codes                                                                                                                                                                                                                                                                                                                                                                                 |
| Current source            | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                           |
| Additive extension?       | New error with the closed four-code set.                                                                                                                                                                                                                                                                                                                                                                 |
| Implementation owner      | `packages/agent/src/messages/projection/errors.ts`                                                                                                                                                                                                                                                                                                                                                       |
| 5A action                 | `UNKNOWN_MODEL_VISIBLE_MESSAGE`, `PROJECTION_VERSION_UNAVAILABLE`, `PROJECTION_FINGERPRINT_MISMATCH`, `INVALID_PROJECTED_CONVERSATION` — and no fifth. The error carries only the code, the message type and a version, never message content. `PROJECTION_FINGERPRINT_MISMATCH` is raised by `assertProjectionFingerprint`, which 5B uses to prove a re-projection reproduces what the model was shown. |
| 5A test                   | architecture guard asserts the four-code set is exactly closed.                                                                                                                                                                                                                                                                                                                                          |
| Later Phase exit          | 5B / 5D.                                                                                                                                                                                                                                                                                                                                                                                                 |

### 6.5 No system output, by type and by test

| Question                  | Answer                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §87, §143 — a projector returns `AIConversationMessage[]`, so `Projector -X-> AISystemMessage`                                                                                                                                                                                     |
| 5A action                 | The return type makes it a compile error. The registry checks again at run time, because a projector is an injected boundary and a custom message type's projector could reach it through a widened type.                                                                          |
| 5A test                   | `packages/agent/test/messages/projection.test.ts` — a hostile projector that returns a system message is refused with `INVALID_PROJECTED_CONVERSATION`; `tests/architecture/phase-5a-message-domain-boundaries.test.ts` asserts the projection surface has no system-message path. |
| Later Phase exit          | None.                                                                                                                                                                                                                                                                              |

---

## 7. Conversation domain

### 7.1 `ConversationTurnStatus` and `ConversationTurn`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §99, §100, §101, §102 — status, the seven fields, and `ConversationTurn` is not an `ExecutionUnit`                                                                                                                                                                                                                                                                                                                              |
| Current source            | Did not exist.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Additive extension?       | New status union and turn interface, `createConversationTurn`, `conversationTurnStatus`.                                                                                                                                                                                                                                                                                                                                        |
| Implementation owner      | `packages/agent/src/messages/conversation/conversation-turn.ts`                                                                                                                                                                                                                                                                                                                                                                 |
| 5A action                 | **No `conversation_turns` table and no migration** (Freeze §27): a turn is a derived view. `openedAt` carries the owning Run's `createdAt`, which is what makes turns orderable within a Session. The status derivation is a pure function and is **not** wired to the production `RunController` — only the pure builder and validator exist. The turn-versus-execution-unit distinction is documented in the type and tested. |
| 5A test                   | `validator.test.ts`, `execution-unit.test.ts`; an architecture guard asserts no `conversation_turns` table exists.                                                                                                                                                                                                                                                                                                              |
| Later Phase exit          | 5B / 5C construct the production turn.                                                                                                                                                                                                                                                                                                                                                                                          |

### 7.2 `AgentConversationSnapshot`

| Question                  | Answer                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §103, §104 — four fields; turns ordered by Run `createdAt` then Run id; turn messages ordered by `sequence`, strictly increasing                                                               |
| Current source            | Did not exist.                                                                                                                                                                                 |
| Additive extension?       | New interface plus `createAgentConversationSnapshot` and `createSingleTurnConversationSnapshot`.                                                                                               |
| Implementation owner      | `packages/agent/src/messages/conversation/conversation-snapshot.ts`                                                                                                                            |
| 5A action                 | Ordering is part of the contract and is enforced by the validator. 5A builds snapshots from fixtures and validates them; it reads none from Storage, because Storage does not produce one yet. |
| 5A test                   | `validator.test.ts` — fixture-built snapshots, including a two-turn Session with correct and with incorrect ordering.                                                                          |
| Later Phase exit          | 5B / 5C.                                                                                                                                                                                       |

### 7.3 `AgentConversationValidator`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §105, §106, §107, §108, §109, §110                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Current source            | `loop/history/conversation-history.ts` holds the **old** `AIMessage`-based integrity checks, which production still uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Already implemented?      | The old validator was; the Agent-message validator was not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Additive extension?       | New validator, new closed reason set, new error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Implementation owner      | `packages/agent/src/messages/conversation/validator.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5A action                 | Implements all nine required checks and separates **durable structure** from **model-visible structure** (Freeze §108). Durable: unique message ids across the snapshot, strictly increasing sequence per turn, `runId`/`sessionId`/`conversationTurnId` matching the turn, turn identity and ordering, and the current Run/turn pair. Model-visible: unique `toolCallId` within the model visible set, matching result, matching tool name, no duplicate result, no orphan result, no unanswered call, and a model-visible call may not be answered by a hidden result (Freeze §107). A hidden custom message between a call and its result is explicitly legal. |
| 5A test                   | `validator.test.ts` — all fifteen required cases from Freeze §145.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Later Phase exit          | The old validator is deleted in 5C / 5D; **it was neither deleted nor extended in 5A** (Freeze §109, §110, §161).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 7.4 `ExecutionUnit`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §111, §112, §113, §114, §115, §116 — eleven fields; deterministic id from run + assistant message; grouping; OPEN/CLOSED; compaction invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Current source            | `packages/context/src/execution-unit.ts` has an `LLMMessage`-based unit whose id is `${runId}:execution:${index}` — an array index.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Additive extension?       | New Agent-domain `ExecutionUnit` and its builders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Implementation owner      | `packages/agent/src/messages/conversation/execution-unit.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5A action                 | Identity is `${runId}:execution:${assistantMessageId}` — **never an array index** (Freeze §112). A message with no Tool call opens no unit. Only the model-visible Tool protocol forms units, so a hidden message cannot open, answer or break one. Results are attributed by `toolCallId`, never by adjacency. `CLOSED` requires `toolResultMessageIds.length === toolCallIds.length`; `isCompactionCandidate` re-checks the counts rather than trusting the status claim. Only the domain invariant is established — compaction itself is not rewritten (Freeze §116). The Context unit is untouched and exits in 5D. |
| 5A test                   | `execution-unit.test.ts` — no tools, single tool OPEN and CLOSED, multi-tool partial, all results, deterministic id, source range, ids not indexes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Later Phase exit          | 5D.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 7.5 `ConversationSelector` and `SelectedAgentConversation`

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface Freeze contract | §117, §118, §121, §122, §123, §124, §125, §126, §127                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Current source            | `packages/context` has `selectSafeExecutionUnits` over `LLMMessage` units. `@caelush/agent` has nothing, and may not import Context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Additive extension?       | New selector, new result, new `TokenEstimator` port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Implementation owner      | `packages/agent/src/messages/conversation/selector.ts`, `token-estimator.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5A action                 | `select()` keeps the frozen signature. The projector registry is injected at construction (Freeze §122), so no frozen input changed. Selection measures the **projection** through the injected estimator — never `JSON.stringify` of an `AgentMessage` (Freeze §121). `audience.model = false` contributes exactly zero (Freeze §123). A Tool result is measured only through its projected content; no observation is loaded (Freeze §124). Tool execution units are atomic and an OPEN unit is protected (Freeze §125, §126). `requiresCompaction` is reported, never acted on: 5A implements no checkpoint, no compaction, no relevant-file policy and no memory policy (Freeze §127). |
| 5A test                   | `selector.test.ts` — the nine required cases from Freeze §147.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Later Phase exit          | 5D wires it into the Context Engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 7.6 `TokenEstimator` package reconciliation

| Question                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §119, §120 — `@caelush/agent -X-> @caelush/context`, so the Agent Domain declares the narrowest port and the Context estimator satisfies it structurally                                                                                                                                                                                                                                                                                                                        |
| Current source            | `packages/context/src/token-estimator.ts` owns `TokenEstimator` and `Utf8HeuristicTokenEstimator`.                                                                                                                                                                                                                                                                                                                                                                              |
| 5A action                 | A new port in `messages/conversation/token-estimator.ts` whose input is `readonly AIConversationMessage[]`. **No heuristic algorithm was copied into `@caelush/agent`**: the default `STRUCTURAL_TOKEN_ESTIMATOR` is a documented floor for a misconfigured composition root, not a second implementation of the Context algorithm. The port speaks projected AI rather than `AgentMessage` on purpose, so an implementation cannot accidentally count durable envelope fields. |
| 5A test                   | architecture guard asserts `@caelush/agent` declares no dependency on `@caelush/context` and imports it nowhere.                                                                                                                                                                                                                                                                                                                                                                |
| Later Phase exit          | 5D makes the Context implementation the injected one.                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 8. Public exports

| Question                  | Answer                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interface Freeze contract | §128, §129, §130, §131, §150 — root-only public surface, both packages                                                                                                                                                                                                                                     |
| 5A action                 | Every frozen Message Domain name is exported explicitly from `packages/agent/src/index.ts`, and the four new AI names plus the canonical AI content names from `packages/ai/src/index.ts`. No wildcard re-export, no cross-package pass-through. A consumer never needs `@caelush/agent/src/messages/...`. |
| 5A test                   | `tests/architecture/phase-5a-message-domain-boundaries.test.ts` asserts every required name is present in the root index; the existing Phase 4F guard's pass-through ratio rule continues to apply.                                                                                                        |
| Later Phase exit          | None.                                                                                                                                                                                                                                                                                                      |

---

## 9. Test matrix

| Required suite (Freeze §132–§148) | File                                                            | Required cases                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID tests                          | `packages/agent/test/messages/message-domain.test.ts`           | §133 — branding, validation, deterministic turn id, same Run same id, different Runs differ                                                                          |
| User message tests                | `packages/agent/test/messages/message-domain.test.ts`           | §134 — defaults, `GOAL`/`FOLLOW_UP`/`STEERING`, text only, attachment only, both, empty invalid                                                                      |
| Assistant message tests           | `packages/agent/test/messages/message-domain.test.ts`           | §135 — text, tool-call, mixed, order, duplicate `toolCallId`, `MODEL_TURN`, legacy restriction, optional `providerState`                                             |
| ToolResult message tests          | `packages/agent/test/messages/message-domain.test.ts`           | §136 — identity, both `isError` values, verbatim `projectedContent`, receipt version/policy/fingerprint                                                              |
| Codec tests — every standard type | `packages/agent/test/messages/codec.test.ts`                    | §137 — round trip, deterministic encode, version handling, invalid data, invalid envelope, identity mismatch, audience/source/providerState preservation             |
| Codec registry tests              | `packages/agent/test/messages/codec.test.ts`                    | §138 — register, duplicate rejection, build immutability, exact `get`, unknown version, current-version encode, stored-version decode, projection-version matrix     |
| Projection tests — USER           | `packages/agent/test/messages/projection.test.ts`               | §139 — text, multiple parts, marker, order, determinism, stable fingerprint                                                                                          |
| Projection tests — ASSISTANT      | `packages/agent/test/messages/projection.test.ts`               | §140 — text, tool call, mixed, order, input preserved, providerState preserved, fingerprint                                                                          |
| Projection tests — TOOL_RESULT    | `packages/agent/test/messages/projection.test.ts`               | §141 — uses `projectedContent` verbatim and requires no `ToolObservation`                                                                                            |
| Visibility tests                  | `packages/agent/test/messages/projection.test.ts`               | §142 — `model=false → []`, `model=true` + projector, `model=true` + none, missing version                                                                            |
| No system projection              | `packages/agent/test/messages/projection.test.ts`               | §143 — a projector cannot return an `AISystemMessage`                                                                                                                |
| Provider-neutral scan             | `tests/architecture/phase-5a-message-domain-boundaries.test.ts` | §144 — no provider name or branching under `packages/agent/src/messages/**`                                                                                          |
| Conversation validator tests      | `packages/agent/test/messages/validator.test.ts`                | §145 — all fifteen required cases                                                                                                                                    |
| ExecutionUnit tests               | `packages/agent/test/messages/execution-unit.test.ts`           | §146 — no tools, single OPEN/CLOSED, multi partial, all results, deterministic id, source range, ids not indexes                                                     |
| ConversationSelector tests        | `packages/agent/test/messages/selector.test.ts`                 | §147 — all fit, tail dropped, `model=false` zero, unit atomicity, latest OPEN retained, stable id lists, `requiresCompaction`, determinism                           |
| Independent-use test              | `packages/agent/test/messages/independent-use.test.ts`          | §148 — create → encode → fake stored record → decode → project → turn → validate → select, using only the three packages                                             |
| Phase 5A architecture guard       | `tests/architecture/phase-5a-message-domain-boundaries.test.ts` | §149–§158 — boundaries, no system arm, no `sequence` on the base, storage sequence only, no provider branching, no persistence implementation, no production cutover |

---

## 10. Prohibited work — confirmation

```text
5A does NOT
  modify the agent_messages schema or add any migration                     (5B)
  switch RunExecutionStore, RunExecutionMessageAppend or messagesToAppend   (5C)
  switch AgentLoopAdvanceInput.history                                      (5D)
  switch ContextPrepareInput.history or the ContextEngine                   (5D)
  switch hydrateSessionTranscript or the Client transcript                  (5E / 5F)
  enable Coding custom messages or CodingCommandExecutionMessage            (5E)
  delete legacy columns, backfill rows or retire LLMMessage ownership       (5F)
  modify ToolCallPreparer, DurableToolExecutionCoordinator,
    ToolBatchCoordinator, ToolResultPipeline, ToolSettlementCoordinator      (5C for wiring)
  modify RunController authority, CompletionGate, verification authority
    or Run terminal semantics
  change Provider request semantics, Tool execution, Run execution,
    Context output, Client transcript or database schema
  add a second AI message implementation, a second JSON vocabulary,
    a second ToolObservationPolicySnapshot or a second Tool/Provider registry
  add a DB table, protocol field or storage dependency to @caelush/agent
```

---

## 11. Boundary acceptance

| Boundary / invariant                                | Freeze     | Enforced by                                                      | Result |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------- | ------ |
| `@caelush/ai -X-> @caelush/agent`                   | §150       | architecture guard + `scripts/architecture/check-boundaries.mjs` | PASS   |
| `@caelush/agent -X-> @caelush/coding-agent`         | §151       | architecture guard + manifest check                              | PASS   |
| `@caelush/agent -X-> @caelush/storage`              | §151       | architecture guard + manifest check                              | PASS   |
| `@caelush/agent -X-> @caelush/context`              | §151       | architecture guard + manifest check                              | PASS   |
| `@caelush/agent -X-> @caelush/client`               | §151       | architecture guard + manifest check                              | PASS   |
| `@caelush/agent -X-> daemon`                        | §151       | architecture guard + manifest check                              | PASS   |
| `messages/projection/** -X-> provider adapters`     | §152       | architecture guard source scan                                   | PASS   |
| No `SYSTEM` arm / `AgentSystemMessage` in the union | §153       | architecture guard source scan                                   | PASS   |
| No `sequence` in `AgentMessageBase`                 | §154, §34  | architecture guard hard assertion                                | PASS   |
| `sequence` only on record / stored / unit range     | §155, §64  | architecture guard source scan                                   | PASS   |
| No provider-name branching in Agent Message code    | §156, §144 | architecture guard source scan                                   | PASS   |
| No SQLite / SQL / migration in `messages/**`        | §157       | architecture guard source scan                                   | PASS   |
| No production cutover                               | §158, §202 | architecture guard asserts the untouched files are unchanged     | PASS   |

---

## 12. Acceptance gates

| Gate                     | Freeze | Evidence                                                                           |
| ------------------------ | ------ | ---------------------------------------------------------------------------------- |
| AI domain                | §192   | §1 above; `packages/ai/test/message-system-v2.test.ts`                             |
| Agent domain             | §193   | §2, §3 above                                                                       |
| Codec                    | §194   | §5 above; `codec.test.ts`                                                          |
| Projection               | §195   | §6 above; `projection.test.ts`                                                     |
| Conversation             | §196   | §7 above; `validator.test.ts`, `execution-unit.test.ts`, `selector.test.ts`        |
| Boundaries               | §197   | §11 above                                                                          |
| Behaviour                | §198   | §10 above; full workspace suite plus the daemon regression suites                  |
| Not prematurely complete | §199   | registry, validator, unit builder, selector and the independent-use test all exist |

---

## 13. Deviations

```text
D1  Freeze §12 AIJson* names
    The Freeze names AIJsonPrimitive / AIJsonValue / AIJsonObject and simultaneously
    requires that an existing equivalent primitive be reused rather than duplicated.
    Decision: reuse JsonPrimitive / JsonValue / JsonObject and add NO alias declarations.
    Reason: adding `export type AIJsonObject = JsonObject` would satisfy the letter of the
    naming clause while creating two names for one shape and inviting a later reader to
    "keep them in sync". One declaration, one name; the reuse clause is the substantive one.
    Reversible: adding the aliases later is additive and breaks nothing.

D2  Freeze §26 ConversationTurnIdFactory determinism
    Determinism is implemented as a pure function of RunId (SHA-256 seeded UUIDv7 shape)
    with three factory constructors. createConversationTurnIdFactory() embeds one
    composition-time anchor so two factories created in one process agree; the clock-free
    createDeterministicConversationTurnIdFactory() is the form 5B backfill composes.
    The anchor is a fixed constant for the factory's lifetime and is never re-read, so no
    result is time-dependent.

D3  Freeze §93 AgentMessageProjectorRegistry.currentVersion
    The frozen registry interface names only has/get/project. currentVersion(type) is added
    on a widened exported type (AgentMessageProjectorRegistryWithVersions) rather than on
    the frozen interface, so the frozen contract is unchanged and a registry implementing
    only the three frozen methods remains complete.

D4  Freeze §82 OpaqueAgentMessageRecord versus §83 registry.decode return type
    decode() must return AgentMessage, so it cannot return an opaque record. It therefore
    raises a typed AgentMessageCodecError whose reason distinguishes CODEC_UNAVAILABLE from
    UNSUPPORTED_SCHEMA_VERSION, and OpaqueAgentMessageRecord is the type a persistence
    caller builds by pairing the untouched record with that reason. The preserve policy is
    explicitly 5B's. This is the composition the two clauses admit; §5.3 and §82 record it.

D5  Freeze §61/§62 version types
    Both are declared as `number` as frozen, with the positive-safe-integer invariant
    enforced by assertion at every boundary rather than by the type. The type cannot express
    the invariant without deviating from the frozen declaration.

D6  Freeze §100 ConversationTurn.openedAt / closedAt
    Implemented as frozen. Documented as the session ordering key carrying the owning Run's
    createdAt, which is what makes §104's "Run.createdAt then Run.id" ordering checkable from
    a turn alone.

D7  Freeze §21 provider opaque state source
    No provider opaque state source exists anywhere in the Phase 4F source, so 5A wires no
    capture. The type, strict validation, the two-property match predicate, the projection
    passthrough and the provider-switch safety test are implemented; capture awaits a real
    source. Freeze §21 explicitly forbids inventing one.

D8  Phase 3A guard amendment — the bounded clock exception
    Phase 3A's guard asserts the Agent Kernel owns no wall-clock time, and it stated that as one
    aggregate `not.toMatch` over the whole package. The Message Domain's identity authority
    legitimately needs `Date.now()` once per *new* message id, because a new identity must be
    unique and a UUIDv7-shaped id sorts by creation time.

    Amendment: the clock rule is restated per file with exactly one named exception,
    `packages/agent/src/messages/types/ids.ts`, following the guard's own established
    bounded-exception pattern. `node:fs`, `node:path`, `node:child_process`, `process.env` and
    `Math.random` stay blanket-forbidden across the package, and any other kernel file reaching
    for `Date.now` still fails. The conversation turn derivation — the one identifier that must
    be reproducible — is separately asserted clock-free.

    Direction of change: the host-module check is exactly as wide as before, and the clock rule
    names one file rather than waiving itself.

D9  Phase 2C guard amendment — the frozen root export inventory
    Phase 2C asserts the `@caelush/agent` root export list exactly, so any addition is a
    deliberate, recorded act rather than drift. Phase 5A added 98 names: the Message Domain's
    types, factories, registries, errors and constants. They are appended under a `Phase 5A`
    heading that states why each belongs to the kernel. The list is still asserted exactly —
    nothing was removed, and nothing can widen by accident.

D10 Architecture guard runtime
    The Phase 5A guard's declaration assertions originally re-read and re-stripped the whole
    workspace once per assertion, which exceeded the default test timeout under host parallelism
    (seven timeouts in the parallel run, none in the serial run). The guard now caches
    comment-stripped production source once and filters it in memory — the same discipline the
    Phase 4F guard uses — which took it from ~31 s to ~0.6 s. This was a performance defect in
    the guard, never in the implementation it guards.
```

## 14. Status

```text
5A  COMPLETE
5B  not started
```
