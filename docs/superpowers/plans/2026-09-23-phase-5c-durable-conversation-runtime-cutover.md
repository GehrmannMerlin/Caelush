# Phase 5C Durable Conversation Runtime Cutover

## Brief and authority

Implement the supplied Phase 5C specification on branch
`deepseek/architecture-v2-phase-5c-durable-conversation-runtime-cutover`.
The supplied specification and
`docs/architecture/v2/PHASE_5C_DURABLE_CONVERSATION_RUNTIME_CUTOVER_ACCEPTANCE_MAP.md`
are binding. The plan is an execution ledger, not a new architecture proposal.

Global constraints:

- No Phase 5D work and no new future phase/round.
- Preserve legacy physical columns, backfill and compatibility APIs; new production writes are V2
  backed only.
- Do not change Tool algorithms, completion authority, retry/budget ownership, Context's final
  cutover, or AgentLoop's frozen `RunToolTurnResult` contract.
- Follow TDD for each behavior change: write the smallest failing test, run it and observe failure,
  then implement the smallest change and rerun the focused test.
- Finish with `pnpm check`, architecture CI, parallel and serial Vitest evidence, changed-file
  formatting/diff checks, and an honest report of any environment-only gate that remains blocked.

## Task 1 — Freeze contracts and acceptance guards

Add/adjust the Phase 5C architecture test and focused contract tests before production behavior:

- `tests/architecture/phase-5c-durable-conversation-runtime-cutover.test.ts`
- Agent RunExecutionStore contract tests for records/drafts and no AI durable field
- ModelToolFeedbackProjector receipt contract tests
- Storage guard asserting raw V2 loading/appending only

Expected: the new tests fail against the 5B implementation for the intended reasons, with no
unrelated baseline failure hidden.

## Task 2 — Cut the RunExecutionStore contract and raw Storage adapter

Change the Agent port to `conversationRecords: AgentMessageRecord[]` and
`RunExecutionMessageAppend { draft: AgentMessageRecordDraft }`. Update Core aliases and all storage
view types. Change `SqliteRunExecutionStore` to use `SqliteAgentMessageRecordStore` and its
transaction-neutral append helper in every atomic commit path, while retaining derived legacy columns
and backfill. Remove Storage's AI conversion/legacy message append imports.

Expected: storage tests prove V2 rows are the new writes, sequence remains SQLite-owned, and a fault
inside the transaction rolls back the whole Run commit.

## Task 3 — Compose and materialize semantic User/Assistant messages

Introduce the narrow Core message-authority/materializer seam. The daemon composes one canonical
Factory, CodecRegistry and ProjectorRegistry. Materialize USER before Context/provider; distinguish
GOAL/FOLLOW_UP by Session ordering. Materialize ASSISTANT only for a completed, valid model turn with
preserved metadata and ordered TEXT/TOOL_CALL parts. Feed only drafts to the store and keep the AI
projection at the compatibility edge.

Expected: crash-before-provider, exact-once user, follow-up origin, assistant rejection, metadata,
ordering and atomic-failure tests pass.

## Task 4 — Durable-record history compatibility projection

Update `run-agent-history.ts` and its Core callers to accept raw durable records, decode through the
codec registry, project through the projector registry, and derive the frozen AI turn input without
duplicating the already durable current user. Preserve prior-session `historyPrefix` and the temporary
Context/AgentLoop compatibility seam. Unknown visible versions fail closed.

Expected: initial Context regression, Tool resume input, no duplicate current input and previous-session
history tests pass.

## Task 5 — Tool feedback receipts and durable ToolResult settlement

Change `ModelToolFeedbackProjector.project()` to return `ProjectedToolFeedback {message, receipt}`
without changing the frozen ToolTurnResult contract. Make new projections carry policy `SNAPSHOT`,
observation vs `NO_OBSERVATION` provenance, exact projected content and deterministic fingerprints.
Carry the Core-private receipt/provenance through `RunToolTurnObservation`; materialize ordered
Factory-created TOOL_RESULT drafts and atomically commit them with continuation/state/events before
provider resume. Add observation-gap regeneration and after-commit idempotency tests.

Expected: projection, bounding, receipt, ordered batch, crash-gap and atomic settlement tests pass.

## Task 6 — Recovery and daemon production composition

Wire `RunController` recovery/start paths and daemon composition so no production path creates a
durable AI message directly. Audit all Run/CandidateBoundary/Tool paths for atomic draft append,
identity-based idempotency and absence of legacy helper calls. Keep restart recovery at durable record
boundaries.

Expected: integration/fault-injection tests cover user, assistant and tool boundaries and the daemon
composition guard reports exactly one canonical authority set.

## Task 7 — Full verification and report

Add `docs/architecture/v2/PHASE_5C_DURABLE_CONVERSATION_RUNTIME_CUTOVER_REPORT.md` with changed
files, authority matrix, test matrix, architecture counts, format/diff status, clean-checkout/DB
evidence and any honest blocker. Run build, typecheck, lint, architecture CI, parallel Vitest
measurement, serial authoritative Vitest, changed-file Prettier and `git diff --check`, then inspect
`git status --short` and `git diff`. Perform a fresh whole-branch self-review using the plan/spec if no
reviewer tool is available.

Expected: all required gates pass, or the final response states the exact frozen blocker and does not
claim completion.

## Shared-interface pre-flight

- Task 2 produces the raw-record snapshot/append contract consumed by Tasks 3–6.
- Task 3 produces the canonical message-authority seam consumed by Tasks 4–6.
- Task 5 produces the Core-private feedback receipt consumed by Tasks 6–7.
- Task 7 consumes every prior task's verification evidence and the final acceptance map.

## Review focus

- Any hidden AI/legacy durable write path.
- Nested SQLite transaction or Core-preallocated message sequence.
- Duplicate current user/tool result in compatibility history.
- Assistant record created for invalid/cancelled/failed provider output.
- Tool feedback receipt policy/provenance mismatch or non-idempotent recovery.
- Daemon creating more than one canonical message authority.
