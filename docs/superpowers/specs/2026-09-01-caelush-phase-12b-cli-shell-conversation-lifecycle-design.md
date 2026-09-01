# Caelush V1 Phase 12B — CLI Application Shell & Durable Conversation Lifecycle

## Status and scope

This document records the Phase 12B design for the current Caelush repository. The
user-provided Phase 12B brief is the approved architecture source for this round;
this document turns its requirements into repository-specific interfaces and tests.

Phase 12B has two connected outcomes:

1. A daemon-backed, interactive Ink CLI that creates one durable Session per CLI
   process and submits one Run per prompt.
2. A durable Session-to-Run conversation policy that supplies bounded prior verified
   turns to later Runs without copying old Tool internals into the new Run ledger.

The daemon remains the only local Agent composition root. The CLI is a client and
presentation shell. It communicates with the daemon only through `@caelush/client`
and the existing HTTP/SSE surface. Phase 12B does not implement the detailed Agent
timeline, approval interaction, cancellation UX, session resume/reconnect, daemon
auto-start, or packaging reserved for later Phase 12 rounds.

The Phase 12 sequence remains exactly 12A, 12B, 12C, 12D, and 12E. This change does
not introduce a 12B sub-round or a new Phase 12 round.

## Delivery baseline and repository characterization

The Phase 12A remote delivery was freshly verified before this worktree was created:

- `origin/codex/phase-12a-production-daemon-client-transport` resolves to
  `1f5fde1bfe71ce26e69c4dbb4d7831bd0b05a562`.
- That SHA is an ancestor of `origin/master`, so the Phase 12B base is
  `origin/master` at the same SHA.
- The implementation branch is
  `codex/phase-12b-cli-shell-conversation-lifecycle` in
  `.worktrees/phase-12b-cli-shell-conversation-lifecycle`.

The real current code was characterized before implementation:

