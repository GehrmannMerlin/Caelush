# Caelush Phase 12D — Interactive Control, Session Resume & Transport Recovery

## Status and scope

This design implements the user-supplied Phase 12D brief. The brief is the
approved architecture source: Phase 12D adds CLI control-plane interaction and
durable Session/transport recovery, while daemon, Core, Security, Approval,
Cancellation and Recovery authority remain server-owned. Phase 12E work is
explicitly out of scope.

The implementation is based on the Phase 12C branch at
`92783cf26fbbe3e6dd72faeb99ff384782e09187` in the dedicated worktree
`D:/Develop/Caelush/.worktrees/phase-12d-interactive-control-session-recovery`.
The local `git fetch origin --prune`/`git ls-remote` gate was attempted but the
host Git Schannel TLS handshake failed; the local 12C branch and its remote
tracking ref both resolve to the expected SHA. This network limitation is a
verification item, not an authorization to invent a remote SHA.

### In scope

- Typed launch intents: `NEW`, `CONTINUE`, `RESUME_PICKER`, and `RESUME_EXACT`.
- Workspace-safe exact Session resume and bounded current-workspace candidate
  selection.
- Durable public transcript hydration from historical Runs.
- Discovery and attachment of non-terminal Runs, including PENDING confirmation.
- Live Approval dialog with safe allowlisted presentation and exact Approval ID.
- Canonical cancel control for all cancellable Run states and Ctrl+D detach.
- Bounded SSE reconnection, durable cursor continuity, stream generations and
  one recovery admission per connection generation.
- Explicit CLI control/transport/error view state and input precedence.
- Unit, component, client, integration and file-backed SQLite E2E coverage.
- Architecture and Phase 12D documentation updates.

### Out of scope

Daemon auto-start/process lock, packaging, non-interactive or pipe mode,
platform terminal matrices, Web UI, MCP, Browser, Computer Use, Session
fork/rename/archive/delete, model picker, slash commands, new RunStatus values,
new Core/Storage APIs, historical raw Tool Timeline hydration, and any Phase
12E feature remain deferred.

## Current code characterization

The 12C CLI in this worktree currently behaves as follows:

