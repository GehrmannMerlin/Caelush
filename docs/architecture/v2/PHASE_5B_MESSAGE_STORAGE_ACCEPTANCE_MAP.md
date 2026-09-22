# Phase 5B — Message Storage Acceptance Map

```text
Phase 5B   Durable Message Storage Foundation
base       e46a6cc882278956c72687a53d6a5085fd16c092   (Phase 5A final tip)
branch     deepseek/architecture-v2-phase-5b-message-storage-foundation
state      BLOCKED at Gate 3 — see §3 and
           PHASE_5B_MESSAGE_STORAGE_GATE3_BLOCKED_EVIDENCE.md
```

This map was written **before any production code was modified** (Milestone A), as the round requires.
It records every frozen requirement against the Phase 5A source, the owner, the migration action, the
compatibility requirement, the test and the exit phase.

---

## 0. Authority and provenance

### 0.1 The two authorising Message documents

```text
Caelush_Message_System_V2_Current_to_Target_Interface_Freeze.md
Caelush_Message_System_V2_Refactor_Spec.md
```

Neither is present anywhere in the repository tree at this baseline. They remain **externally supplied
authorising specifications**, exactly as Phase 5A recorded them. No repository path is claimed for
either and no reconstruction is committed.

### 0.2 Authority order applied

```text
1  the Phase 5B implementation prompt
2  the Interface Freeze
3  the Refactor Spec
4  PHASE_5_MESSAGE_SYSTEM_ROUND_PLAN.md
5  the Phase 5A acceptance map and report
6  Power 5A final source
7  Phase 2 / 3 / 4 frozen contracts
```

Where the Freeze and the Phase 5A implementation disagree, the Freeze wins — which is precisely what
Gate 3 turns on (§3).

### 0.3 Baseline re-measured at the Phase 5A tip

```text
git status --short                     clean
git rev-parse HEAD                     e46a6cc882278956c72687a53d6a5085fd16c092
git merge-base --is-ancestor <5A tip> HEAD
                                       0 — the 5A tip is an ancestor
drizzle committed migrations           12
architecture baseline                  26 entries, 0 new, 0 stale, READY
```

Both counts match the Phase 5A record exactly. No Phase 5A history was rebased, amended, reset or
squashed; the Phase 5B branch starts at the 5A tip.

---

## 1. Gate 1 — Stage A and the 5C writer cutover

### 1.1 The requirement

```text
Interface Freeze, Migration Stage A:   Dual Read; New Write = V2 only
PHASE_5_MESSAGE_SYSTEM_ROUND_PLAN:     RunExecutionStore writer cutover = Phase 5C
```

### 1.2 Resolution

These are consistent once the subject of each statement is named, and the round plan is more specific
about _which writer_:

```text
Storage V2 substrate                 Stage A/B CAPABLE            Phase 5B
Production Run writer                still legacy compatibility   until 5C
Global Migration Stage A activation  Phase 5C                    the Run writer is the writer
```

**5B must not claim the production system has entered Stage A.** Stage A is a statement about
_writers_, and the only production conversation writer in this repository is the Run execution path —
`RunExecutionStore.commit()` → `RunExecutionMessageAppend.message` → `appendConversationMessagesInTransaction`.
That writer is untouched by 5B, so Stage A has not been activated.

### 1.3 Required wording

```text
correct     the V2 storage substrate is Stage A/B capable; existing rows are backfilled under
            Phase 5B; the production Run writer is still legacy compatibility; the global
            Stage A writer cutover is reserved for Phase 5C
forbidden   "Global Stage A COMPLETE"
```

### 1.4 What 5B must therefore not touch

```text
packages/agent/src/run/ports/run-execution-store.ts
  RunExecutionMessageAppend.message        stays AIMessage
  RunExecutionSnapshot.conversation        stays AIMessage-backed
  messagesToAppend                         stays AIMessage[]
```