| Area                    | Current behavior                                                                                                                                                                                                   | 12B consequence                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli`              | `src/index.ts` is exactly `export {};`; there is no React, Ink, UI state, composer, bootstrap, or daemon call.                                                                                                     | Build the application shell from a clean boundary.                                                                                    |
| `@caelush/client`       | `CaelushClient` already exposes `getHealth`, `getInfo`, Session/Run CRUD, `startRun`, `recoverRun`, `cancelRun`, approval methods, and `watchRunEvents`; it validates JSON and SSE protocol data.                  | Reuse it directly. The CLI will not call `fetch` or recreate HTTP paths.                                                              |
| Session model           | `AgentSession` has a durable ID, optional default workspace/model, timestamps, and metadata. `SessionRepository` stores one row per Session.                                                                       | One CLI process creates one Session and keeps its ID for all prompts.                                                                 |
| Run model               | `AgentRun` has `sessionId`, one `goal`, its own lifecycle, workspace/model/runtime/policy/limits, and optional verified final result. `RunRepository.listBySession()` already supports one Session with many Runs. | A prompt creates a new Run; a Run is never reused for the next prompt.                                                                |
| Conversation repository | `ConversationRepository` is keyed by Run, and durable messages contain only user/assistant/tool-result messages.                                                                                                   | Prior Session context must be a derived, non-durable prefix; no new transcript table and no copied rows.                              |
| `RunController` input   | `executeLoop()` currently resolves a `RunExecutionConfig`, passes the Run conversation to `AgentLoop`, and drives retry/recover/verification repair through the same path.                                         | Add an optional Core config prefix and keep current-turn messages separate so retry/recover/repair do not duplicate the current goal. |
| `AgentLoop`             | `run()` accepts arbitrary prior `history` and creates the current user message; `resumeWithToolResults()` validates a complete open turn and preserves it.                                                         | A Session prefix can enter `history`; the existing ContextBuilder remains the token authority.                                        |
| ContextBuilder          | Validates/group conversations and enforces `maxConversationTokens` through its existing budget selector.                                                                                                           | The Session provider bounds Runs, but does not estimate, compact, or trim tokens.                                                     |
| Daemon                  | `composeDaemon()` owns the real Kernel/Tool/Runtime/Security/Verification graph; `DaemonInfo` currently exposes only a public default model and capability summary.                                                | Add server-known public Run defaults and compose a history provider in the daemon resolver.                                           |

The existing full baseline was also measured. `pnpm lint`, `pnpm typecheck`, and
`pnpm build` passed. Plain `pnpm test` under the initial Windows parallel run
reported `966 passed`, `5 skipped`, and `10 failed` across `981` tests; the failures
were 5-second timeout/resource-contention and process timing failures. The affected
representative files passed when run serially with a 30-second test timeout. The
repository format baseline is 724 Prettier warnings; changed files must add zero
warnings and the historical warning count must not increase.

## External research

Research was performed against current public primary sources on 2026-09-01. These
references inform presentation and lifecycle separation only; Caelush does not copy
their private protocols, product-specific commands, or session persistence formats.

| Source                                                                                                                                                                                                              | Observed design                                                                                                                                                                              | Absorbed in 12B                                                                                                                                                                                | Deferred or rejected                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI Codex CLI entry point](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs) and [TUI session lifecycle](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/session_lifecycle.rs) | The CLI entry point is a process shell around a richer server/session lifecycle; the TUI explicitly replaces or attaches conversation widgets while preserving server-owned thread identity. | Keep application/session lifecycle separate from Agent Core; treat project cwd as the primary interactive context; let the daemon remain lifecycle authority.                                  | No Codex thread picker, fork, subagent navigation, cloud task, or app-server protocol in 12B.                                                                     |
| [OpenAI Codex TUI app](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app.rs) and [chatwidget module](https://github.com/openai/codex/tree/main/codex-rs/tui/src/chatwidget)                            | The app shell owns attachment/startup and the chat widget owns prompt presentation; lifecycle transitions are explicit rather than inferred from output text.                                | Use a plain TypeScript controller plus a thin React/Ink renderer, with explicit bootstrap and terminal settlement states.                                                                      | No Codex UI cloning, hidden reasoning, timeline items, or detailed tool cards.                                                                                    |
| [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)                                                                                                                                              | Interactive sessions start in the current directory; continue/resume, model selection, and non-interactive output are distinct surfaces.                                                     | Tie a new Session to the current workspace, use a clear interactive prompt, and keep the V1 model/default policy server-owned.                                                                 | No resume picker, `--continue`, session naming UI, model picker, background agents, or slash-command ecosystem.                                                   |
| [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)                                                                                                                                    | Interactive products distinguish prompt editing from transcript viewing, provide visible active/inactive states, and treat multiline/paste as input concerns.                                | Keep settled transcript separate from dynamic activity/composer; support ordinary text, Unicode, emoji, and paste safely.                                                                      | No Ctrl+C cancellation semantics, queued prompts, Vim mode, shell mode, transcript viewer, or prompt suggestions.                                                 |
| [Ink components and lifecycle](https://github.com/vadimdemedes/ink)                                                                                                                                                 | `render()` owns the app lifecycle; `<Static>` renders append-only settled items while `<Box>`/`<Text>` render the live area; terminal hooks are no-ops in string tests.                      | Use one primary `<Static>` transcript region and a dynamic header/activity/composer region; use `waitUntilExit`/unmount for clean local disposal.                                              | No alternate-screen/fullscreen behavior or complete terminal resize hardening in 12B.                                                                             |
| [Ink releases](https://github.com/vadimdemedes/ink/releases) and [Ink text input](https://github.com/vadimdemedes/ink-text-input)                                                                                   | Current Ink 7 requires Node 22+ and React 19.2+; Ink text input supports controlled value, cursor navigation, `onChange`, `onSubmit`, and paste-related options.                             | Pin `ink` 7.1.1, `react` 19.2.8, `@types/react` 19.2.18, and `ink-text-input` 6.0.0 after checking the Node 24/React 19 compatibility. Use the component for the bounded single-line composer. | Do not add a second UI framework or a custom large readline editor. Full multiline editing is deferred; pasted newlines are preserved as text and must not crash. |
| [Ink testing library](https://github.com/vadimdemedes/ink-testing-library)                                                                                                                                          | Ink components can be tested with rendered frames without a real terminal session.                                                                                                           | Add focused component tests for public text and state, supplemented by controller/reducer tests.                                                                                               | Do not rely only on whole-screen snapshots.                                                                                                                       |

## Architecture

### Session history contract

The Core contract gains an optional, data-only field on `RunExecutionConfig`:

```ts
readonly historyPrefix?: readonly LLMMessage[];
```

This is a context prefix, not a durable ConversationRepository append. The Core
continues to know only the provider-independent LLM message contract and does not
import Storage or query SQLite.

The daemon implements a `SessionConversationContextProvider` over the existing
Session/Run repositories. For the current Run it selects at most
`MAX_SESSION_HISTORY_RUNS = 100` eligible prior Runs, then projects each to exactly:

```text
priorRun.goal                  → user message
priorRun.finalResult.text      → assistant message
```

Eligibility is fail-closed and requires all of the following:

- same `sessionId`;
- exact same workspace identity and path;
- `status === "COMPLETED"`;
- `finalResult` passes `VerifiedRunFinalResultSchema`;
- `finishedAt` exists;
- `finishedAt <= currentRun.createdAt`.

Candidates are sorted deterministically by `createdAt ASC`, then `id ASC`. The
provider selects the newest bounded suffix and returns that suffix in chronological
order. It never includes failed, cancelled, timed-out, max-step, budget-exceeded,
unfinished, invalid-final-result, different-session, different-workspace, or
late-finished Runs. It does not project tool calls, tool results, stdout, patches,
reasoning, intermediate assistant output, or provider data.

`ContextBuilder` remains the sole token authority. It receives the bounded prefix as
ordinary prior history and applies its existing conversation budget/compaction rules.
The provider does not add a second token estimator or silently truncate message text.

### Current-turn separation in RunController

`RunController.executeLoop()` resolves the config on every execution boundary so the
same policy applies to start, retry, recover, and verification repair. It builds the
AgentLoop input as follows:

- For a fresh or non-tool `AgentLoop.run()`, prepend `historyPrefix` to only the
  durable messages before the current Run's open turn. The current goal is then
  created once by `AgentLoop.run()`.
- For `resumeWithToolResults()`, prepend `historyPrefix` to the complete current Run
  conversation. The existing resume validator locates the current user message and
  preserves its assistant tool-call and normalized result messages.

The helper that splits the current Run turn is deterministic and only removes the
last user-led open group from the input passed to a fresh `run()` call. It does not
mutate the snapshot or durable ledger. This prevents a persisted user message from a
provider retry or verification repair from being duplicated as the current goal.
The prefix is recomputed from the immutable boundary `currentRun.createdAt`, so a
Run that retries or recovers cannot gain a newly completed concurrent Run.

The same prefix is used exactly once on every attempt. No prefix is appended to the
Run's `agent_messages` table, no current goal is copied into the prefix, and no
verification repair path injects the prior Session history a second time.

### Daemon public defaults

`DaemonInfo` is extended with a strict public `defaultRunConfiguration` object:

```text
runtime: { id: "local", kind: "local" }
permissionProfile: "PROJECT_ACCESS"
approvalPolicy: "DANGEROUS_ONLY"
limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 }
```

The values are the existing V1 production fixture defaults and contain no endpoint,
credential, database, or machine identity. The field is required for the new daemon
composition and is validated by Protocol. The CLI uses this object verbatim when it
creates a Run; it does not invent a separate set of product defaults. A daemon that
does not advertise the compatible field is reported as a sanitized protocol/config
compatibility error rather than submitting a partial Run.

`defaultModel` remains optional. A missing default model is a safe bootstrap error:
the CLI creates no Session and never enables the composer.

### CLI application shell

The CLI layers are:

```text
apps/cli/src/
  index.ts             process entry
  main.tsx             Ink render and lifecycle
  bootstrap/           URL/config/bootstrap state
  application/         controller, state, actions, event projection
  components/           App, Header, Transcript, ActivityStatus, Composer, FatalError
