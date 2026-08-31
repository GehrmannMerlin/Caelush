# Caelush Phase 10D Budget Governance Design

## Scope and boundary

Phase 10D is the final Phase 10 round. It adds crash-safe enforcement for
`maxToolCalls`, `maxTokens`, and `maxCost`, completes the shared terminal
governance cleanup audit, and stops at the existing `VERIFYING` boundary.
It does not implement Phase 11 verification, a `COMPLETED` transition,
public budget APIs or UI, billing, live pricing, remote runtimes, MCP,
Browser, Computer Use, or an OS sandbox.

The Phase 10 control-plane priority is:

```text
existing terminal
  -> durable cancellation
  -> expired deadline
  -> maxSteps
  -> Tool / Token / Cost budget
  -> retry
  -> normal Agent execution
```

`maxSteps` remains `MAX_STEPS_REACHED`; timeout remains `TIMEOUT`; budget
exhaustion is `BUDGET_EXCEEDED`; a final model candidate remains
`VERIFYING`.

## Architecture

Every external action follows `Admission -> durable reservation -> Execute ->
Settle`. A single durable `run_budget_entries` ledger is the authoritative
source for Tool-call, token, and cost enforcement. `AgentState.usage` is a
durable/user-facing projection reconciled from the ledger and settled Steps;
it is never the sole admission source.

The Core-owned `BudgetManager` is pure and deterministic. It performs limit
validation, snapshot arithmetic, Tool segment admission, token output
allowance/clamping, cost allowance/clamping, and reservation planning. It
does not import SQLite, Provider adapters, Tool handlers, Runtime, EventBus,
or live pricing services. Storage owns ledger durability; a structural Tool
budget port is used where the Tools package needs an admission boundary, so
the dependency graph remains `tools -> core` forbidden and no package cycle
is introduced.

## Durable ledger

One narrow SQLite migration adds `run_budget_entries`. Each entry has a
stable `(run_id, kind, owner_id)` identity, where `kind` is `LLM_ATTEMPT` or
`TOOL_INVOCATION`, and `owner_id` is respectively the Step ID or Tool
Invocation ID. The unique key makes recovery idempotent. The row stores
reserved and actual input/output tokens, reserved and actual micro-USD cost,
optional model/pricing snapshot identity and rates, lifecycle timestamps,
and no prompts, arguments, secrets, provider responses, or raw errors.

The lifecycle is:

```text
RESERVED -> IN_FLIGHT -> SETTLED
RESERVED -> RELEASED
IN_FLIGHT -> CONSERVATIVE
```

`IN_FLIGHT` is never released merely because the host restarted. An
ambiguous LLM attempt becomes `CONSERVATIVE` using its reservation. A Tool
reservation is released only when the corresponding invocation is provably
not `RUNNING`; a `RUNNING` Tool remains counted and retains Phase 7/8
no-replay semantics.

Admission uses `consumed + outstanding reserved` for each dimension. Actual
settlement replaces the reservation and releases unused capacity. A missing
usage report is never interpreted as zero.

## Tool governance

Tool call budget is consumed exactly once at the first durable boundary where
the handler may start. Security denial, schema rejection, unavailable Tool,
approval waiting/rejection, and any preflight failure consume zero. A handler
that starts consumes one even if it returns a normal Tool error, is cancelled,
or reaches `UNCERTAIN_SIDE_EFFECT`.

The existing Batch coordinator first performs all non-executing validation,
availability, Security, and approval checks, then identifies the current
executable segment before the next approval/terminal barrier. It reserves the
whole executable segment before the first handler. If the segment cannot fit,
no handler starts, no orphan `REQUESTED` invocation remains, and the run is
finalized as `BUDGET_EXCEEDED`. Each handler transitions its reservation to
`IN_FLIGHT` atomically with `ToolInvocation REQUESTED -> RUNNING` before
calling the handler. Approval approval is not a reservation; after approval,
admission is rerun against the latest ledger.

## LLM token and cost governance

