# CLI Agent Timeline

Phase 12C adds a read-only live Agent timeline to the Ink CLI. The daemon
already owns Run, Tool, Runtime, Verification, Security, SQLite and EventBus
authority. The CLI consumes the typed `@caelush/client` AgentEvent stream and
projects it into a bounded presentation model.

```text
AgentEvent SSE / durable replay
          │
          ▼
  lifecycle + timeline reducers
          │
          ├── one ordered displayHistory (settled)
          └── CliTimelineState (active)
                    │
                    ▼
       Ink History / ActiveTimeline / Composer
```

## Event coverage and source of truth

`AgentEvent` remains the only input fact for execution activity. Timeline state
never writes to `Run`, `AgentState`, `ToolInvocation`, `ToolObservation`,
`VerificationCheck`, SQLite, or the EventBus. `AgentEventSchema` existence is
not treated as production support: the Phase 12C audit found real producers for
Run lifecycle, LLM lifecycle, retry, Tool lifecycle, file effects, shell
effects, process effects, Verification planning/check/finalization/repair,
approval, error and budget events. `plan.updated`, `shell.output`,
`process.output`, and legacy `verification.started`/`verification.completed`
have no current production producer and are not faked.

The Tool Dispatcher now adds at most one safe bounded `tool.output` preview at
Tool settlement when the injected Security presentation port supplies one. It
is a settlement summary bridge, not a runtime streaming side channel. Runtime
output remains governed by the existing Tool/Observation path.

All current production event factories are durable `USER_VISIBLE` events. The
client still validates every SSE event, uses durable `durability.sequence` as
the replay cursor, and rejects a durable SSE id that does not match the event
sequence. Ephemeral events are displayable only when already visible, but never
advance the durable cursor.

## Unified history and active work

`displayHistory` is the one ordered public scrollback. It contains:

- the submitted `USER` message;
- settled timeline entries such as Tool, File, Process, Verification, Retry,
  Approval, Error and Budget notices;
- the canonical verified `ASSISTANT` answer; or
- a bounded `RUN_TERMINAL` notice for a non-completed Run.

The reducer keeps changing work in `CliTimelineState`: active Tools, the
current plan, Verification groups/checks, pending approvals, retries and
running processes. A Tool lifecycle updates one active entry by `invocationId`
from `REQUESTED` to `RUNNING`, then moves that same entry to settled history on
`tool.completed` or `tool.failed`. Unknown terminal events become a safe
standalone entry; no “latest Tool” heuristic is used.

File events do not contain `invocationId`. They attach to an active Tool only
when exactly one active Tool in the same `stepId` is a compatible candidate.
Otherwise they remain standalone File history. File displays are per-file
summaries with workspace-relative paths and `A`, `M`, `D`, or `R` markers plus
available additions/deletions. Raw `apply_patch` input and unrelated workspace
diffs are never reconstructed for display.

Processes are keyed by `processId`. A real `process.stopped` settles the process
with its reported status. If the Run reaches a terminal event while a process
is still active, the CLI records “Process remains active in daemon.” and never
pretends that it stopped or exited. A long-running process therefore cannot
hold already settled history open.

Plans replace the current plan snapshot rather than appending a full copy on
every update. Verification groups use `planId`; checks use `checkId` within that
group. Planned, check-started, check-completed, repair-started,
repair-limit-reached and finalized events are rendered with counts and
status markers, while evidence, seal hashes and raw command output remain
outside the view model. Retry entries use `stepId + attempt`, and consecutive
reasoning summaries are deduplicated; only `reasoning.summary` is eligible for
the normal reasoning surface.

## Bounds, replay and terminal behavior

The default projection limits are explicit: 8 KiB per timeline text, 256
settled timeline entries, 32 active entries, and 1,024 seen event identities.
Tool previews are bounded by the Security presentation implementation. UTF-8
truncation keeps a head and tail around the visible `… output truncated …`
marker. When settled activity exceeds its limit, the CLI inserts one
`… additional activity omitted …` marker while preserving terminal/verification
finalization entries. No raw event, provider payload, whole diff or hidden
reasoning is retained.

The reducer is pure, serializable and deterministic. Exact replay of an event
identity is ignored. A durable sequence conflict fails closed with a generic
timeline error. An event from another Run, or a `DEBUG`/`SYSTEM` event, does
not enter the user timeline. The controller passes its current durable cursor
to the existing client watch and performs no automatic reconnect as part of the
Phase 12C reducer. Phase 12D wraps the same reducer with a host-level bounded
reconnect scheduler; it never changes the timeline's event identity, cursor,
or projection authority.

At a terminal event, active Tools are frozen as presentation-only interrupted
entries, unresolved approvals/retries/checks are marked as interrupted, and
active processes receive the daemon-active notice. The controller then performs
one canonical `getRun()` and appends only the validated
`VerifiedRunFinalResult.text`, keeping the final Assistant entry after the
activity history. The reducer never mutates durable Tool or Run state.

## Ink rendering

`History` owns the single primary Ink `<Static>` and renders chronological
settled messages and timeline entries. `ActiveTimeline` owns the dynamic area
and delegates domain rendering to `CurrentPlan`, `VerificationActivity` and
`ActiveProcesses`; active Tool summaries, approvals and retries remain there
until they settle. Empty sections render nothing. The UI stays inline and does
not add an alternate screen, pager, full-screen interaction, or non-interactive
output mode. Phase 12D adds a separate controller-routed Approval dialog and
cancellation/reconnect controls; those controls operate on typed client actions
and do not make the timeline an execution state machine.

The components accept only CLI plain view models. They do not read AgentEvent,
call Core, or import Runtime, Storage, Security, Tools, Verification or LLM.
