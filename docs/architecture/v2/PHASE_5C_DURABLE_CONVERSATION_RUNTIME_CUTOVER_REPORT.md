# Phase 5C Durable Conversation Runtime Cutover — Report

Date: 2026-09-23

Status: the Phase 5C implementation is present in the current working tree. No remote 5C commit
has been published from this checkout.

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
| Final tip              | Working tree based on the base SHA; the implementation is not committed yet                          |
| Remote tip             | No `origin/deepseek/architecture-v2-phase-5c-durable-conversation-runtime-cutover` ref is published  |
| Ahead / behind         | Not applicable until a local commit exists                                                           |
| Working tree           | Intentionally dirty with the Phase 5C implementation, tests, maps, plan, and report                  |

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

| Check                                 | Result                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                          | PASS                                                                                                                                                  |
| `pnpm typecheck`                      | PASS                                                                                                                                                  |
| `pnpm lint`                           | PASS                                                                                                                                                  |
| `pnpm check:architecture:ci`          | PASS — 0 new violations, 0 stale baseline entries, 26 frozen baseline entries, READY                                                                  |
| Full Vitest run through `pnpm check`  | PASS — 458 files passed, 3368 tests passed, 5 skipped, 0 failed                                                                                       |
| Final focused Phase 5C suites         | PASS — 109 tests passed                                                                                                                               |
| `pnpm exec vitest run --maxWorkers=1` | INCONCLUSIVE — no progress or failure output after approximately five minutes; interrupted, matching the pre-existing host-level serial startup stall |
| Changed-file Prettier check           | PASS — all Phase 5C tracked and untracked changed files                                                                                               |
| `git diff --check`                    | PASS                                                                                                                                                  |
| `pnpm check` functional stages        | PASS — architecture, lint, build, typecheck, tests, and build completed                                                                               |
| Repository-wide `pnpm format:check`   | BLOCKED by inherited repository baseline — 763 files report Prettier differences                                                                      |

The repository-wide format gate still reports inherited CRLF/style differences outside this round;
only the Phase 5C changed-file set was formatted. Windows test runs may print the known `node-pty`
`AttachConsole failed` diagnostic while still completing successfully; it did not cause test
failures.

Clean-detached-checkout, empty-DB, legacy-fixture, and remote-parity checks are not claimed because
there is not yet a local final commit or published 5C remote ref. They should run after commit and
push.

## Phase status

```text
5A COMPLETE
5B COMPLETE
5C COMPLETE (implementation in this working tree; serial full-suite verification is host-blocked)
5D NOT STARTED
5E NOT STARTED
5F NOT STARTED
```