`maxTokens` is the canonical total token usage of every Provider attempt,
including retries and failed attempts with known usage. A provider-independent
`LLMTokenEstimatorPort` estimates the complete request: system/project
context, messages, Tool definitions/schemas, and Tool result messages. The
existing Context UTF-8 heuristic is reused where its semantics are suitable;
otherwise a bounded conservative estimator is injected. If `maxTokens` is
enabled and no safe estimate exists, the run fails closed before a Provider
call with `BUDGET_ENFORCEMENT_UNAVAILABLE`.

Before each Provider call, remaining token capacity is calculated from the
ledger, at least one output token is required, and `maxOutputTokens` is
clamped to the minimum of the caller setting and token/cost allowances.
Budget-blocked calls create no AgentStep and no Provider attempt. A provider
reservation and Step `RUNNING` checkpoint are committed before the external
call. Provider usage is normalized without mechanically adding cached input
or reasoning subsets. Reliable actual usage settles the reservation truthfully;
actual usage greater than the reservation is recorded truthfully and can
trigger budget finalization. Missing usage keeps the reservation conservative.

`maxCost` is externally denominated in USD and internally accumulated as
integer micro-USD. Decimal conversion is deterministic; cost multiplication
uses BigInt intermediates, ceiling rounding, and safe-integer checks. Pricing
comes from a host-injected/versioned `ModelPricingResolverPort`, and the
selected pricing snapshot/rates are stored in the ledger. No Core or Runtime
code performs live pricing lookup. If `maxCost` is enabled without reliable
pricing, the run fails closed before a Provider call; if it is disabled,
pricing remains optional and unknown cost is projected as `undefined` rather
than zero.

## Finalization and recovery

`finalizeBudgetExceeded()` is the single budget terminalizer. It reloads the
latest snapshot, re-applies cancellation/deadline/maxSteps/terminal authority,
disarms retry and deadline scheduling, cancels pending approvals, cleans
Run-owned resources, settles/clears active execution state and continuation,
and atomically commits `BUDGET_EXCEEDED` with the projected usage. If cleanup
cannot be confirmed it returns `BUDGET_EXCEEDED_PENDING`, which is a controller
outcome and not a Protocol `RunStatus`; recovery retries cleanup only and
never resumes Agent, Tool, Provider, Retry, Approval, or Verification work.

Normal budget exhaustion emits exactly one sanitized `budget.exceeded` and
one `status.changed`, persists before notifying subscribers, and never emits
`run.failed`. The event carries only the dimension and integer limit/accounted
values; it contains no prompts, Tool args, output, secrets, provider response,
or raw error. Recovery first reconciles stale ledger entries and projections,
then applies the same authority order before considering retry or any other
boundary. Retry wakes reload the latest ledger and perform budget admission
before `retry.started`, the new Step, or the Provider call. Completed Tools are
never replayed.

## Verification strategy

Tests are written first and must be observed failing before implementation.
Focused coverage includes safe limits, micro-USD arithmetic, reservation
state transitions and uniqueness, conservative crash recovery, Tool security/
approval/start/error/cancellation/uncertainty accounting, executable-segment
preflight, token estimation and clamping, usage normalization, missing and
over-reservation settlement, pricing snapshots, retry accounting, authority
priority, terminal cleanup, exact-once events, and Phase 10A/10B/10C plus
Phase 6/7/8/9 regressions. Full verification runs lint, typecheck, plain
tests, build, changed-file formatting, `git diff --check`, and the clean
build gate. Existing repository formatting debt is measured and must not
increase.

## External characterization references

The current AI SDK `streamText` reference documents that total usage can
differ from `inputTokens + outputTokens` because it may include reasoning or
other overhead. OpenAI's usage documentation describes input token counts as
including cached tokens and exposes cached/reasoning details as breakdowns.
These references support treating detail fields as subsets unless the
adapter proves otherwise; they do not provide runtime pricing and are not
used for live budget lookup.

- https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- https://platform.openai.com/docs/api-reference/usage/audio_transcriptions_object
- https://platform.openai.com/docs/api-reference/batch/object?api-mode=responses
