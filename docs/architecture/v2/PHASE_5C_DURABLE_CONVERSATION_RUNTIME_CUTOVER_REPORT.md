# Phase 5C Durable Conversation Runtime Cutover — Report

Date: 2026-09-23

Status: the Phase 5C implementation is committed and pushed. The implementation commit is
`f82e586091230bda91eebb4d5519493648b711b7`; this report is being finalized in a subsequent
documentation commit after clean-checkout verification.

## Git record

| Field                  | Evidence                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Base SHA               | `683d9dd38dd1fc9aab95d5a29976cfe58679ca22`                                                           |
| Branch                 | `deepseek/architecture-v2-phase-5c-durable-conversation-runtime-cutover`                             |
| Acceptance-map head    | `docs/architecture/v2/PHASE_5C_DURABLE_CONVERSATION_RUNTIME_CUTOVER_ACCEPTANCE_MAP.md`               |
| Contract/refactor head | `packages/agent/src/run/ports/run-execution-store.ts`, `packages/core/src/run-agent-history.ts`      |
| Storage-cutover head   | `packages/storage/src/run-execution-store.ts`                                                        |
| Tool-feedback head     | `packages/agent/src/tools/observation/model-feedback-projector.ts`                                   |
| Verification head      | `tests/architecture/phase-5c-durable-conversation-runtime-cutover.test.ts` and the commands below    |
| Documentation head     | This report and `docs/superpowers/plans/2026-09-23-phase-5c-durable-conversation-runtime-cutover.md` |
| Implementation head    | `f82e586091230bda91eebb4d5519493648b711b7`                                                           |
| Final tip              | The documentation-finalization commit containing this report; exact SHA is recorded after commit     |
| Remote tip             | `f82e586091230bda91eebb4d5519493648b711b7` before this documentation-finalization commit             |
| Ahead / behind         | `0 / 0` at the implementation tip; rechecked after documentation finalization                        |
| Working tree           | Clean at the implementation tip; documentation finalization creates the only subsequent change       |

## Authority before and after

Before 5C, the Run execution snapshot exposed an `AIMessage` compatibility view backed by the
legacy conversation write path. After 5C, the durable Run authority is raw
`AgentMessageRecord[]`; `AIMessage[]` exists only as a Core-side compatibility projection while
the Context/AgentLoop public boundary remains in its pre-5D shape.

The production message path is now:

```text
AgentMessageFactory
  -> CodecRegistry
  -> AgentMessageRecordDraft
  -> SqliteRunExecutionStore transaction
  -> V2 agent_messages row
```

The daemon composes one canonical factory, ID factory, clock, conversation-turn factory, codec
registry, and projector registry. Core receives a narrow message authority. Storage loads and
appends raw V2 records and does not decode semantic messages into AI history.

Global Message Migration Stage A is active for new production writes: new USER, ASSISTANT, and
TOOL_RESULT messages are V2-backed only. Dual-read compatibility, legacy physical columns, legacy
row readers, and deterministic physical projections remain for later migration work. Stage C has
not started.

## Runtime ordering

The production start path persists a Factory-created USER record in the same atomic transition that
moves the Run out of PENDING, before Context preparation, AgentLoop execution, or provider IO. The
first Run in a Session is `source.origin = GOAL`; later Runs are `FOLLOW_UP`, determined from
durable Session/Run ordering. Recovery uses Run/Session/turn/source facts, not a role scan, and
reuses an existing durable USER.

The controller appends an ASSISTANT record only after provider completion, stream validation, and
decision classification succeed. The Factory preserves ordered text/tool-call parts and the real
model-turn call ID, model reference, finish reason, optional usage, and provider state. The record
is committed atomically with the existing Step/State/Continuation/Run and durable-event settlement.
Provider failures, invalid decisions, and cancelled/partial streams do not create a normal
Assistant record.

`ModelToolFeedbackProjector` returns `{ message, receipt }` plus Core-private observation provenance
without widening the frozen ToolTurnResult contract. Each accepted projection has a deterministic
fingerprint and `SNAPSHOT` policy. Executed outcomes map to `OBSERVATION { observationId }`; rejected
and skipped outcomes map to `NO_OBSERVATION`.

```text
Tool settlement
  -> projected feedback + receipt
  -> AgentToolResultMessage Factory
  -> V2 durable Run commit
  -> next Agent/provider turn
```

The Tool records are committed atomically with the existing continuation/state/event settlement.
The Core-private observation channel is carried through `RunToolTurnObservation`; the frozen
ToolTurnResult remains unchanged.

## Recovery and compatibility boundary

