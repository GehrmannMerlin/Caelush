# Run Deadline and Timeout Architecture

Phase 10B gives every started, non-terminal Run one durable absolute deadline. The deadline is owned by the outer Run lifecycle and reuses the Phase 10A abort spine; it is not a timer that merely changes a database status after work has finished.

## Contract and authority

```text
PENDING
  │ start persists startedAt
  ▼
RUNNING ── startedAt + limits.timeoutMs ──► deadlineAt
                                               │
                                               ▼
                                  RunExecutionScope.abort(DEADLINE_EXCEEDED)
                                               │
                         LLM / Tool / Runtime / managed processes stop
                                               │
                                               ▼
                       cleanup → atomic Run/State/Step/Continuation commit
                                               │
                                               ▼
                                             TIMEOUT
```

The sole formula is `deadlineAt = startedAt + timeoutMs`. `createdAt` is not used. A PENDING Run has no active deadline and cannot time out before its first durable `PENDING → RUNNING` transition. Once written, `startedAt` never refreshes on a Step, Tool, Approval, external Tool Result, Verification boundary, `recover()`, or `resolveApproval()`.

`timeoutMs` is a positive safe integer. Deadline derivation rejects unsafe or overflowing arithmetic, and the exact boundary is `now < deadlineAt` active and `now >= deadlineAt` expired. Remaining time is calculated from the original deadline; it is never converted into a new timeout.

## Run timeout versus Provider timeout

The LLM Gateway's local Provider timeout remains a child-operation policy. A Provider timeout produces `MODEL_TIMEOUT` and follows the existing model-failure semantics when the Run deadline has not expired. A Run deadline aborts the Run-owned signal and produces `RunStatus.TIMEOUT`, even when the Provider's own local timeout is longer. The two timers run independently and whichever authority is reached first determines the immediate outcome.

```text
Provider local timeout ──► LLMTimeoutError ──► MODEL_TIMEOUT / FAILED path

Run deadline ────────────► RunExecutionScope abort ──► TIMEOUT path
```

The Controller never passes the Run's remaining time as a replacement Provider timeout. The AgentLoop receives the same host-only `AbortSignal` and does not decide whether an abort means user cancellation or deadline timeout.

## Scheduling and lifecycle

`RunDeadlineRegistry` is an injectable, Core-owned ephemeral registry. It keeps at most one active timer registration per Run, uses the injected clock, rearms after a premature wake-up, and disarms terminal and PENDING Runs. Long delays are chunked below the platform timer limit. A callback rechecks the durable snapshot and the current clock before aborting anything, so stale callbacks cannot time out a newly terminal Run. Registry disposal cancels every owned timer.

The registry is not durable state. On process restart, `recover(runId)` derives the same original deadline from the persisted Run. An expired Run performs no Provider or Tool call and is finalized as TIMEOUT. An unexpired Run resumes its existing durable boundary and rearms the remaining portion of the original deadline. This makes recovery safe without pretending that an in-memory timer survived a crash.

## Two-phase timeout settlement

Timeout settlement has two phases:

1. Abort the active `RunExecutionScope` with the Core-only cause `DEADLINE_EXCEEDED`. The first in-memory abort cause wins; the cause is never persisted in Protocol or SQLite.
2. After the active operation has unwound, acquire the normal per-Run termination lock, cancel owned resources and pending approvals, then commit the terminal projection.

Resource cleanup is a prerequisite for terminal settlement. If the injected resource controller cannot confirm cleanup, the public controller result is `TIMEOUT_PENDING`; `RunStatus` is not a new pending status. A later recovery or timeout callback retries cleanup and performs the same terminal commit. A successful timeout writes exactly one `status.changed` transition and one `run.timed_out` event, clears any continuation, emits no `run.failed`, and does not append a synthetic conversation message.

When a provider or Tool Step was active, the Step is cancelled and its attempt is counted exactly once. The AgentState becomes `TIMEOUT`, has no current Step or active processes, and the AgentRun becomes `TIMEOUT` with `finishedAt`. The canonical Run State Machine remains the only transition authority.

## Boundary matrix

| Boundary                  | Deadline behavior                                                                          | Provider or Tool calls after expiry            |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `RUNNING` / provider turn | Abort the scope; discard late provider output                                              | None                                           |
| `WAITING_APPROVAL`        | Cancel pending approval, clear continuation, terminate Run                                 | None                                           |
| `WAITING_TOOL_RESULTS`    | Clear external-result continuation and terminate Run                                       | None; late results are terminally rejected     |
| `VERIFYING`               | Preserve the candidate only as historical durable input, clear continuation, terminate Run | No Verification execution is introduced in 10B |

Approval TTL remains a separate lifecycle. Approval expiry produces `ApprovalStatus.EXPIRED` and `approval.resolved`; Run deadline expiry produces `RunStatus.TIMEOUT` and `run.timed_out`. Approval TTL does not extend the Run deadline, and a Run timeout cancels still-pending approvals rather than marking them EXPIRED.

## Race and safety rules

The durable cancellation intent has priority over a simultaneous deadline, so a user request settles as `CANCELLED` and never emits `DEADLINE_EXCEEDED`. If the deadline wins first, a later cancellation is idempotent against the terminal Run. A late Provider result, Tool result, approval resolution, timer callback, or recovery attempt cannot reopen a terminal Run or create a second terminal event. Unknown aborts fail closed as a Core invariant rather than being guessed as cancellation or timeout.

Managed `exec_command`, yielded PTY sessions, `write_stdin` waits, ripgrep, and Git helpers receive the same abort signal and are included in the existing Phase 10A owned-resource cleanup contract. This is cooperative managed-process cleanup; it is not an OS hard sandbox or a universal descendant-process guarantee.

## Phase boundary

Phase 10B adds only Run deadlines, timeout settlement, timer lifecycle, and restart-safe recovery. It does not add retry or backoff, budget enforcement, `maxToolCalls`/`maxTokens` enforcement, Verification execution, daemon routes, CLI/Web timeout UI, MCP, Browser, Computer Use, remote runtimes, Docker, or hard sandboxing. Phase 10C and 10D remain future phases.
