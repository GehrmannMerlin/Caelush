# Caelush Architecture V2 — Phase 5 Message System Round Plan

```text
PHASE 5 — Message System V2 structural migration
rounds   exactly six: 5A, 5B, 5C, 5D, 5E, 5F
```

This document fixes the Phase 5 round decomposition and the acceptance boundary of each round. The
decomposition is frozen: no `5A-1`, no `5A-Fix`, no `5A-Resume`, no `5G`, and no work moved from an
earlier round into a later one to make the earlier round fit. A round that cannot finish inside its own
boundary records `IN PROGRESS` with the exact remainder; it does not become two rounds.

---

## 0. Sources and authority

```text
Caelush_Message_System_V2_Current_to_Target_Interface_Freeze.md   the frozen public contracts
Caelush_Message_System_V2_Refactor_Spec.md                        the architecture intent
Phase 5 Message System round plan                                  this document
Phase 4F report and acceptance map                                 the implementation baseline
docs/architecture/v2/MIGRATION_EXECUTION_CONTRACT.md               migration mechanics and evidence
Phase 2 / 3 / 4 frozen contracts                                   still in force
```

Priority when they disagree:

```text
1  the round's own authorising prompt     the phase boundary
2  the Interface Freeze                   the public contract and target behaviour
3  the Refactor Spec                      the architecture intent; its examples never override 2
4  this round plan                        the six-round decomposition
5  current source after Phase 4F          real behaviour and post-baseline drift
6  Phase 2 / 3 / 4 frozen contracts       still in force; never overridden by a later round
```

### 0.1 Provenance of the two authorising Message documents

```text
Caelush_Message_System_V2_Current_to_Target_Interface_Freeze.md
Caelush_Message_System_V2_Refactor_Spec.md
```

Neither document is present in the repository tree at the Phase 5A baseline. They are recorded here
honestly as **externally supplied authorising specifications**, which is what they are. Phase 5A does
**not** invent a repository path for them and does not commit a reconstruction of them: a document
that claims an authority it was not given would be worse than a missing one. Every contract Phase 5A
implements is traced to a numbered clause of the Freeze in
[PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md](PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md), so the
authority for each decision is auditable even though the source text is not in tree.

### 0.2 Freeze supersedes the earlier Refactor Spec

The two documents differ in a small number of places, and the Freeze wins. The known divergence that
governs Phase 5A:

```text
Architecture draft      AgentMessageBase.sequence
Interface Freeze        AgentMessageBase has no sequence

resolution              sequence belongs to AgentMessageRecord and StoredAgentMessage,
                        which are the storage-assigned ordering, and to the ExecutionUnit
                        source range that reads it

consequence             AgentMessageBase.sequence is forbidden, and Phase 5A ships an
                        architecture guard asserting its absence
```

---

## 1. The six rounds

| Round  | Scope (fixed)                                                                                                                                                                                                                                                                                                                                                                            | Owner of the result                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **5A** | The pure Message Domain core: additive AI message refinement, `AgentMessage` and its identity, audience, source and content, the Message Factory, persistence record contracts, the versioned Codec Registry, the versioned AI Projector Registry, `ConversationTurn`, `AgentConversationSnapshot`, the Conversation Validator, `ExecutionUnit` and the projected `ConversationSelector` | `@caelush/agent`, `@caelush/ai` (additive only)   |
| **5B** | Durable message storage: the `agent_messages` schema and its migration, the codec-driven repository, sequence assignment, the `AgentConversationRepository`, the opaque-record preserve policy, backfill of existing rows                                                                                                                                                                | `@caelush/storage`                                |
| **5C** | Durable conversation runtime cutover: `RunExecutionStore` commits `AgentMessage` records, the Message Factory becomes the production message authority, Tool feedback settles as `AgentToolResultMessage`, `RunExecutionMessageAppend` changes shape                                                                                                                                     | `@caelush/agent` ports, `@caelush/storage`, hosts |
| **5D** | Context and replay cutover: `ContextPrepareInput.history` and `AgentLoopAdvanceInput.history` become the projected snapshot conversation, the Context Engine consumes `ConversationSelector`, `ToolObservationPolicySnapshot` reads from the receipt                                                                                                                                     | `@caelush/context`, `@caelush/agent`              |
| **5E** | Transcript and client cutover: the transcript protocol and API, the client's `hydrateSessionTranscript` consumes durable Agent messages, the coding custom message proof (`CodingCommandExecutionMessage`)                                                                                                                                                                               | `@caelush/protocol`, `@caelush/client`, hosts     |
| **5F** | Backfill verification, legacy retirement and final acceptance: the `LLMMessage` ownership retirement, the legacy `agent_messages` column removal, the AI history validator deletion, whole-phase acceptance                                                                                                                                                                              | the whole Message System                          |

