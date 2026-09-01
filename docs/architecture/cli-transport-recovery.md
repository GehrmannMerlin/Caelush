# CLI Transport and SSE Recovery

Phase 12D adds a host-side reconnect controller around the existing typed
`@caelush/client` transport. The client still validates HTTP and SSE
contracts; the daemon remains authoritative for durable events and Run state.

## Stream open and durable cursor

`watchRunEvents(runId, options)` retains the additive `onOpen` callback. The
callback fires once only after the HTTP response is successful, the response
body is valid, and a reader has been acquired. HTTP, fetch, body and abort
failures never call `onOpen`. The callback does not change the existing
`AsyncIterable<AgentEvent>` contract.

The controller tracks the greatest durable `durability.sequence` accepted by
the existing projector. A cold attach starts with `afterSequence: 0`; a
reconnect starts strictly after that last durable sequence. Ephemeral events
never advance this cursor and never receive an SSE ID. Replay is therefore
exclusive and uses the daemon's existing `EventBus.watch()` join; the CLI does
not implement another replay or deduplication system.

## Generations and canonical settlement

Every attach, reconnect and resumed Run receives a new stream generation.
Events, stream errors, `onOpen` callbacks and terminal work from an old
generation are ignored. `dispose()` and `Ctrl+D` abort only the local reader
and invalidate late callbacks; they do not cancel a daemon Run.

The controller has one active stream and one active Run settlement. All
terminal paths—normal terminal event, reconnect followed by terminal replay,
canonical `getRun()` discovery, cancellation response, or explicit detach
cleanup—pass through the same exactly-once settlement guard. Settlement reads
the canonical Run and validates `VerifiedRunFinalResult`; it never infers
completion from model text or an event name. Non-completed terminal Runs show
a bounded notice.

## Deterministic reconnect policy

Unexpected stream termination while the Run is non-terminal changes only the
CLI transport state to `RECONNECTING` and schedules the next attempt with the
injected scheduler. Delays are fixed and jitter-free:

```text
250 ms → 500 ms → 1 s → 2 s → 4 s → 5 s
```

After six failed attempts the state becomes `DISCONNECTED` and the user sees
a recoverable notice. `R` starts an explicit manual retry and resets the
bounded sequence. There is no timer in a React component and no unbounded
retry loop. The system timer is a thin host adapter; tests use an injected
clock/timer and deterministic callbacks.

Transport failure is never rewritten as Run `FAILED`, `CANCELLED` or
`TIMEOUT`. While disconnected, cancellation still targets the active Run via
the typed client action; it does not depend on the SSE stream being alive.
After reconnect, the controller rechecks the canonical Run and resumes the
normal approval, timeline, composer-lock and terminal-settlement rules.

## Boundary and non-goals

The reconnect scheduler owns only local ephemeral retry state. It does not
retry HTTP control actions, execute Tools, mutate Storage, modify RunStatus,
or decide permissions. `@caelush/client` remains browser-compatible and
provider-independent. Phase 12D does not implement WebSocket, daemon
auto-start, remote Runtime, auth, non-interactive/pipe mode, or the Phase 12E
production packaging and hardening boundary.