An architecture guard asserts this (§ reference 127), so the boundary cannot erode silently.

---

## 2. Gate 2 — legacy `data_json` versus V2 `data`

### 2.1 The conflict

```text
current   agent_messages.data_json   = a complete LLMMessage JSON
target    AgentMessageRecord.data    = the type-specific payload only
```

```text
USER         data = { content }
ASSISTANT    data = { content, model, providerState? }
TOOL_RESULT  data = { toolCallId, toolName, observationId, isError, projectedContent, projection }
```

The legacy production reader still needs an `LLMMessageSchema`-compatible `data_json` until 5C, so the
existing column cannot simply be re-typed in place.

### 2.2 Decision: **ADDITIVE COLUMNS**, not a shadow table

Both strategies are permitted by the Freeze. Additive columns are chosen.

| Consideration               | Additive columns                                                                      | Shadow table                                                         |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| legacy writer compatibility | untouched — it writes the columns it always wrote and ignores the new ones            | untouched, but the two tables must then agree about row identity     |
| sequence authority          | one table, one `UNIQUE (run_id, sequence)`; a single `MAX(sequence)` is authoritative | two sequence spaces that must be reconciled forever and can disagree |
| dual-read cost              | one row read, then a decision about which representation it carries                   | a join, plus a second ordering pass                                  |
| 5C atomic append            | the Run commit already writes `agent_messages`; V2 append is the _same_ statement     | the Run commit would have to write two tables atomically             |
| 5F Stage C                  | drop the legacy columns, keep the table — a rebuild, not a merge                      | merge two tables that may have diverged                              |
| failure mode                | a row is legacy-only, or V2-backed, never partly both                                 | a row exists in one table and not the other, twice                   |

The deciding argument is **sequence**. `agent_messages` already owns `UNIQUE (run_id, sequence)` and the
Run commit already appends into it inside one `BEGIN IMMEDIATE`. A shadow table would create a second
ordering authority for the same logical conversation, and 5C would have to reconcile two sequence
spaces inside the transaction that is supposed to be atomic. Additive columns keep exactly one.

### 2.3 The transitional physical shape

```text
agent_messages                    legacy columns, preserved and still authoritative for the
                                  legacy reader
  run_id                          PK part
  sequence                        PK part; the store's ordering authority
  role                            legacy discriminant
  source_step_id                  legacy step pointer
  protocol_version                legacy encoding version
  created_at_ms
  data_json                       LEGACY: a complete LLMMessage JSON

agent_messages                    V2 columns, added by the 5B migration, nullable until Stage C
  message_id                      text, NULL for legacy-only rows
  session_id                      text, NULL for legacy-only rows
  conversation_turn_id            text, NULL for legacy-only rows
  message_type                    text, NULL for legacy-only rows
  schema_version                  integer, NULL for legacy-only rows
  model_projection_version        integer, NULL for legacy-only rows and for model=false messages
  source_json                     text, NULL for legacy-only rows
  audience_json                   text, NULL for legacy-only rows
  v2_data_json                    text, NULL for legacy-only rows; holds AgentMessageRecord.data
```

### 2.4 Why the V2 payload column is separate, and what it is called

```text
data_json      legacy LLMMessage JSON      still read by the legacy reader     until 5F
v2_data_json   AgentMessageRecord.data     read by the V2 record store         until Stage C
```

The name is deliberately `v2_data_json` rather than a reuse of `data_json`, and it is deliberately
**not** part of the §30 final target list. It is a _transitional_ column whose whole purpose is to keep
two encodings apart while both must exist. At Stage C the rebuild moves the V2 payload into `data_json`
and drops `v2_data_json`, at which point the table matches §30.

**No row ever claims both.** A row is legacy-only (`v2_data_json IS NULL`) or V2-backed
(`v2_data_json IS NOT NULL`). The store is the only writer of the V2 columns, and it writes them as one
statement with the row.

### 2.5 Forbidden approaches, and why each is refused