### 1.1 What each round is allowed to leave open

A round may leave a responsibility with the pre-V2 implementation **only** if this table names the
round that takes it. "Later" is not an exit round.

| Responsibility                                                  | 5A            | 5B             | 5C         | 5D         | 5E        | 5F          |
| --------------------------------------------------------------- | ------------- | -------------- | ---------- | ---------- | --------- | ----------- |
| AI message additive refinement (`providerState`, content names) | **moves**     |                |            |            |           |             |
| `AgentMessage` types, identity, audience, source, content       | **moves**     |                |            |            |           |             |
| Message Factory                                                 | **moves**     |                | production |            |           |             |
| Persistence record/draft/stored contracts                       | **contracts** | **implements** |            |            |           |             |
| Codec registry                                                  | **moves**     | production     |            |            |           |             |
| AI projector registry                                           | **moves**     |                |            | production |           |             |
| Conversation Validator                                          | **moves**     |                |            | production |           |             |
| `ExecutionUnit` identity and grouping                           | **moves**     |                |            | production |           |             |
| `ConversationSelector` primitive                                | **moves**     |                |            | production |           |             |
| `agent_messages` schema, migration, sequence assignment         | —             | **moves**      |            |            |           |             |
| `RunExecutionStore` message shape                               | unchanged     |                | **moves**  |            |           |             |
| Tool feedback durable wiring                                    | unchanged     |                | **moves**  |            |           |             |
| Context history shape                                           | unchanged     |                |            | **moves**  |           |             |
| Transcript protocol and client                                  | unchanged     |                |            |            | **moves** |             |
| Coding custom message proof                                     | seam only     |                |            |            | **moves** |             |
| `LLMMessage` retirement, legacy column removal                  | —             | —              | —          | —          | —         | **only 5F** |

### 1.2 What every round must not do

```text
break a Phase 2 / 3 / 4 frozen interface      LLMGateway, ModelTurnExecutor, AgentLoop,
                                              AgentLoopAdvanceResult, RunExecutionCoordinator,
                                              RunExecutionDirective, RunExecutionDriver,
                                              RunTransitionPlanner, RunContinuationCheckpoint,
                                              ToolTurnCoordinator, CompletionGate,
                                              AgentToolRegistry, ToolDispatcher lifecycle,
                                              ToolSettlementCoordinator, RetryPolicy, budgets
reintroduce AgentMessageBase.sequence         storage-assigned ordering belongs to the record
create AgentSystemMessage                     a system instruction is Context material, not history
put a provider SDK type into a message        providerState carries opaque JSON only
interpret providerState payload               Agent, Context and Coding never read it
let a projector return a system message       AIConversationMessage excludes it by type
add a conversation_turns table before it is agreed
replace a frozen contract by convenience      the Freeze is the authority, not the implementation
enable full multimodal / image / audio / file provider payloads
implement retry, timeout, cancellation, budget, verification or Run lifecycle here
```

Dependency direction is unchanged: `agent` may depend only on `ai` and `protocol` (plus `ajv`);
`ai` may depend on no `@caelush/*` package at all; compatibility always flows legacy → target, never
target → legacy.

---

## 2. Phase 5A — the round this document fixes in detail

### 2.1 Authorised scope

```text
additive refinement of the existing @caelush/ai message contract
AgentMessage identity, audience, source and content
the canonical Message Factory
persistence contracts (record, draft, stored) without any storage implementation
versioned durable codecs and their immutable registry
versioned, provider-neutral model projectors and their immutable registry
ConversationTurn, AgentConversationSnapshot and the Conversation Validator
ExecutionUnit identity and grouping
the projected ConversationSelector primitive
public root exports and Phase 5A architecture guards
```

### 2.2 The questions 5A must be able to answer