| Surface                                      | Observed behavior                                                                                                                                                                    | Phase 12D consequence                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/application/cli-controller.ts` | Constructor creates a new `WorkspaceRef` ID; `bootstrap()` health-checks, gets info, and always calls `createSession()`; `submitPrompt()` creates a Run, watches it, then starts it. | Move launch selection and workspace identity into bootstrap/resume policy; keep new Run creation only for `NEW` or a ready resumed Session. |
| `apps/cli/src/components/App.tsx`            | One `useInput` handler treats both Ctrl+C and Ctrl+D as local exit and prints that the Run continues.                                                                                | Route controls by precedence; Ctrl+C calls `cancelRun`, Ctrl+D detaches.                                                                    |
| SSE consumption                              | `consumeRunEvents()` projects events into the existing reducer; any non-abort stream failure writes `fatalError: "Transport error"` and leaves the Run locked.                       | Transport failure becomes recoverable view state, preserves Run status, and starts bounded reconnect.                                       |
| Timeline                                     | `timeline-reducer.ts` already validates durable sequence order, ignores exact replays and leaves ephemeral events cursorless.                                                        | Reuse it for cold replay from zero and reconnect from `lastDurableSequence`; do not add a second reducer.                                   |
| Terminal settlement                          | A terminal event calls `getRun()`, derives only verified final text or a safe terminal notice, and clears the active Run.                                                            | Centralize this same settlement gate for SSE, cancel response, cold replay and reconnect replay.                                            |
| `apps/cli/src/main.tsx`                      | No argument parser; controller receives only workspace path; bootstrap failure unmounts and returns 1.                                                                               | Parse argv before React, pass a typed LaunchIntent, and keep fatal bootstrap errors distinct from recoverable control errors.               |

The Client already exposes `listSessions`, `getSession`, `listRuns`, `getRun`,
`startRun`, `recoverRun`, `cancelRun`, `listPendingApprovals`,
`resolveApproval`, and `watchRunEvents`. CLI code must use these methods and
must not hand-build `/api/v1/...` requests. The one additive transport API is
an optional `onOpen` callback on `WatchRunEventsOptions`.

The daemon Supervisor semantics are:

- `start` schedules a PENDING Run, returns `SCHEDULED`, returns
  `ALREADY_ACTIVE` for an in-memory active operation, and returns
  `NOOP_TERMINAL` for a terminal Run.
- `recover` schedules non-PENDING, non-terminal recovery, returns
  `SCHEDULED`, `ALREADY_ACTIVE`, or `NOOP_TERMINAL`; PENDING recovery is a
  conflict.
- `resolveApproval` checks Run status and Approval ownership/scope before
  scheduling resolution; the CLI must use the exact Approval ID.
- `cancel` delegates to Core cancellation, reloads the Run, and returns
  `SETTLED` with the reloaded canonical Run. `SETTLED` is not synonymous with
  `CANCELLED`; UI state must read `response.run.status`.

Session repository ordering is `updated_at_ms DESC, id ASC`. Run repository
ordering is `created_at_ms DESC, id ASC`, so CLI candidate enrichment and
transcript hydration must make ordering explicit. `RunService.createRun()` does
not update `Session.updatedAt`; `--continue` therefore derives activity from
the newest Run (`finishedAt ?? startedAt ?? createdAt`) with Session timestamp
as fallback.

## Research table

Only primary or official documentation was used for external research.

| Source                                                                                                                                                                                                                                                                                                                                           | Observed design                                                                                                                                                           | Absorbed                                                                                                                                                     | Deferred                                                                                              | Rejected / reason                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)                                                                                                                                                                                                                                               | The server owns approval flow; requests carry thread/turn identity; clients return a decision; resume reopens the same stored thread and streams lifecycle notifications. | Server-owned pending control, exact identity correlation, inline activity control, hydrate/resume before continuing live work.                               | Codex JSON-RPC, Thread/Turn/Item protocol, fork/cloud threads, provider-specific approval amendments. | None of the Codex wire protocol is copied because Caelush contracts are Session/Run/ApprovalRequest/AgentEvent.                      |
| [Codex approval event models](https://github.com/openai/codex/blob/main/codex-rs/tui/src/approval_events.rs) and [approval overlay](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs)                                                                                                                  | TUI normalizes server requests into a view model and renders the available decisions; request identity and decision options are explicit.                                 | A pure public-safe Approval view model, bounded options, disabled submit while in flight, and explicit Escape behavior.                                      | Raw command/stdin display, execpolicy/network amendments, Codex-specific option names.                | Raw Approval action JSON is rejected for privacy and Phase 9 semantics.                                                              |
| [Codex session lifecycle](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/session_lifecycle.rs), [session resume](https://github.com/openai/codex/blob/main/codex-rs/tui/src/session_resume.rs), and [thread lifecycle](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | Resume resolves workspace/cwd deliberately, restores history and live subscription state, and can replay pending server requests for an active thread.                    | Workspace identity continuity, explicit current-directory safety, history hydration before active work, and pending Approval lookup before generic recovery. | Forking, cross-project/global pickers, pagination UI, remote workspace behavior.                      | Silent `chdir` and inferred workspace IDs are rejected because they can make the model context appear restored while losing history. |
| [Codex ThreadState](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/thread_state.rs) and [AppEvent](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app_event.rs)                                                                                                                                                   | Server tracks pending requests against active thread state; control actions are distinct from user message submission.                                                    | Control-plane actions are separate from prompts; stale control responses cannot mutate a newer generation.                                                   | Codex app event names and server request IDs.                                                         | No Caelush RunStatus or protocol change is introduced.                                                                               |
| [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [Manage sessions](https://code.claude.com/docs/en/sessions), [Interactive mode](https://code.claude.com/docs/en/interactive-mode), and [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)                                     | `--continue` resumes the latest conversation in the current directory; `--resume` selects a session; sessions are project-bound; Ctrl+C interrupts active work.           | The four launch modes, current-workspace filtering, explicit picker, same-session resume, and interrupt-versus-detach distinction.                           | Fuzzy/name resume, session fork/rename, slash commands, print/pipe mode, permission-mode switching.   | Claude-specific transcript files, session names and permission implementation are not copied into Caelush.                           |

## Chosen approach

Three approaches were considered:

1. **Incremental controller orchestration (chosen).** Keep
   `CliConversationController` as the application authority, add pure helpers
   for parsing, session candidates, transcript mapping, Approval state and
   reconnect scheduling, and add small presentational components. This fits the
   existing 12C shape, minimizes public API churn, and makes every race
   testable without React or HTTP.
2. **A new CLI state-machine package.** Put all lifecycle transitions in a
   standalone reducer/service and make the current controller an adapter. This
   gives a stronger formal state machine but creates a second orchestration
   boundary and would require broad rewrites of the already-working Timeline
   path for no Phase 12D benefit.
3. **React-owned async hooks.** Put resume, Approval and reconnect effects in
   components. This is rejected because timers, generation tokens and control
   races would become view-lifecycle dependent and would violate the rule that
   components do not call the Client directly.

The chosen approach uses these boundaries:

- `cli-args.ts`: pure argv parser; no React, HTTP or process mutation.
- `session-resume.ts`: pure workspace matching, candidate ordering, activity
  derivation, legacy workspace safety, and public transcript hydration.
- `cli-control.ts`: pure control generation, Approval selection/resolution
  mapping, input precedence and terminal-settlement guards.
- `reconnect-scheduler.ts`: injectable clock/timer-free scheduler port with
  deterministic delays `[250, 500, 1000, 2000, 4000, 5000]` ms, one active
  sequence, manual retry reset, generation invalidation and dispose.
- `cli-state.ts`: explicit transport/control/error/Approval view state; no
  new RunStatus values.
- `CliConversationController`: coordinates Client calls, reconciliation,
  stream generations, active Run attachment, recovery admission and state
  publication. It is the only CLI layer that calls the Client.
- React components: render safe state and route the highest-priority input
  surface; they do not own timers, repositories, HTTP, or recovery policy.

## Launch and Session lifecycle

### LaunchIntent and parser

`parseCliArgs(argv: readonly string[])` returns a discriminated union:

```ts
type LaunchIntent =
  | { readonly kind: "NEW" }
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "RESUME_PICKER" }
  | { readonly kind: "RESUME_EXACT"; readonly sessionId: SessionId };