```

`CliConversationController` is a plain TypeScript object/class. It owns:

- daemon client construction from `CAELUSH_DAEMON_URL` or
  `http://127.0.0.1:43120`;
- `getHealth()` then `getInfo()` compatibility bootstrap;
- current cwd normalization and `createWorkspaceId()`;
- one Session creation with basename title, default workspace, default model, and
  empty metadata;
- prompt validation, UTF-8 bound checking, one-active-Run locking, and Run creation;
- starting event consumption before issuing `startRun()`;
- basic event projection with run identity filtering;
- terminal `getRun()` settlement and safe final-result parsing;
- stream abortion and subscription disposal.

The controller exposes view/application state, not a copy of Core `AgentState`:

```text
bootstrap: STARTING | CONNECTING | CHECKING_COMPATIBILITY |
           CREATING_SESSION | READY | BOOTSTRAP_ERROR
session: public Session projection
transcript: settled public entries
activeRun: { runId, status } | undefined
activity: Preparing | Working | Retrying | Verifying |
           Approval required | Transport error | ...
composerEnabled: boolean
fatalError: sanitized text | undefined
```

The submit sequence is:

```text
trim/check prompt
→ append optimistic public USER transcript entry
→ createRun(sessionId, daemon defaults + cwd workspace)
→ bind active Run identity
→ start watchRunEvents(runId)
→ startRun(runId)
```