```text
overwriting data_json in place        would break the legacy reader before 5C exists
letting the legacy reader read V2     it would decode a type-specific payload as an LLMMessage
deleting the legacy reader in 5B      that is the 5C cutover, not the storage foundation
one column claiming both encodings     a reader could not tell which it had, and neither could a human
```

### 2.6 Indexes

```text
UNIQUE (message_id) WHERE message_id IS NOT NULL   partial, so legacy-only NULLs do not collide
(run_id, sequence)                                 already exists; unchanged
(session_id, message_id)                           session reads
(conversation_turn_id)                             turn grouping
(message_type)                                     type lookup
```

The partial unique index is the SQLite-correct form of "unique when present": a plain `UNIQUE` would
reject the second and every later legacy-only `NULL` row.

### 2.7 No `conversation_turns` table

Confirmed: none is created. A turn is derived from Run metadata plus message rows (§4).

---

## 3. Gate 3 — legacy ToolResult backfill feasibility

```text
VERDICT   BLOCKED. There is no legal construction of a faithful
          AgentToolResultMessage / TOOL_RESULT record from a legacy role = "tool" row.
```

The complete source-verified evidence, the exact missing historical facts, the affected row classes and
the minimum contract decision are recorded in
[PHASE_5B_MESSAGE_STORAGE_GATE3_BLOCKED_EVIDENCE.md](PHASE_5B_MESSAGE_STORAGE_GATE3_BLOCKED_EVIDENCE.md).

Summary of the two independent missing facts:

```text
1  observationId
   AgentToolResultMessage.observationId is REQUIRED and non-optional.
   A durable role = "tool" row does not always have an observation:
     - agent_messages (migration 20260829090000) predates tool_invocations and
       agent_observations (migration 20260829160000)
     - an observation-less result is a REACHABLE production state: tool-batch pre-execution
       rejection, the uncertain-execution skip barrier, RESOURCE replan synthetic results and
       budget-exceeded completed results all project to AgentToolResult, and AgentToolResult has
       no observationId field at all
   An ObservationId that names no observation row is a fabricated execution truth.

2  projection.policy
   ToolFeedbackProjectionReceipt.policy is a REQUIRED ToolObservationPolicySnapshot with two
   positive safe-integer limits. Phase 5A declares no unknown variant.
   The historical per-row snapshot was never durably recorded per message: it lives on the
   WAITING_TOOL_RESULTS continuation checkpoint, is written when the Tool boundary opens, and is
   replaced or cleared when the results are committed. For any settled historical row it is gone.
   The only surviving value is the Run's *current* checkpoint policy, which is a different fact.
```

Neither is a migration bug. Both are the frozen contract requiring a fact the durable record never
held, which is exactly the contradiction the round's Gate 3 was written to detect.

---

## 4. Gate 4 — `loadSnapshot()` Run metadata

### 4.1 The requirement

```ts
AgentConversationRepository.loadSnapshot({ sessionId, currentRunId })
  → AgentConversationSnapshot     whose ConversationTurn carries status, openedAt and closedAt?
```

`AgentMessageRecordStorePort` stores messages only, so it cannot supply Run status or Run timestamps.

### 4.2 Resolution: inject a narrow metadata reader at construction

The frozen `AgentConversationRepository` interface is unchanged. The implementation factory takes a
private dependency:

```ts
interface ConversationRunMetadataReader {
  read(runId: RunId): Promise<
    | {
        readonly runId: RunId;
        readonly sessionId: SessionId;
        readonly createdAt: TimestampMs;
        readonly finishedAt?: TimestampMs;
        readonly terminal: boolean;
      }
    | undefined
  >;
}
```

What it may **not** be:

```text
RunController · Database · SQLite client · Drizzle client · Workspace · Runtime · Context Engine
```

It is a value lookup with five fields. The Storage implementation satisfies it by reading the
`agent_runs` row it already owns; nothing about a Run's lifecycle authority moves.

