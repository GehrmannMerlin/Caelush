# Caelush Phase 10B — Deadline & Timeout Hierarchy Design

## Status

Approved by the Phase 10B task brief. This document records the design before
implementation; it does not add a new Phase 10 round.

## Goal

Give every started, non-terminal `AgentRun` a durable absolute wall-clock
deadline derived from `startedAt + limits.timeoutMs`. When that deadline is
reached, Caelush must stop active model, Tool, Runtime, and Run-owned process
work through the Phase 10A abort spine, clean up resources, and durably settle
the Run as `TIMEOUT` without resuming work after restart.

## Scope and exclusions

Phase 10B owns Run-level deadline scheduling, timeout authority resolution,
timeout finalization, and recovery of expired Runs. It does not implement
Retry, Retry-After, backoff, `WAITING_RETRY`, maxToolCalls/maxTokens/maxCost
enforcement, VerificationRunner or `COMPLETED`, public daemon execution or
timeout routes, CLI/Web timeout UI, MCP, Browser, Computer Use, Remote Runtime,
Docker Runtime, or hard sandboxing.

## Durable deadline contract

The only Run deadline is:

```text
deadlineAt = startedAt + limits.timeoutMs
```

`startedAt` is written by the durable `PENDING → RUNNING` transition and is
never refreshed by Agent steps, Tool calls, approvals, continuation,
`recover()`, or restart. `createdAt` is never used. A `PENDING` Run has no
active deadline and cannot time out before it starts.

`timeoutMs` is tightened to a safe positive integer. Deadline derivation uses
safe-integer arithmetic: invalid inputs or an unsafe `startedAt + timeoutMs`
calculation fail closed before Agent work begins. The exact boundary is
`now < deadlineAt` active and `now >= deadlineAt` expired. Run wall-clock time
includes context preparation, LLM calls, Tool/runtime work, waiting for Tool
results, waiting for approval, and `VERIFYING`/`AWAITING_VERIFICATION`.

No `deadlineAt` field or `run_deadlines` table is persisted. Existing durable
`startedAt` and `limits.timeoutMs` are the source of truth.

## Ephemeral abort cause and authority

The Core-only `RunExecutionScope` records a first-wins ephemeral cause:

```text
USER_REQUESTED | DEADLINE_EXCEEDED
```

`DEADLINE_EXCEEDED` is never placed in `RunCancellationIntent`, AgentRun,
AgentState, Tool arguments, Approval identity, continuation, or event payloads.
The Phase 10A durable `USER_REQUESTED` cancellation intent remains unchanged.

`RunController` resolves terminal authority from authoritative durable state,
not from `signal.aborted` alone:

1. Preserve an existing terminal Run.
2. A durable user cancellation intent wins while timeout settlement is not yet
   terminal.
3. An expired Run deadline settles as `TIMEOUT`.
4. Any other abort is an infrastructure/invariant failure and is not silently
   classified as cancellation or timeout.

Consequently, a cancellation intent written before timeout terminal commit
produces `CANCELLED`; a durable `TIMEOUT` cannot later be rewritten by cancel.

## Deadline timer and registry

`RunDeadlineRegistry` is Core-owned but independent from
`RunExecutionScopeRegistry`. It keeps at most one armed registration per
started non-terminal Run, supports arm/re-arm/deduplicate/disarm/dispose, and
uses an injectable timer port. Production uses Node timers with `unref()` when
available; tests use a deterministic fake scheduler.

The registry schedules only a bounded timer chunk. A callback reads the clock
again and compares it with the durable absolute deadline. An early wake is
re-armed with the remaining duration; it never produces an early timeout.
Terminal Runs are disarmed. A timer callback catches asynchronous errors so a
background finalizer failure cannot become an unhandled rejection or turn the
Run into an ordinary `FAILED` result. Since the deadline remains derivable,
`recover()` can retry cleanup after such a failure.

The controller persists `RUNNING + startedAt` first, arms the deadline second,
and checks the deadline before the first provider call. The registration stays
armed while a Run is waiting at `WAITING_APPROVAL`, `WAITING_TOOL_RESULTS`, or
`VERIFYING`, even when no active execution scope exists.

## Timeout trigger and finalization

The timer callback loads the authoritative snapshot, verifies expiration,
aborts the active scope with `DEADLINE_EXCEEDED` without waiting for the normal
Run lock, waits for scope unwinding when a scope exists, and only then enters
the shared two-phase termination lock. The same finalizer is also used at
controller safe points and recovery, so a timer/operation race cannot create a
second terminal event.

Timeout finalization reloads state, preserves terminal/cancellation authority,
cancel-pends approvals, asks the Phase 10A `RunOwnedResourceControllerPort` to
stop owned resources, settles an active AgentStep as `CANCELLED` (counting an
already-started provider attempt exactly once), clears continuation, marks
AgentState and AgentRun `TIMEOUT`, sets the durable settlement `finishedAt`,
emits exactly one `status.changed` and one `run.timed_out` event, atomically
commits, and disarms the deadline. It never emits `run.failed` for Run timeout.

`TIMEOUT_PENDING` is a controller result only. It is returned when expired
authority is known but resource cleanup cannot be confirmed; it is not added to
`RunStatus` or durable Protocol state. Such a Run cannot resume AgentLoop,
Tool continuation, or Approval execution. A later `recover()` retries cleanup,
and a user cancellation may still win before timeout is durably committed.

Patch prepare remains cooperatively abortable. Once patch commit/rollback has
entered its critical section, the existing transaction-safe deferred
cancellation behavior is preserved; timeout finalization waits for safe
settlement before claiming terminal `TIMEOUT`.

## Provider timeout hierarchy

The LLM Gateway's local per-provider-request timeout remains independent. A
provider-local timeout before the Run deadline remains `LLMTimeoutError` mapped
to `MODEL_TIMEOUT`, and in Phase 10B the Run follows the existing failure path
with no retry. If the Run deadline expires first, the Run-owned AbortSignal
interrupts the provider and the Run settles as `TIMEOUT`; it must not be
converted into a provider timeout. No provider adapter receives Run timeout
policy or creates Caelush call IDs.

## Recovery

Every recovery entry point checks, in order: existing terminal state, durable
user cancellation intent, expired Run deadline, then ordinary stale-step /
approval / Tool recovery. An expired Run never calls the provider, resumes an
Approval, resumes Tool continuation, or executes a Tool. If an unexpired Run is
recovered, the registry arms `deadlineAt - now`, never a fresh `timeoutMs`.
This also covers `RUNNING`, `WAITING_APPROVAL`, `WAITING_TOOL_RESULTS`, and
`VERIFYING` snapshots left behind by a process restart.

## Events and tests

The Protocol adds `run.timed_out` with safe metadata `{ deadlineAt }`. It is
durable and emitted exactly once alongside the single status transition to
`TIMEOUT`. Tests cover pure deadline arithmetic and boundaries, timer
deduplication/chunking/recheck/disposal, busy and idle timeout paths, approval
and Tool-result boundaries, active/yielded process cleanup, patch critical
sections, provider-vs-Run timeout classification, crash recovery, re-arm
without refresh, and deterministic cancel-vs-timeout races. Existing Phase 6–10A
and Phase 9 security regressions remain required.

## External design references

The implementation audit also reviewed the current OpenAI Codex execution
sources for the separation between task cancellation and per-operation process
expiration, and for process cleanup after bounded waits:

- [Codex task cancellation token and abort lifecycle](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/mod.rs)
- [Codex unified exec process manager](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs)
- [Codex unified exec runtime timeout handling](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/runtimes/unified_exec.rs)