The controller guards the entire submit operation so rapid Enter presses can create
only one Run. The composer is disabled immediately. An event from another Run is
ignored. A valid terminal event triggers exactly one canonical `getRun()` call for
the active Run; only a validated `finalResult.text` becomes an ASSISTANT transcript
entry. Other terminal statuses become one public `RUN_TERMINAL` entry without a
synthetic assistant answer. Stream failure becomes a transport-error activity and
does not rewrite the durable Run to `FAILED`; the composer remains blocked because
12B has no safe reconnect/recovery UX.

The CLI event projector accepts every valid `AgentEvent` schema value. It updates
only the small status set needed by 12B and ignores valid Tool/file/process/reasoning
detail events. It never throws for an unhandled but schema-valid event and never
places raw event payloads, Tool IDs, arguments, stdout, patches, provider output, or
hidden reasoning into the transcript.

### Ink rendering

The component tree is intentionally thin:

```text
<App state={viewState} actions={controllerActions}>
  <Header />
  <Static items={state.transcript}>
    <TranscriptEntry />
  </Static>
  <ActivityStatus />
  <Composer />
</App>
```

Settled entries are append-only and rendered by one primary `<Static>` region. Header,
activity, and composer remain dynamic. Text is plain wrapped text; no Markdown or
syntax renderer is added. Long project paths are bounded for display. The composer
uses `ink-text-input` with controlled value and `focus` tied to `composerEnabled`.
It supports typing, left/right navigation, backspace/delete provided by the selected
component, Unicode/Chinese/emoji, paste, and Enter submit. Empty/whitespace-only
input is ignored; pasted newlines remain safe input but are not a new multiline editor.

When there is no active Run, Ctrl+C/Ctrl+D exits the local CLI with code 0. If a Run
is active, 12B exits locally without sending cancellation and prints/retains a clear
daemon-continuation message through the normal exit path. It never kills the daemon
Run. Bootstrap failures render one safe message and exit with code 1; stack traces,
fetch internals, and provider error details are not rendered.

## Error handling and compatibility

- Unreachable daemon (`ECONNREFUSED`, fetch failure): sanitized “Caelush Local Agent
  Service is not reachable.” fatal state, exit 1.
- Invalid or incompatible `/info`: sanitized protocol compatibility fatal state,
  exit 1.
- Missing public default model or default Run configuration: safe configuration fatal
  state, no Session submission.
- HTTP errors: rely on `CaelushClientHttpError`'s bounded public error code/message;
  do not inspect Storage/Core internals.
- SSE failure: transport activity state, no durable Run status mutation, no automatic
  reconnect, no direct cancellation.
- Valid terminal event but missing/invalid canonical final result: terminal error state
  without fabricating assistant text.