### 4.3 Field derivation

```text
status      conversationTurnStatus(metadata.terminal)      never inferred from the last message
openedAt    metadata.createdAt                             never the first message's createdAt
closedAt    metadata.finishedAt, and only when CLOSED
            an OPEN turn must carry no closedAt — the 5A turn constructor enforces this
```

### 4.4 `listBySession` reconciliation

The frozen port declares `listBySession?` as optional, and 5B keeps it optional. The repository factory
requires a store that _has_ it, expressed structurally and without changing the frozen base port:

```ts
type SessionReadableAgentMessageRecordStore = AgentMessageRecordStorePort &
  Required<Pick<AgentMessageRecordStorePort, "listBySession">>;
```

A store without session reads composes no repository. The optional member is not promoted to
mandatory.

### 4.5 Turn grouping and ordering

```text
group records by runId
order runs by   Run.createdAt, then Run.id
order messages  by record.sequence
current Run must be a turn of the Session, and currentTurnId must be that Run's turn  (fail closed)
```

The deterministic turn identity is `createDeterministicConversationTurnIdFactory()` — never the
clock-seeded default, because a cross-process migration must agree with itself.

### 4.6 Empty Run conversation

A Run may have no messages. 5B does not invent a policy: it builds the snapshot and hands it to the
Phase 5A `AgentConversationValidator`, and whatever that validator accepts is accepted. The validator
requires the current Run to have a turn, and a turn with zero messages satisfies it — so an empty
current turn is legal and 5B does not contradict it.

---

## 5. Frozen requirement → owner → action → exit

### 5.1 Agent-owned contracts

| Frozen requirement                          | Current source                     | Target owner     | Migration action                            | Compatibility requirement                         | Test                                                           | 5C exit                         | 5F exit                        |
| ------------------------------------------- | ---------------------------------- | ---------------- | ------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| `AgentMessageRecordStorePort`               | absent — Phase 5A declared no port | `@caelush/agent` | declare exactly as frozen                   | none: a new contract                              | `packages/agent/test/messages/conversation-repository.test.ts` | implemented by Storage          | unchanged                      |
| `AgentConversationRepository`               | absent                             | `@caelush/agent` | declare + implement over the codec registry | must not import SQLite, Storage, Context, Coding  | same file                                                      | becomes the Run writer's reader | unchanged                      |
| `ConversationRunMetadataReader`             | absent                             | `@caelush/agent` | private injected seam, not a frozen name    | Storage supplies it; no lifecycle authority moves | same file                                                      | unchanged                       | removed with the legacy reader |
| `deriveLegacyAgentMessageId`                | absent                             | `@caelush/agent` | pure, deterministic, clock-free helper      | must satisfy the 5A `AgentMessageId` shape        | `packages/agent/test/messages/message-domain.test.ts`          | used by 5C backfill too         | removable                      |
| `AgentMessageRecord` / `StoredAgentMessage` | Phase 5A                           | `@caelush/agent` | unchanged                                   | frozen                                            | Phase 5A suite                                                 | unchanged                       | unchanged                      |

### 5.2 Storage

