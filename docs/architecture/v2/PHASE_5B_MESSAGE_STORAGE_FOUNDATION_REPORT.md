# Phase 5B — Message Storage Foundation Report

```text
Phase  5B  Durable Message Storage Foundation
State  COMPLETE
Next   Phase 5C has not started
```

---

## 1. Git record

```text
base SHA                       e46a6cc882278956c72687a53d6a5085fd16c092   (Phase 5A final tip)
branch                         deepseek/architecture-v2-phase-5b-message-storage-foundation
blocked-evidence commit        752a2d16c12269078528d448c22cf2cb418aae12
errata commit                  d694f1c
contract-correction commit     41facdf
errata-tests commit            aa94efb
storage-ports commit           4044010
schema-migration commit        f8a6143
storage-implementation commit  2694ad8
verification commit            recorded in §9
final branch tip               recorded in §9
remote branch tip              recorded in §9
ahead / behind                 recorded in §9
working tree                   clean
```

### 1.1 The BLOCKED history was preserved, not rewritten

```text
752a2d16 is an ancestor of the final tip                    git merge-base --is-ancestor
the BLOCKED acceptance map and its Gate 3 section survive    recorded, then marked RESOLVED
the BLOCKED evidence dossier survives unrewritten            PHASE_5B_..._GATE3_BLOCKED_EVIDENCE.md
no reset, rebase, amend, squash or force push                none
```

The round halted correctly at Gate 3, was unblocked by a scoped contract correction, and then resumed
**inside the same Phase 5B** rather than as a new round. There is no `5B-1`, `5B-2` or `5B-Fix`.

### 1.2 Commit chain

```text
752a2d1  docs(architecture): map phase 5b durable message storage migration
d694f1c  docs(architecture): resolve phase 5b tool-result message freeze blocker
41facdf  refactor(agent): model tool-result observation and policy provenance explicitly
aa94efb  test(agent): cover tool-result provenance freeze errata
4044010  feat(agent): add durable message storage ports
f8a6143  feat(storage): add message v2 transitional schema
2694ad8  feat(storage): implement agent message record storage and dual read
+ the verification commit that amends the guards and records the round
```

---

## 2. Why this was a contract blocker, not a migration bug

The original frozen contract implied:

```text
every model-visible Tool Result necessarily corresponds to a ToolObservation
and necessarily knows the historical projection policy
```

Both halves are false, and the two are false for different reasons.

```text
observationId   the Tool System itself produces model-visible feedback with no execution behind it
policy          the per-row policy was never durably recorded per message
```

**The missing facts were never durable.** SQL cannot reconstruct information that never existed, and a
migration that tried would have had only two options, both fabrications:

```text
a synthetic ObservationId     asserts that something executed when nothing did
a default or current policy   asserts that history matched present configuration
```

Both would have written a fabricated fact into an **append-only, replayable** ledger, where a fabricated
value is indistinguishable from a true one forever.

### 2.1 The source evidence

```text
ToolBatchItemOutcome        OBSERVATION | REJECTED | SKIPPED
ModelToolFeedbackProjector  turns all three into a model-visible AIToolResultMessage
AgentToolResult             the Run Layer's frozen Tool-turn result — and it has no
                            observation field at all
```

So the Tool Layer never claimed what the Message contract required, and an observation-less Tool Result
is a reachable production state today: a pre-execution rejection, the uncertain-execution skip barrier,
a `RESOURCE` replan synthetic result and a budget-exceeded completed result all reach it.

```text
agent_messages            migration 20260829090000
tool_invocations          migration 20260829160000
agent_observations        migration 20260829160000
```

`agent_messages` predates the Tool ledger, so the oldest tool rows have no invocation and no observation
either.

```text
agent_run_continuations   runId PRIMARY KEY — one row per Run
observationPolicy         attached to the WAITING_TOOL_RESULTS checkpoint when a Tool boundary opens,
                          then replaced when the results commit
```

The only surviving policy value describes the **newest** Tool boundary, which is a different fact from
the policy that governed a settled historical row.

### 2.2 What the corrected contract records

```text
ToolResultObservationRef       OBSERVATION { observationId } | NO_OBSERVATION
ToolFeedbackProjectionPolicy   SNAPSHOT { snapshot } | LEGACY_UNKNOWN
```

The corrected contract records what is known, and explicitly records when execution evidence or
historical policy did not exist or cannot be recovered. `NO_OBSERVATION` is a **valid domain fact**, not
a failure state: it is never `UNKNOWN`, `NOT_LOADED` or `MIGRATION_FAILURE`, and nothing repairs it.

---

## 3. Migration stage wording — stated precisely

The Interface Freeze defines Migration Stage A as _Dual Read; New Write = V2 only_. The frozen round plan
assigns the `RunExecutionStore` writer cutover to Phase 5C. Both hold, because Stage A is a statement
about **writers**:

```text
V2 storage substrate              Stage A/B CAPABLE
existing rows                     backfilled under Phase 5B
production Run writer             still legacy compatibility
global Stage A writer cutover     reserved for Phase 5C
```