- Valid unknown event: ignore for presentation while retaining the active Run lock.

## Testing strategy

All behavior follows red → green → refactor. Tests are layered rather than relying on
one screen snapshot.

### Core and daemon history tests

- `RunExecutionConfig.historyPrefix` is passed into a fresh AgentLoop turn.
- A two-turn deterministic LLM sees the first Run's user goal and verified final text
  on the second Run.
- Session history selects only eligible completed verified Runs, with exact workspace
  isolation, `finishedAt <= current.createdAt`, deterministic ID tie-break, and a
  bounded newest suffix.
- Invalid final results and failed/cancelled/timeout/budget/max-step Runs are excluded.
- Prefix generation does not mutate or append the new Run's durable conversation.
- Retry, stale-step recover, and verification repair each see the prior prefix once;
  the current goal and previous assistant text occur once each.

### CLI controller tests

- Health then info bootstrap creates one Session with current workspace/model.
- Unreachable daemon, protocol mismatch, and missing defaults are safe fatal states.
- A normal submit calls `createRun` once, starts watch before `startRun`, disables the
  composer, and rejects a second submit while active.
- Status events update only the matching active Run; old Run events are ignored.
- Terminal events call `getRun` once, append only verified final text for COMPLETED,
  append safe terminal entries for other statuses, and re-enable input after settlement.
- SSE failure does not call cancel and does not manufacture FAILED.
- Dispose aborts the active stream.

### Ink tests

Use `ink-testing-library`/Ink render helpers compatible with the pinned versions to
test Connecting, Ready, Working, Verifying, Approval required, Completed, Failed,
fatal, Static transcript behavior, plain wrapping, and composer Unicode/paste/empty/
oversized/disabled input. Component tests assert user-visible allowlisted text rather
than raw screen snapshots.

### Integration and architecture tests

The multi-turn integration composes the real Fastify daemon, real file-backed SQLite,
real `RunController`, `AgentLoop`, Tool System, and Verification, with only the
external LLM provider replaced by a deterministic fixture. It proves one Session ID,
two distinct durable Run IDs, same workspace, and second-turn history visibility.

Architecture guards assert that `apps/cli` imports only `@caelush/client`,
`@caelush/protocol`, React, Ink, and application-local modules; it does not import
Core, Storage, Runtime, Security, Tools, Context, Verification, or LLM, and it does
not use `node:fs`, `spawn`, Git, or direct daemon `fetch` calls. Scope-leak tests
assert no public transcript exposes Tool data, shell output, patch data, provider
payloads, or hidden reasoning and no 12C/12D/12E UI type is introduced.

## Documentation updates

The implementation updates:

- `docs/architecture/cli-application-shell.md` for bootstrap, controller, state,
  transcript/composer, event projection, and 12B exit behavior;
- `docs/architecture/session-conversation-lifecycle.md` for Session/Run semantics,
  history eligibility/order/bounds/workspace policy and non-duplication;
- `docs/architecture/client-transport.md` to state that 12B consumes the existing
  client and adds no direct daemon calls;
- `docs/architecture/daemon-production-composition.md` for daemon-owned history
  context/defaults;
- `README.md` and `AGENTS.md` for Phase 12B status and durable rules.

## Self-review

- No Core package imports Storage or SQLite; history enters through a narrow config
  field and the daemon supplies it.
- No old Run Tool messages are projected into a new Run.
- The current Run goal is generated once for a fresh turn and preserved once for an
  accepted Tool continuation.
- Retry, recover, and repair use the same boundary timestamp and prefix policy.
- The CLI owns no AgentLoop, RunController, Runtime, Storage, Tool, Security, or
  Verification implementation.
- The CLI uses the existing typed client and durable replay, with no auto-reconnect.
- Completion is still decided by daemon Core/Verification/Completion Authority;
  CLI only renders canonical public data.
- Static transcript and dynamic activity/composer are separate and no detailed
  timeline UI is introduced.
- All new public data is strict JSON-safe and contains no credentials or endpoints.
- The design is limited to Phase 12B and leaves 12C/12D/12E work for their rounds.