| Frozen requirement              | Current source                                    | Target owner       | Migration action                                                      | Compatibility requirement                                        | Test                                                       | 5C exit                  | 5F exit                        |
| ------------------------------- | ------------------------------------------------- | ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ | ------------------------------ |
| V2 physical substrate           | `agent_messages` has 7 legacy columns             | `@caelush/storage` | one committed migration: additive nullable V2 columns + indexes       | legacy writer keeps working untouched                            | `packages/storage/test/message-v2-migration.test.ts`       | writes V2                | Stage C rebuild into §30       |
| `SqliteAgentMessageRecordStore` | absent                                            | `@caelush/storage` | implement the Agent-owned port                                        | must not decode semantics, project AI or transcript              | `packages/storage/test/agent-message-record-store.test.ts` | the V2 writer            | unchanged                      |
| sequence authority              | `appendConversationMessagesInTransaction` owns it | `@caelush/storage` | one transaction-neutral helper + one transaction-owning wrapper       | exactly one sequence space                                       | `packages/storage/test/message-v2-atomicity.test.ts`       | reused by the Run commit | unchanged                      |
| append-only                     | n/a                                               | `@caelush/storage` | no update/replace/delete API                                          | frozen                                                           | architecture guard §174                                    | unchanged                | unchanged                      |
| unknown-record preservation     | n/a                                               | `@caelush/storage` | raw store reads and returns unknown `message_type` / `schema_version` | never delete, rewrite or downgrade                               | `packages/storage/test/message-v2-dual-read.test.ts`       | unchanged                | unchanged                      |
| legacy compatibility reader     | `SqliteConversationRepository`                    | `@caelush/storage` | keep as-is, mark compatibility, add a quarantined legacy codec        | production callers unaffected                                    | `packages/storage/test/conversation-repository.test.ts`    | 5C switches the writer   | deleted                        |
| dual read                       | absent                                            | `@caelush/storage` | V2-first reconciliation by `(runId, sequence)`                        | never return legacy + V2 for one position; conflict fails closed | `packages/storage/test/message-v2-dual-read.test.ts`       | unchanged                | legacy arm deleted             |
| deterministic backfill          | absent                                            | `@caelush/storage` | idempotent, restart-safe, legacy-source-preserving                    | **cannot complete for tool rows — see §3**                       | `packages/storage/test/message-v2-backfill.test.ts`        | n/a                      | straggler sweep + verification |

### 5.4 Why the storage substrate was not built either

The round's own rule is to resolve the four gates **before writing a migration**, and Gate 2's decision
(§2.2) is not separable from Gate 3's: the additive-column strategy exists to make a _complete_ backfill
possible, and a backfill that cannot represent a tool row has no defined target for that column.

Partial backfill is not a legal fallback, and this round verified why rather than assuming it:
`AgentConversationValidator.validateModelVisibleToolStructure` requires a model-visible assistant Tool
call to be answered by a model-visible Tool result before the conversation continues. A conversation
whose assistant rows are V2 and whose tool rows are legacy-only therefore becomes history the target
validator **refuses** — for every Run that ever called a Tool. Building the columns and the store while
the representation of tool rows is undecided would produce a substrate whose primary consumer rejects
its own data.

```text
therefore   no migration was added, no table was altered, no store was written
            the substrate waits on the Gate 3 contract decision
```

### 5.3 Compatibility that must not move

| Frozen requirement                  | Current source                                             | 5B action | Test                                               | Exit  |
| ----------------------------------- | ---------------------------------------------------------- | --------- | -------------------------------------------------- | ----- |
| `RunExecutionMessageAppend.message` | `AIMessage` in `run/ports/run-execution-store.ts`          | unchanged | architecture guard; `run-execution-store*.test.ts` | 5C    |
| `RunExecutionSnapshot.conversation` | `AIMessage`-backed entries                                 | unchanged | same                                               | 5C    |
| `AgentLoopAdvanceInput.history`     | `AIMessage[]`                                              | unchanged | architecture guard; `agent-loop*.test.ts`          | 5C/5D |
| `ContextPrepareInput.history`       | `AIMessage[]`                                              | unchanged | architecture guard; `packages/context/test/**`     | 5D    |
| Client transcript                   | `Run.goal` + `finalResult` compatibility                   | unchanged | architecture guard; `packages/client/test/**`      | 5E    |
| AI history validator                | `loop/history/conversation-history.ts`                     | unchanged | architecture guard                                 | 5C/5D |
| Tool System                         | Preparer, durable coordinator, batch, settlement, builtins | unchanged | architecture guard; the Tool suites                | —     |
| Run lifecycle                       | RunController, CompletionGate, Verification, Retry, Budget | unchanged | architecture guard; the Run suites                 | —     |
| Custom message writes               | seam only, no arm                                          | disabled  | architecture guard §100                            | 5E    |