```text
5B does NOT claim "Global Stage A COMPLETE".
```

The only production conversation writer in this repository is the Run execution path —
`RunExecutionStore.commit()` → `RunExecutionMessageAppend.message` →
`appendConversationMessagesInTransaction`. Phase 5B did not touch it, so Stage A has not been activated.

---

## 4. Backfill ownership

```text
Phase 5B   the initial deterministic backfill of existing rows
Phase 5F   backfill verification, the straggler sweep, the proof that no legacy row remains, and Stage C
```

5B's backfill reports a structured result and never claims that no legacy row can ever appear again. The
pre-V2 writer keeps running until 5C, so a legacy-only row may still be created after this round; the
dual reader recognizes both encodings for exactly that reason.

---

## 5. `data_json` strategy

```text
data_json      the legacy LLMMessage JSON       read by the legacy reader   until Phase 5F
v2_data_json   AgentMessageRecord.data          read by the V2 record store until Stage C
```

```text
a row is legacy-only   (v2_data_json IS NULL)
     or V2-backed      (v2_data_json IS NOT NULL)
never both
```

Two encodings coexist with one authority each and neither able to be misread as the other. The V2 payload
column is deliberately _not_ the §30 final name: at Stage C the rebuild moves the V2 payload into
`data_json` and drops the legacy columns, at which point the table matches the frozen target.

**Additive columns were chosen over a shadow table**, and the deciding argument is **sequence**:
`agent_messages` already owns `UNIQUE (run_id, sequence)`, and the Run commit already appends into it
inside one `BEGIN IMMEDIATE`. A shadow table would create a second ordering authority for one logical
conversation and make the 5C atomic commit span two tables.

Every V2 column is nullable because the pre-V2 writer knows nothing about them and must keep working until
5C. Nullability is the compatibility surface this stage exists to provide, not laxity.

---

## 6. Tool Result migration — exactly what was and was not recovered

```text
recovered exactly
  projectedContent     the legacy content, byte for byte
  toolCallId           unchanged
  toolName             unchanged
  isError              unchanged
  messageId            deriveLegacyAgentMessageId(runId, sequence)   pure, clock-free
  conversationTurnId   the deterministic turn factory over the RunId   pure, clock-free
  source               LEGACY / user | assistant | tool
  audience             the Phase 5A per-kind defaults
  fingerprint          a digest over the exact content and error flag

recovered only when provable
  observationId        via (runId, stepId, externalCallId) → invocation → observation,
                       accepted ONLY when exactly one match exists

never recoverable, and therefore stated as unknown
  projection.policy    LEGACY_UNKNOWN for every migrated Tool row

never fabricated
  model call id, model reference, finish reason, usage   assistant rows stay LEGACY_MODEL_TURN
```

```text
ambiguity is not absence
  0 provable observations    NO_OBSERVATION — a real historical fact
  1 provable observation     OBSERVATION { id }
  >1 possible                the row FAILS CLOSED and is reported; it is never downgraded
```

### 6.1 The AI projection is unchanged by either arm

```text
observation OBSERVATION       the same model view NO_OBSERVATION would produce
observation NO_OBSERVATION    the same model view OBSERVATION would produce
policy      SNAPSHOT          the same model view LEGACY_UNKNOWN would produce
policy      LEGACY_UNKNOWN    the same model view SNAPSHOT would produce
```

This is what makes recording an unknown policy **safe**: `projectedContent` already _is_ the historical
model-visible truth, so historical replay cannot differ because a policy is unknown. An unknown policy is
not an unknown message.

---

## 7. Future 5C atomicity

```text
appendAgentMessageRecordsInTransaction(client, runId, drafts)   no BEGIN, no COMMIT
SqliteAgentMessageRecordStore.append()                           owns BEGIN IMMEDIATE … COMMIT
```

Phase 5C must commit the Run, its `AgentState`, the Step, the conversation messages, the continuation and
the durable events in **one** atomic execution commit. SQLite does not support nested transactions, so a
store that owned its own transaction would force 5C to either nest one or rewrite the append path.

The transaction-neutral helper exists now for exactly that reason. 5C composes it into its existing
`BEGIN IMMEDIATE` **without changing the sequence authority**: sequence assignment is still one
`SELECT MAX(sequence)` followed by one contiguous range, and it stays inside whichever transaction is
open.

```text
5B does NOT modify RunExecutionMessageAppend.message, RunExecutionSnapshot.conversation,
AgentLoopAdvanceInput.history or ContextPrepareInput.history.
```

### 7.1 5C will not need another Message shape change

The errata already expresses every Tool feedback outcome:

```text
executed            → OBSERVATION    + SNAPSHOT
rejected / skipped  → NO_OBSERVATION + SNAPSHOT
```

So 5C changes the **writer**, not the contract.

---

## 8. No fabrication — the round's negative record