```

Accepted forms are no args, `-c`/`--continue`, `-r`/`--resume`, and
`-r <sessionId>`/`--resume <sessionId>`. The parser rejects conflicting flags,
extra values, unknown flags, and malformed Session IDs with a safe parse error.
`main()` parses before constructing React; components never inspect argv.

### Bootstrap modes

Every mode first calls `getHealth()` and `getInfo()`. A missing public default
model or default Run configuration is fatal. `NEW` creates exactly one new
WorkspaceRef and Session, preserving the existing 12C title/model behavior.
Resume modes never call `createSession()` before selecting the Session.

`CONTINUE` calls `listSessions({ limit: 100 })`, filters to the normalized
current workspace, and enriches each candidate with at most one
`listRuns(sessionId, { limit: 1 })` request using bounded concurrency of 8.
Its activity is `latestRun.finishedAt ?? latestRun.startedAt ??
latestRun.createdAt ?? session.updatedAt`; candidates sort by activity
descending then Session ID ascending. No match displays
`No conversation found to continue in this workspace.` and exits with code 1.

`RESUME_PICKER` displays at most 100 current-workspace candidates ordered by
the same deterministic activity rule. It does not create a Session while the
picker is open. Up/Down selects, Enter resumes the exact selected ID, and Esc
exits the picker without a new Run. Candidate rows contain only title, short
Session ID, and safe activity time.

`RESUME_EXACT` calls `getSession(sessionId)`. If the stored default WorkspaceRef
exists, its complete `{ id, path }` is reused only when its normalized path
matches the current cwd. A mismatch fails safe with
`This Session belongs to another workspace. Start Caelush from that workspace to resume it.`
The CLI never changes cwd and never silently attaches another directory.

Legacy Sessions without `defaultWorkspace` may derive a workspace only by
listing all visible Runs and finding exactly one distinct WorkspaceRef. Zero or
multiple identities fails with
`Session cannot be resumed safely because its workspace identity is ambiguous.`
The current cwd plus a newly generated WorkspaceRef ID is never a legacy
fallback.

After selecting the Session and WorkspaceRef, transcript hydration lists up to
100 Runs, sorts by `createdAt ASC, id ASC`, and maps only public conversation:

- Every Run contributes its goal as one user entry.
- A `COMPLETED` Run contributes assistant text only if
  `VerifiedRunFinalResultSchema` passes.
- Failed, cancelled, timed-out, max-step and budget terminal Runs contribute a
  safe terminal notice.
- A completed Run with an invalid/missing final result contributes
  `Run completed without a verified final result.`.
- Tool observations, raw args, stdout, patches, reasoning, provider payloads,
  Continuation JSON and internal rows never enter the transcript.

The selected active Run's goal is included once by hydration. Timeline replay
never appends another user entry. Historical Runs are chronological, while
only the selected active Run receives full AgentEvent replay.

New Runs in a resumed Session use `session.defaultModel` when available,
otherwise `DaemonInfo.defaultModel`; they always use the current daemon
`defaultRunConfiguration` for runtime, permission profile, approval policy and
limits. Historical Run governance is never copied into the new Run.

### Non-terminal Run policy

After hydration, the controller lists Session Runs and identifies
`PENDING`, `RUNNING`, `WAITING_APPROVAL`, and `VERIFYING` Runs. Zero enables the
composer. One attaches it. Multiple opens a bounded Run Recovery Picker with
status, goal preview, short ID and created time; it never guesses newest.
While any non-terminal Run remains, the composer cannot create a new Run. After
the selected Run reaches terminal status, the controller refreshes the list and
returns to the recovery picker if another non-terminal Run remains.

PENDING requires an explicit `Start this Run?` confirmation and calls
`startRun(runId)` only after confirmation. RUNNING and VERIFYING attach the
stream first and then admit at most one `recoverRun(runId)` for that connection
generation. `ALREADY_ACTIVE` is normal; `SCHEDULED` is normal after daemon
restart. WAITING_APPROVAL first calls `listPendingApprovals(runId)`: a non-empty
result opens the Approval control, and an empty result calls `recoverRun()` so
Core decides whether the request expired, resolved or was cancelled.

## Approval control

The controller receives live `approval.requested` events and resume-time
`listPendingApprovals` results. It stores pending requests keyed by
`approval.id`, sorted by `createdAt ASC, id ASC`; multiple requests require
explicit selection. The dialog displays only title, reason, risk level, tool
name, required capability strings and an allowlisted safe action summary. It
never renders `JSON.stringify(approval.action)`, raw command/patch/stdin,
approval keys, credentials, provider payloads or secrets. Generic action JSON
is treated as untrusted and only known scalar/array fields are copied.

The Approval dialog's initial selected option is `REJECT`. For an ONCE request
the options are Approve once and Reject. For a RUN-capable request they are
Approve once, `Approve this action for this Run`, and Reject. Mappings are
exactly `{ action: "APPROVE", scope: "ONCE" }`,
`{ action: "APPROVE", scope: "RUN" }`, and `{ action: "REJECT" }`.
The RUN label never implies blanket permission.

The component calls only `controller.resolveApproval(approvalId, resolution)`.
The controller increments the control generation, performs a fresh
`listPendingApprovals(runId)` check immediately before resolving, and sends at
most one HTTP request per Approval ID while in flight. Submit disables the
dialog and shows `Resolving approval...`. Esc closes the dialog only; it does
not reject or cancel the Run. An `approval.resolved` event or a stale lookup
closes/reconciles the dialog. Conflicts refetch Run and pending Approvals; they
are recoverable control errors, not fatal App replacement. A response from an
older generation cannot reopen an Approval after cancellation or terminal
settlement.

## Cancellation and detach

When an active Run exists, Ctrl+C invokes `controller.cancelActiveRun()` and
never submits a prompt. The controller enters `CANCELLING`, invalidates the
current control generation, and deduplicates repeated Ctrl+C into one in-flight
Client call. It permits cancellation from RUNNING, WAITING_APPROVAL, VERIFYING,
WAITING_RETRY-as-exposed-RUNNING, and transport-disconnected states.

The UI displays `Cancelling...` until the Client response or a terminal SSE
event is reconciled. A cancel response uses `response.run.status` as
canonical: `SETTLED` with COMPLETED displays Completed, and only a canonical
CANCELLED Run displays Cancelled. If HTTP fails, no fake cancellation is
shown; the active Run remains available for retry and the UI displays
`Cancellation could not be confirmed. The Run may still be active.` A terminal
event and cancel response share one terminal settlement gate, so assistant
text, terminal notice, history entry and composer enablement occur once.

Ctrl+D with an active Run aborts only the local stream, prints
`The active Run continues in the local daemon.`, and exits without a cancel
request. With no active Run, Ctrl+C and Ctrl+D retain simple exit behavior.

## SSE transport recovery

`CliTransportState` is `CONNECTED | RECONNECTING | DISCONNECTED`; it is a CLI
view state and never a RunStatus. `transportError`, `controlError`, `notice`,
and `fatalError` are separate view channels. Protocol incompatibility, invalid
CLI arguments, unsafe Session workspace and invalid daemon configuration are
fatal. Temporary stream loss, stale Approval, manual reconnect requirement and
temporary cancel failure are recoverable.

`watchRunEvents` accepts:

```ts
interface WatchRunEventsOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
  readonly onOpen?: () => void;
}
```

The Client calls `onOpen` exactly once only after a successful HTTP response,
valid body and reader creation; it never calls it for HTTP/fetch/protocol
errors, pre-open abort, or iterator creation alone.

Each cold attach, resume attach and reconnect gets a new stream generation and
AbortController. The event consumer checks both the active Run identity and
generation before projection; late events/errors from an old stream are
ignored. Cold Session resume starts at `afterSequence = 0`. Reconnect reads
the current Timeline `lastDurableSequence` immediately before opening and
starts strictly after it. Ephemeral events never move this cursor. The
existing Timeline reducer performs duplicate and sequence validation.

On stream failure for a non-terminal active Run, the Run remains active and the
scheduler enters RECONNECTING. Attempts wait deterministically for 250ms,
500ms, 1s, 2s, 4s and 5s; no jitter or unbounded loop is used. A successful
`onOpen` resets the view to CONNECTED and resets the attempt counter. After six
failures, the view becomes DISCONNECTED and shows:

```text
Connection to the local Agent service was lost.
The Run may still be active.
Press R to reconnect.
Ctrl+C to attempt cancellation.
Ctrl+D to detach and exit.
```

R starts the same Run's scheduler from attempt one; it never creates a Run.
Dispose cancels the timer and stream. On a successful connection generation,
RUNNING/VERIFYING gets at most one recovery admission; WAITING_APPROVAL still
uses pending Approval lookup first. Transport failure never changes a durable
Run to FAILED.

## Input precedence and components

There is one active input router, not multiple competing `useInput` handlers.
The precedence is:

1. Session Picker
2. Approval Dialog
3. PENDING Run confirmation
4. Disconnected controls
5. Normal active Run controls
6. Composer

`ApprovalDialog.tsx`, `SessionPicker.tsx`, and `RunRecoveryPicker.tsx` render
their supplied view models and keyboard selection only. They do not perform
HTTP or recovery. Header/ActivityStatus show transport and control state
alongside Run activity, allowing `RUNNING + RECONNECTING` to coexist.

## Verification design

Implementation follows strict TDD for each behavior: write one failing test,
run it and observe the expected missing-behavior failure, implement the minimum
code, run the focused test green, then refactor without changing behavior.

Coverage must include:

- Parser forms/conflicts; candidate bound, workspace filter, activity ordering
  and deterministic ties.
- Exact/legacy workspace identity and path reuse; model/security continuity.
- Historical transcript mapping, invalid final result and active goal exactly
  once.
- PENDING confirmation; RUNNING/VERIFYING recovery; Approval-first recovery;
  multiple active Run selection.
- Approval default Reject, scope-specific options, exact ID, stale/external
  resolution, conflict refetch, privacy and double-submit lock.
- Ctrl+C cancellation in every listed state, canonical response status,
  cancellation/Approval and cancellation/SSE races, and Ctrl+D zero cancel.
- Scheduler delay sequence, cursor, `onOpen`, generation invalidation,
  duplicate replay, manual retry, exhaustion and dispose.
- Ink input precedence and component-safe rendering.
- Real daemon + SQLite + Dispatcher/Security/Verification E2E for Approval,
  Reject, Cancellation, SSE reconnect, daemon restart, and ORANGE-731
  conversation continuation. Only the external LLM provider is fake.
- Architecture guards proving CLI depends only on client/protocol/UI packages
  and has no Core/Storage/Runtime/Security/Tools/Verification/LLM or direct
  SQLite/filesystem/shell/Git access.

Required verification is serialized: baseline and final
`pnpm lint`, `pnpm typecheck`, plain `pnpm test`, `pnpm build`, focused tests,
clean-build verification, `git diff --check`, and `pnpm check` evaluation.
The actual 12D format baseline is 773 warning files. New/changed files must
have zero Prettier warnings and total warning count must not exceed 773; do not
run `prettier --write .`.

## Acceptance boundaries

The Phase 12D completion report may claim completion only after the complete
document checklist is evidenced, including remote/base verification (or an
explicit network blocker), dedicated branch/worktree, all focused/E2E and
regression tests, clean build, formatting gate, architecture audit, pushed
branch SHA equality and clean working tree. After that report, stop; do not
implement Phase 12E.