The Run history bridge decodes each raw record using its stored schema version and projects it using
its stored model projection version. Unknown visible versions fail closed. Durable current-turn
USER and TOOL_RESULT messages back the compatibility `AgentTurnInput` and are not duplicated into
the provider history. Previous-session `historyPrefix` behavior remains intact.

The SQLite execution store appends V2 records through the existing outer transaction and the
transaction-neutral message append helper. Core never preallocates message sequence values. The
legacy conversation repository remains available only for compatibility/read or migration
surfaces; it is no longer the production Run execution writer.

An observation may be durable before its ToolResult message. Recovery deterministically regenerates
the same bounded content, receipt, and provenance and appends the message before provider resume.
A committed ToolResult is reused rather than duplicated.

Phase 5D is not started: Context/Replay, AgentLoop history, `ContextPrepareInput.history`, and
session `historyPrefix` still use the temporary AI compatibility projection. No transcript/client
cutover was added. Legacy database compatibility and `@caelush/llm` compatibility pieces remain
5F concerns.

## Verification

| Check                                      | Result                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                               | PASS                                                                                                                                                  |
| `pnpm typecheck`                           | PASS                                                                                                                                                  |
| `pnpm lint`                                | PASS                                                                                                                                                  |
| `pnpm check:architecture:ci`               | PASS — 0 new violations, 0 stale baseline entries, 26 frozen baseline entries, READY                                                                  |
| Full Vitest run on implementation worktree | PASS — 458 files passed, 3368 tests passed, 5 skipped, 0 failed                                                                                       |
| Final focused Phase 5C suites              | PASS — 10 files, 109 tests passed                                                                                                                     |
| `pnpm exec vitest run --maxWorkers=1`      | INCONCLUSIVE — no progress or failure output after approximately five minutes; interrupted, matching the pre-existing host-level serial startup stall |
| Changed-file Prettier check                | PASS — all Phase 5C tracked and untracked changed files                                                                                               |
| `git diff --check`                         | PASS                                                                                                                                                  |
| `pnpm check` functional stages             | PASS — architecture, lint, build, typecheck, tests, and build completed                                                                               |
| Repository-wide `pnpm format:check`        | BLOCKED by inherited repository baseline — 762 files report Prettier differences                                                                      |

The repository-wide format gate still reports inherited CRLF/style differences outside this round;
only the Phase 5C changed-file set was formatted. Windows test runs may print the known `node-pty`
`AttachConsole failed` diagnostic while still completing successfully; it did not cause test
failures.

### Clean detached checkout

Clean checkout path: `D:\Develop\Caelush-phase5c-clean-20260923`

Clean checkout HEAD was `f82e586091230bda91eebb4d5519493648b711b7`, matching the pushed remote
implementation tip. The worktree started without `dist`, `tsbuildinfo`, `node_modules`, or local
SQLite artifacts. `pnpm install --frozen-lockfile` passed.

Clean verification results:

| Check                                                                 | Result                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Build                                                                 | PASS                                                                                                                      |
| Typecheck                                                             | PASS                                                                                                                      |
| Lint                                                                  | PASS                                                                                                                      |
| Architecture                                                          | PASS — 0 new, 0 stale, 26 frozen, READY                                                                                   |
| Phase 5C targeted suites                                              | PASS — 10 files, 109 tests                                                                                                |
| Empty-DB migration and daemon production E2E                          | PASS — 4 files, 6 tests                                                                                                   |
| Legacy backfill, dual-read, V2 physical-row and production E2E suites | PASS — 3 files, 28 tests                                                                                                  |
| Full parallel Vitest                                                  | PASS — 458 files, 3368 passed, 5 skipped, 0 failed                                                                        |
| Full serial Vitest                                                    | INCONCLUSIVE — zero progress/failure output after approximately five minutes; interrupted as host serial startup blockage |

The clean migration suite verifies the formal empty-DB migration path; the clean daemon production
E2E starts from a temporary empty database, creates Session/Run state, executes the real provider and
Tool path, and reloads durable storage. The clean Storage suites verify V2-backed rows, required
physical fields, legacy compatibility columns, backfill and no duplicate V2/legacy read behavior.

## Final publication record

The implementation commit was pushed with:

```text
git push -u origin deepseek/architecture-v2-phase-5c-durable-conversation-runtime-cutover
```

At the implementation tip, local and remote were equal, ahead/behind was `0 / 0`, and the working
tree was clean. The report update itself is the final documentation-only change; after committing
and pushing it, the final SHA and remote parity are recorded in the closing Git output rather than
predicted here.

## Phase status

```text
5A COMPLETE
5B COMPLETE
5C COMPLETE (serial full-suite measurement is INCONCLUSIVE only because of reproducible host startup blockage)
5D NOT STARTED
5E NOT STARTED
5F NOT STARTED
```
