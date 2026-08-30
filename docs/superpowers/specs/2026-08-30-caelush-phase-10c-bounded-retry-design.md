# Caelush Phase 10C — Bounded Retry & Backoff Design

## Scope and invariants

Phase 10C adds automatic retry only for transient LLM/provider failures. The
existing provider-owned `LLMError.retryable` flag remains the primary
classification contract; Core does not inspect HTTP status codes, headers,
provider names, or error messages. The durable retry-safe error-code allowlist
is limited to `LLM_RATE_LIMIT`, `LLM_NETWORK`, and `LLM_TIMEOUT`. Abort,
authentication, invalid request, unsupported model/capability, invalid
response, and generic provider errors remain non-retryable.

Generic Tool retry is out of scope. A completed or uncertain Tool invocation is
never replayed by this feature. A transient provider failure after a completed
Tool Result may repeat only the provider turn, and any new Tool call returned by
that successful retry goes through the existing registry, schema, security,
approval, runtime, and dispatcher boundaries.

## Policy and pure decision layer

Core owns an immutable `RetryPolicy` with bounded safe-integer values:

```ts
interface RetryPolicy {
  readonly maxAttempts: number; // includes the initial provider attempt
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
```

V1 defaults are `maxAttempts = 3`, `baseDelayMs = 1_000`,
`maxDelayMs = 30_000`, and `jitterRatio = 0`. `maxAttempts` is capped at 10;
delays are positive safe integers and `maxDelayMs >= baseDelayMs`.

`RetryController` is provider-independent and has no LLM calls, Storage,
Runtime, Tool, timer, sleep, or Run mutation responsibilities. It receives the
current failed attempt number, the post-settlement step count, Run limits,
current time/deadline, retryability metadata, and an injected jitter source.
It returns either `RETRY` with the next attempt number and bounded delay, or a
stop reason. The decision order is terminal/cancellation/deadline, maxSteps,
retryability, and attempts. Exponential delay is calculated with bounded
integer math (`baseDelayMs * 2 ** retryIndex` without unsafe intermediate
overflow), then optional deterministic jitter is applied and clamped. A valid
positive safe `retryAfterMs` hint takes precedence and is still clamped to the
policy maximum; invalid hints fall back to calculated backoff.

## Attempt and conversation semantics

Each provider attempt is one Agent Step attempt. The failed Step is settled to
`FAILED`, usage steps are incremented exactly once, and the Step receives a new
StepId for every later attempt. The LLM Gateway already owns call-id creation,
so each provider invocation receives a new LLMCallId.

`AgentLoop` exposes safe retry metadata on a failed provider result without
exposing the raw exception. The metadata contains the provider error code,
`retryable` flag, and optional normalized `retryAfterMs`. Partial text and
partial tool calls are never included in `messagesToAppend` for a retry. A
retry reconstructs the same logical request from the last durable conversation
boundary. For a Tool Result turn, the retry continuation stores the existing
pending decision and normalized results and resumes with
`resumeWithToolResults`; it does not append another user message or redispatch
the Tool batch.

## Durable continuation and atomic scheduling

`WAITING_RETRY` is a new strict `RunContinuationCheckpoint` variant. It is not
a `RunStatus` and does not add an `AgentState.status`. Its payload uses
`attempt` to mean the next provider attempt number and contains:

```ts
{
  type: "WAITING_RETRY";
  runId: RunId;
  failedStepId: StepId;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: TimestampMs;
  errorCode: "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT";
  mode: "START" | "TOOL_RESULTS";
  pendingDecision?: AgentToolCallsDecision;
  receivedResults?: readonly LLMToolResultMessage[];
}
```

`TOOL_RESULTS` requires both context fields; `START` forbids them. The
continuation is validated strictly and does not contain raw provider errors,
stacks, response bodies, credentials, full prompts, or partial completions.
The failed Step update, `RUNNING` Run/State settlement, continuation write,
and `retry.scheduled` durable event are one `RunExecutionStore.commit`.
The event is persisted before live notification and before the in-memory timer
is armed.

The retry scheduling event has the safe payload `attempt`, `maxAttempts`,
`delayMs`, `nextAttemptAt`, and `errorCode`; its event `stepId` identifies the
failed Step. `retry.started` has safe attempt metadata and is committed in the
same checkpoint that inserts the new active Step and clears `WAITING_RETRY`.
The existing `llm.started` event follows it. Provider failures retain the
existing safe error mapping and add `llm.failed`; no raw provider data enters a
public event.

## Retry registry and wake path

`RunRetryRegistry` is a separate Core-owned, ephemeral registry from the
deadline registry. It has one token-protected wakeup per Run, injectable timer
and clock ports, bounded/chunked delays, re-arm/disarm/dispose operations, and
an error sink that prevents unhandled background rejections. A stale callback
does nothing. The controller arms it only after the durable scheduling commit.

The wake callback reloads the Run before doing any work, uses the normal Run
lock, and no-ops if the continuation is no longer `WAITING_RETRY`. It checks
terminal state, durable cancellation, deadline, and maxSteps before opening a
new provider attempt. If the lock is busy, it reloads and re-arms the same
durable `nextAttemptAt`; it never launches a second AgentLoop. A wake after
`nextAttemptAt` invokes a fresh execution scope. The before-provider lifecycle
hook atomically clears the retry continuation, inserts the new Step, and emits
`retry.started` followed by `llm.started`. If the process crashes before that
checkpoint, recovery sees `WAITING_RETRY`; if it crashes after the checkpoint,
the existing stale-running-Step recovery fails closed and never resends.

The deadline registry remains armed through `WAITING_RETRY`. If the calculated
backoff cannot complete before the original Run deadline, no retry continuation
is scheduled; the failed Step is durably settled while the Run remains
`RUNNING`, and the deadline authority later performs the canonical `TIMEOUT`
settlement. Cancellation disarms the retry registration and wins over retry;
deadline expiration likewise wins over retry. Retry waits are control-plane
responsive and do not hold an active `RunExecutionScope` across the idle
boundary.

## Recovery and no-replay proof obligations

Recovery priority is terminal, durable user cancellation, expired Run deadline,
`WAITING_RETRY`, then stale Step/approval/tool recovery. Before
`nextAttemptAt`, recovery re-arms the remaining original delay and makes zero
provider calls. At or after `nextAttemptAt`, recovery starts exactly one new
attempt after rechecking cancellation and deadline. Restart never resets the
original backoff.

The integration tests must prove that a completed `apply_patch` or
`exec_command` remains at one invocation when the subsequent provider turn
fails transiently and succeeds on retry. An `UNCERTAIN_SIDE_EFFECT` boundary
continues to use the existing no-replay barrier. No Phase 10D budget,
Verification, completion transition, transport retry API, or other future
capability is introduced.

