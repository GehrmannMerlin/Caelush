# Provider Retry and Backoff Architecture

Phase 10C adds bounded, durable automatic retry for transient LLM/provider
failures. It is a Core lifecycle policy around one provider turn; it is not a
generic retry utility for Tools, Runtime processes, Storage, or Verification.

## Scope and classification

Only an `LLMError` with `retryable === true` and one of these codes can enter
the retry policy:

| Code                                                                                   | Meaning                                                                       | Retry |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| `LLM_RATE_LIMIT`                                                                       | Provider rate limiting                                                        | Yes   |
| `LLM_NETWORK`                                                                          | Provider/network transport failure                                            | Yes   |
| `LLM_TIMEOUT`                                                                          | Provider-local timeout                                                        | Yes   |
| `LLM_ABORTED`                                                                          | An abort was requested                                                        | No    |
| Authentication, invalid request/response, unsupported model/capability, provider error | Configuration, contract, or provider failure without transient classification | No    |

Core consumes only the provider-independent `retryable` flag, safe error code,
and an optional safe `retryAfterMs` hint. It never inspects HTTP status, response
headers, provider names, raw messages, response bodies, credentials, or stack
traces. Provider-local retry hints are advisory and are accepted only when they
are positive safe integers no larger than the configured maximum delay.

## Policy and decision flow

`maxAttempts` includes the initial attempt and is bounded to `[1, 10]`; the
default is three attempts. The default delay is one second, doubles per retry,
and is capped at 30 seconds. Jitter is injected through a deterministic testable
source; retry policy code never calls `Math.random()`.

```text
Provider turn fails
       |
       v
Cancellation or deadline already authoritative? -- yes --> stop; existing authority settles
       |
       no
       v
steps >= maxSteps? ------------------------------ yes --> MAX_STEPS_REACHED
       |
       no
       v
LLMError.retryable and safe transient code? ------ no ---> final FAILED settlement
       |
       yes
       v
attempt >= maxAttempts? ------------------------- yes --> final FAILED settlement
       |
       no
       v
bounded Retry-After or exponential delay reaches deadline? -- yes --> keep boundary;
       |                                                        deadline authority settles TIMEOUT
       no
       v
atomic commit: failed Step + RUNNING State/Run + WAITING_RETRY
       |
       v
notify committed events, then arm one ephemeral retry timer
```

The pure `RetryController` returns either a bounded `RETRY` decision with the
next attempt number and delay, or a stop reason. Arithmetic is overflow-safe.
The retry decision does not sleep, call an LLM, execute a Tool, mutate a Run, or
write Storage.

## Steps, calls, and conversation integrity

Each provider attempt is a separate Agent Step attempt. A retry therefore gets a
new `StepId`, and the LLM Gateway creates a new `LLMCallId` for the new provider
turn. The failed Step is settled as `FAILED` exactly once and increments
`usage.steps` exactly once. There is no reused active Step and no synthetic
“try again” message.

Failed or partial provider output is never appended to durable Conversation.
For a retry after Tool Results, the completed Tool invocation is not dispatched
again. The pending assistant decision and normalized Tool Results are preserved
inside the retry continuation, and the retry calls `resumeWithToolResults()`
directly. When the provider eventually succeeds, the normal settlement appends
the already-completed Tool Result exactly once. A Tool with an uncertain side
effect remains behind the existing fail-closed uncertainty barrier and is never
automatically replayed by Phase 10C.

```text
assistant tool decision -> Tool Dispatcher -> durable Tool result
                                      |
                                      v
                         Provider turn fails transiently
                                      |
                                      v
                 WAITING_RETRY(mode=TOOL_RESULTS)
                                      |
                                      v
                    new Provider Step only
                                      |
                       +--------------+--------------+
                       |                             |
                 provider succeeds              provider fails
                       |                             |
            append Tool Result once          next bounded retry or final failure
```

## Durable boundary and timer lifecycle

`WAITING_RETRY` is a strict `RunContinuationCheckpoint`, not a RunStatus or an
AgentState status. It contains the Run identity, failed Step identity, next
provider attempt number, maximum attempts, absolute `nextAttemptAt`, safe
transient error code, and a mode. `TOOL_RESULTS` mode additionally contains the
pending decision and normalized results required to resume the open turn. It
does not contain raw provider errors, stacks, response bodies, full prompts,
credentials, or partial completions.

The failed Step, RUNNING Run/State projection, continuation, `llm.failed`, and
`retry.scheduled` are committed atomically. Durable events are persisted before
they are published. Only after that commit and notification does Core arm the
separate `RunRetryRegistry`. The registry has one token-protected registration
per Run, chunks long platform timer delays, rechecks the injected clock after a
wake, ignores stale callbacks, and contains background callback failures. The
waiting interval does not retain a `RunExecutionScope`; a wake opens a fresh
scope and fresh provider attempt.

The normal durable trace is:

```text
llm.started -> llm.failed -> retry.scheduled
             -> retry.started -> llm.started -> llm.completed
```

`retry.started` is committed with the new active Step and the continuation
clear, immediately before the new `llm.started` event. A final transient
exhaustion emits `llm.failed` and the existing sanitized final failure events;
it does not emit a retry-specific RunStatus.

## Cancellation, deadline, maxSteps, and recovery

User cancellation persists its first-writer-wins `USER_REQUESTED` intent before
aborting live work. Cancellation disarms retry and wins over a simultaneous
wake. Run deadline is still the original Phase 10B
`startedAt + limits.timeoutMs`; waiting backoff consumes that wall-clock time.
If a computed retry delay reaches or passes the deadline, Core does not schedule
the retry or write TIMEOUT directly. It retains a safe retry boundary at the
deadline and lets the existing Deadline authority abort, clean up, and settle
`TIMEOUT`. `maxSteps` is checked before a new retry is scheduled or started.

Recovery order is terminal projection, durable cancellation intent, expired
deadline, `WAITING_RETRY`, then stale active Step/approval/Tool boundaries. A
recovered retry before `nextAttemptAt` re-arms the original timestamp and makes
zero provider or Tool calls. At or after that timestamp it starts exactly one
new attempt. Recovery never resets exponential backoff and late results cannot
reopen a terminal Run.

## Phase boundary

Phase 10C adds no Tool retry policy, Tool retry endpoint, budgets, token/cost
enforcement, Verification execution, `COMPLETED` transition, remote runtime,
MCP, browser/computer use, hard sandbox, or host-specific retry UI. Phase 10D
budget work and final Verification remain future work.