```text
No synthetic ObservationId              an id still means exactly one agent_observations row exists
No fake ToolObservation                 ToolObservation remains real execution truth only
No default historical policy            LEGACY_UNKNOWN is stated instead of a default
No current-policy substitution          the surviving checkpoint describes a different boundary
No 0/0 or maximum policy                neither is a historical bound that was in force
No guessed model provenance             assistant rows stay LEGACY_MODEL_TURN
No re-projection of Tool content        projectedContent is copied byte for byte
No re-truncation                        a migration is not a Context projection
No dropped or deleted legacy row        an unsupported row is reported and preserved
No downgraded ambiguity                 >1 possible observation fails the row
No sentinel ObservationId               no "none", "legacy" or "synthetic" value exists
No second Tool Result message type      no LEGACY_TOOL_RESULT / MIGRATED_TOOL_RESULT
```

---

## 9. What Phase 5B does not do

```text
5B DOES NOT
  cut over the production RunExecution message writer to AgentMessage V2
  cut over AgentLoop history, ContextEngine history or the Client transcript
  wire the Tool pipeline into an AgentMessage writer
  remove the Stage C legacy columns or start the table rebuild
  retire LLMMessage conversation ownership
  enable Coding custom message writes
  modify the Tool System, the Run lifecycle, Verification, Retry or resource governance
  add a conversation_turns table
```

Each is asserted by an architecture guard as well as stated here.

---

## 10. Verification

See [PHASE_5B_MESSAGE_STORAGE_ACCEPTANCE_MAP.md](PHASE_5B_MESSAGE_STORAGE_ACCEPTANCE_MAP.md) for the
full gate record. Summary at the final tip:

```text
pnpm build                       PASS
pnpm typecheck                   PASS
pnpm lint                        PASS
pnpm check:architecture:ci       PASS — 26 baseline entries, 0 new violations, 0 stale, READY
pnpm exec vitest run             parallel measurement, recorded
pnpm exec vitest run --maxWorkers=1
                                 serial authoritative result, recorded
changed-file Prettier            PASS
git diff --check                 PASS
pnpm format:check                the inherited Phase 4F CRLF baseline, reported honestly
clean checkout                   PASS
remote parity                    local == remote, clean tree
```

### 10.1 Phase 5B test additions

```text
packages/storage/test/agent-message-record-store.test.ts     22 tests
packages/storage/test/migrations.test.ts                     extended for the 13th migration
packages/agent/test/messages/tool-result-provenance.test.ts  30 tests   (errata, four-state matrix)
packages/agent/test/messages/tool-feedback-regression.test.ts 5 tests   (real Tool System outcomes)
tests/architecture/phase-5b-message-freeze-errata.test.ts    24 tests   (scoped-correction guard)
```

### 10.2 Parallel-versus-serial, stated honestly

The parallel run reports timeouts in a handful of pre-existing architecture guards, all of the form
`Test timed out in 5000ms`. Every one of them **passes** when run serially or in a smaller batch, and the
Phase 5A round recorded the same host behaviour. One cause was found in this round's own new guard — a
per-assertion workspace walk — and was fixed by caching the file population and its text once, which took
it from ~6 s to ~1 s. No test was deleted, no assertion weakened and no skip added.

```text
serial authoritative    PASS
parallel               timeouts in pre-existing guards under host contention; none is a 5B regression
```

---

## 11. Final architecture

```text
@caelush/agent

  AgentMessage
    ├── USER
    ├── ASSISTANT
    └── TOOL_RESULT
          ├── OBSERVATION      a real ToolObservation stands behind it
          └── NO_OBSERVATION   no execution exists, by design

  ToolFeedbackProjectionPolicy
    ├── SNAPSHOT             the policy was known when the message was created
    └── LEGACY_UNKNOWN       the historical policy was never recorded

  AgentMessageRecordStorePort
  AgentConversationRepository
          │
          ▼
@caelush/storage

  SqliteAgentMessageRecordStore       the target V2 storage authority
  appendAgentMessageRecordsInTransaction   transaction-neutral, for the 5C Run commit
  Transitional Message V2 schema      additive nullable columns + a partial unique index
  Dual Read                           V2 first; conflicts fail closed
  Deterministic legacy backfill       idempotent, restart-safe, legacy source preserved
          │
          ▼
Production Run writer                 still legacy compatibility — Phase 5C's single cutover
```

---

```text
Phase 5B COMPLETE.

The Phase 5B blocker was resolved by a scoped Message Interface Freeze Errata.

The corrected Tool Result contract now distinguishes:

- feedback backed by a real ToolObservation
- feedback for which no ToolObservation exists

and separately distinguishes:

- a known projection-policy snapshot
- an irrecoverable legacy projection policy

No ObservationId or historical policy was fabricated.

Legacy Tool Result rows can now be migrated faithfully,
including rows produced by rejected or skipped Tool calls.

The durable Message V2 storage substrate, SQLite record
store, dual-read compatibility, deterministic backfill,
AgentConversationRepository and atomic sequence handling
are complete.

The production RunExecution message writer has NOT been
cut over to Message V2.

Phase 5C has not started.
```