---

## 6. Identity rules

```text
message identity      deterministic from (runId, sequence), clock-free, and it must satisfy the
                      Phase 5A AgentMessageId shape (amsg_<UUIDv7-shaped>). It is derived by an
                      Agent-owned helper so Storage never becomes a semantic identity authority.
turn identity         createDeterministicConversationTurnIdFactory().forRun(runId)
session identity      draft.sessionId must equal agent_runs.session_id
step identity         a present sourceStepId must exist and belong to the same Run
ordering              the store assigns sequence; no caller may supply one
```

## 7. Sequence and atomicity

```text
append(runId, drafts) inside one BEGIN IMMEDIATE
  SELECT MAX(sequence) for the Run
  assign current+1 .. current+n, contiguous
  insert every row
  COMMIT

failure      the whole append rolls back, and the failed attempt consumes no durable sequence
concurrency  BEGIN IMMEDIATE serializes writers; no duplicate sequence, no interleaved batch
future       appendAgentMessageRecordsInTransaction(client, runId, drafts) takes no BEGIN and no
             COMMIT, so the 5C Run commit can compose it into its own transaction
```

## 8. Unknown-record policy

```text
raw record store        reads and returns any V2 row, including an unknown message_type or an
                        unsupported schema_version. It never deletes, rewrites or downgrades.
semantic repository     fails closed when no codec can decode the stored version.
dual read               a V2 row is canonical at its (runId, sequence). An unknown V2 row is NOT
                        skipped in favour of a neighbouring legacy row.
```

## 9. Test plan

```text
A  physical migration      fresh DB, legacy DB, re-run, partial failure, foreign keys, indexes,
                           legacy columns preserved
B  record store            append one, append batch, sequence start/continue, concurrency,
                           listByRun order, listBySession, uniqueness, session mismatch,
                           step/run mismatch, invalid JSON, invalid versions, model-visible
                           without a projection version
C  dual read               legacy-only, V2-only, matching pair, conflicting pair, unknown V2 type,
                           unsupported V2 schema, mixed run, mixed session
D  backfill identity       re-run yields the same ids, versions, data, source and audience;
                           user/assistant content fidelity; provenance stays LEGACY_MODEL_TURN
E  conversation repository append, listByRun, loadSnapshot single/multiple Runs, open and closed
                           Run, ordering, tie-break, sequence order, validator invocation,
                           wrong session, absent current Run
F  atomicity               fault injection at each boundary; the whole append rolls back;
                           a failed append consumes no sequence
G  regression              the existing Run/restart/Tool/Loop/Context/Daemon/Client suites
```

## 10. Acceptance gates

```text
contracts    the port and the repository are implemented, the frozen contracts unchanged,
             sequence only on the record/stored types, the projection version preserved,
             the codec registry remains the semantic decode authority
storage      the V2 substrate exists; append, listByRun and listBySession work; the store decodes
             no semantics and projects neither AI nor transcript
migration    fresh and legacy DB both work; dual read works; backfill is deterministic and
             idempotent; legacy data and columns preserved; custom writes disabled
identity     deterministic message and turn ids; session and step identity checked; monotonic sequence
unknown      unknown records preserved; semantic read fails closed; no destructive fallback
atomicity    batch append atomic; sequence assignment atomic; a failed append leaves no row and
             consumes no sequence; the transaction-neutral helper exists for 5C
compatibility the Run, Loop, Context, Client and Tool paths are unchanged
verification  build, typecheck, lint, architecture READY, 5A and 5B suites, full serial suite,
             changed-file formatting, diff-check, clean checkout, remote parity
```

## 11. Status

```text
5A  COMPLETE
5B  BLOCKED at Gate 3
5C  not started
```