```text
who owns the AI message language?            @caelush/ai  (existing, additively refined)
who owns the Agent message language?         @caelush/agent
is AgentMessage a rename of AIMessage?       no — different union, different discriminant,
                                             different provenance, different durability
who mints a message id?                      @caelush/agent Message Factory, before storage
who decides a conversation turn id?          a deterministic factory over RunId
who decides the projection version?          the projector registry; the codec registry asks for it
who owns storage ordering?                   the store; the record carries it, the message never does
who owns the transcript?                     no one yet — 5E
who owns durable storage?                    no one yet — 5B
```

### 2.3 Forbidden deliverables

```text
declaring the new types and wiring nothing                the registries, validator, unit builder
                                                          and selector must exist and be tested
a second AI message implementation                        refinement only, never a parallel shape
a second JSON vocabulary                                  reuse AI JsonObject / JsonValue
a silent default projection version                       injected authority or fail closed
a storage implementation                                 no SQL, no schema, no migration
a production cutover                                     Run, Context and Client are untouched
deep-import-only public surface                          everything reachable from the package root
```

### 2.4 Milestones inside 5A (not rounds)

```text
A  source reconciliation and acceptance map      the two Phase 5 documents
B  AI message additive refinement                packages/ai/src/messages/**
C  Agent message identity                        packages/agent/src/messages/types/ids.ts
D  core AgentMessage types                       packages/agent/src/messages/types/**
E  Message Factory                               packages/agent/src/messages/types/message-factory.ts
F  persistence contracts                         packages/agent/src/messages/persistence/**
G  versioned codecs and registry                 packages/agent/src/messages/codec/**
H  versioned AI projection and registry          packages/agent/src/messages/projection/**
I  conversation domain                           packages/agent/src/messages/conversation/**
J  ExecutionUnit V2                              packages/agent/src/messages/conversation/execution-unit.ts
K  ConversationSelector                          packages/agent/src/messages/conversation/selector.ts
L  public exports                                packages/agent/src/messages/index.ts, src/index.ts
M  behaviour tests and the independent-use test  packages/agent/test/messages/**
N  compatibility preservation                    production contracts unchanged
O  documentation, verification, commit, push     reports, guards, gates
```

### 2.5 Transition boundary 5A deliberately preserves

```text
RunExecutionStore          still commits AIMessage through RunExecutionMessageAppend
Storage                    still owns the pre-V2 agent_messages schema; no migration is added
ContextEngine              still assembles AIMessage history; ContextPrepareInput.history is unchanged
AgentLoop                  still validates AIMessage history with the legacy validator
Client                     still reads a run-based transcript; hydrateSessionTranscript is untouched
CodingAgent                composes no custom message; only the declaration-merging seam exists
```

The AI history validator (`assertConversationProtocolIntegrity`, `assertPendingAssistantHistory`) is
**not** deleted and **not** extended. It remains the compatibility authority for the language
production currently speaks, and it retires in 5C / 5D with that language.

---

## 3. Verification model

```text
per round        the round's target tests, the Phase 3/4 guards, the daemon regression suites,
                 the full gate set below, and the round's own architecture guard
whole phase      every round's evidence plus the 5F acceptance run
architecture     new violations 0, stale baseline entries 0, READY; the baseline never grows
```

Full gate set used by every round:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm check:architecture:ci
pnpm test
pnpm exec vitest run --maxWorkers=1     the serial authoritative result
git diff --check
prettier --check <changed files>
```

Tests are evidence of behaviour and migration authority, never a completion metric: a round does not
finish by adding tests, and it never finishes by deleting assertions, lowering a bound, or adding a
skip.

---

```text
5A  COMPLETE
5B  not started
5C  not started
5D  not started
5E  not started
5F  not started
```

> Phase 5A established the Message System V2 domain foundation and stopped there. No database
> migration, no durable-conversation cutover, no Context production cutover and no
> Transcript/Client cutover has started. Evidence:
> [PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md](PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md) and
> [PHASE_5A_MESSAGE_DOMAIN_FOUNDATION_REPORT.md](PHASE_5A_MESSAGE_DOMAIN_FOUNDATION_REPORT.md).

---

## 4. Round completion references

A completed round links its own evidence here. Recording a completion does not change the round
decomposition above.

```text
5A  docs/architecture/v2/PHASE_5A_MESSAGE_DOMAIN_ACCEPTANCE_MAP.md
    docs/architecture/v2/PHASE_5A_MESSAGE_DOMAIN_FOUNDATION_REPORT.md
    tests/architecture/phase-5a-message-domain-boundaries.test.ts
```
