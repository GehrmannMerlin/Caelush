# CLI Interactive Control

Phase 12D adds the first interactive control plane to the Ink CLI. The CLI is
still a thin host: it renders safe projections and sends typed intents through
`@caelush/client`; the daemon, Core, Security, Approval manager and
`RunController` remain the authorities for permissions, cancellation and Run
state.

## One input router and explicit view modes

`routeCliInput()` is the single precedence-ordered keyboard router. It maps
Ink key facts to a small `CliInputAction` union and never mutates Run or
Approval state. The precedence is:

```text
Session Picker → Approval → pending Run confirmation → disconnected controls
→ active Run controls → Composer
```

`CliControlMode` is presentation state, not a new Protocol `RunStatus`:
`NONE`, `APPROVAL`, `CANCELLING`, `SESSION_PICKER`,
`RUN_RECOVERY_PICKER`, and `PENDING_RUN_CONFIRMATION`. Transport is similarly
separate as `CONNECTED`, `RECONNECTING`, or `DISCONNECTED`.

Components receive plain view models and callbacks. They do not call the
daemon client directly, inspect raw events, or decide whether a Run is
terminal. The controller serializes control operations, refreshes canonical
state after each action, and exposes recoverable errors without converting
them into a fake Run failure.

## Approval interaction

The daemon emits `approval.requested`; the controller first refreshes
`listPendingApprovals(runId)` and creates a bounded `CliApprovalView` from the
exact `approval.id`. A request is never inferred from Tool order, event order,
or the most recent request. If the live stream is missed, the same pending
list is the recovery source.

The default selection is `Reject`. An `ONCE` request offers `Approve once` and
`Reject`. A `RUN` request additionally offers `Approve this action for this
Run`. These labels map only to the strict Protocol resolutions:

```text
Approve once       → { action: "APPROVE", scope: "ONCE" }
Approve for Run    → { action: "APPROVE", scope: "RUN" }
Reject             → { action: "REJECT" }
```

The view allowlist is title, reason, risk level, tool name, required
capabilities, and a bounded safe summary. Raw action JSON, command/patch/
stdin text, approval keys, credentials, provider payloads and exception text
are not rendered or copied into CLI state. `Esc` closes the dialog only.

The controller uses one in-flight resolution per Approval ID and a control
generation. On a stale or conflicting response it reloads the exact pending
list and the canonical Run; it does not blindly retry or resolve a different
request. Resolution remains a daemon action, so a CLI cannot grant permission
locally.

## Cancellation and detach

When an active Run exists, `Ctrl+C` calls `cancelRun(runId)` exactly once for
the current control generation. It does not submit the text `stop`, does not
invent `CANCELLED`, and shows `Cancelling` until the canonical response or a
terminal event is observed. A response with disposition `SETTLED` is not by
itself enough: the controller inspects `response.run.status` and settles only
from the terminal Run projection. HTTP failure leaves the Run active and
shows a recoverable cancellation error.

`Ctrl+C` is available for `RUNNING`, `WAITING_APPROVAL`, `VERIFYING`, and the
transport-disconnected representation of an active Run. It is ignored while
cancellation is in flight, preventing duplicate requests. `Ctrl+D` detaches
only this CLI: it aborts the local stream, invalidates the stream generation,
clears local active presentation state, and tells the user that the daemon
Run continues. With no active Run, `Ctrl+C` and `Ctrl+D` exit the CLI.

Approval, cancellation and detach are local presentation/control actions;
none adds a database table, a second state machine, a Tool execution path, or
a Verification transition. Phase 12D does not implement Phase 12E packaging,
production hardening, non-interactive/pipe mode, or additional host products.
