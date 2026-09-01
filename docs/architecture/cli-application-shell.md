# CLI Application Shell

Phase 12B adds a small interactive host in `apps/cli`. It is a client and
presentation shell, not another Agent implementation. The design is one Session per CLI process
and one current active Run per process; one process owns one
`CliConversationController`, one daemon `Session`, and one current active `Run`.
The daemon remains the only Core/Runtime/Tool/Verification composition root.

## Bootstrap and submission

The process reads `CAELUSH_DAEMON_URL` in the bootstrap adapter and defaults to
`http://127.0.0.1:43120`. The controller calls the typed `@caelush/client`
`getHealth()` and `getInfo()` methods, requires the public default model and
`defaultRunConfiguration`, normalizes the current working directory, and creates
one Session with a basename title, default workspace, default model, and empty
metadata. A second bootstrap call shares the first promise; it cannot create a
second Session.

Each submitted prompt is one Run per prompt. The controller trims and bounds UTF-8 input,
adds an optimistic public `USER` entry, calls `createRun()`, starts
`watchRunEvents()` before `startRun()`, and keeps the composer locked until the
Run reaches canonical terminal settlement. A synchronous in-flight guard means
rapid Enter presses cannot create two Runs. The controller uses the daemon's
runtime, permission, approval, and limit defaults verbatim; it does not create a
second policy configuration.

The lifecycle is deliberately explicit:

```text
bootstrap → one Session
prompt → optimistic USER → createRun → watch events → startRun
event → safe view projection
terminal event → exactly one getRun → verified final text or terminal notice
settlement → unlock composer for the next Run
```

Run creation is not execution. A `PENDING` Run is only scheduled by the explicit
start action, and the CLI never treats a `202` action response as completion.

## View state and safety

`CliViewState` exposes only bootstrap state, public Session/Run identity, one
ordered `displayHistory`, a bounded `CliTimelineState`, a finite activity label,
composer availability, and a safe fatal message. `displayHistory` is the single
public scrollback for user messages, settled timeline entries, verified
assistant text, and terminal notices. Active tools, plans, verification checks,
approvals, retries, and processes remain in the dynamic timeline projection.

The history allowlist is:

```text
USER          submitted prompt
ASSISTANT      VerifiedRunFinalResult.text only
RUN_TERMINAL   bounded status notice for a non-completed Run
```

Every valid `AgentEvent` is accepted by the projector. Lifecycle events update
`Preparing`, `Working`, `Retrying`, `Verifying`, and `Approval required` labels;
Tool, file, process, reasoning, provider, and verification detail payloads are
projected into bounded, safe timeline view models; raw events and raw Tool
arguments are never stored in the view state. Events whose `runId` is not the
active Run are ignored. Completion is settled from `getRun()` and
`VerifiedRunFinalResultSchema`, never from natural-language output or an event
payload.

An unreachable daemon and protocol/configuration mismatch render one sanitized
fatal message and exit with code 1. A stream failure is a transport activity, not
a durable `FAILED` transition; the CLI does not call `cancelRun()` and has no
automatic reconnect. `dispose()` aborts only the local SSE reader. If the user
exits while a Run is active, the process exits locally and reports that the active
Run continues in the local daemon.

There is no automatic reconnect in Phase 12B or 12C. Phase 12C only consumes
the existing typed `AgentEvent` watch; it does not add reconnect, cancellation
UX, approval resolution, or session resume.

## Ink rendering

The React/Ink tree keeps settled and dynamic surfaces separate:

```text
<App>
  <Header />
  <Static items={displayHistory}>…</Static>
  <ActiveTimeline />
  <ActivityStatus />
  <Composer />
</App>
```

`<Static>` is the append-only history region. Settled Tool/File/Process/
Verification activity is appended there once; active work is rendered by
`ActiveTimeline`, `CurrentPlan`, `VerificationActivity`, and
`ActiveProcesses`. Header, activity, and the controlled `ink-text-input`
composer are dynamic. The composer supports normal
Unicode/Chinese/emoji, cursor editing, paste, and Enter submission; whitespace
only input is ignored and pasted newlines remain ordinary bounded input rather
than creating a second editor. Long project paths are bounded for display and
plain text is used without a Markdown or syntax-rendering layer.

Phase 12C adds the read-only Agent timeline described in
[CLI Agent Timeline](cli-agent-timeline.md). The timeline is a projection of
daemon events, not a second execution state machine. Phase 12B/12C still do not
add approval interaction, cancellation controls, reconnect/resume UX, daemon
auto-start, model picker, Web UI, or packaging.
