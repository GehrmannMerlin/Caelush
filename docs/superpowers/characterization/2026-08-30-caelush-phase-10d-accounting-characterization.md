# Phase 10D Pre-Implementation Characterization Report

Baseline: `origin/codex/phase-10c-bounded-retry-backoff-recovery` at
`ce2a838663ccedb96467dd7c21099283b1913eb7`. The fresh baseline in the
Phase 10D worktree is `pnpm install --frozen-lockfile`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, and `pnpm build` passing; plain tests report
222 files, 820 passed, 4 skipped. `pnpm format:check` reports 607 existing
warnings and is the formatting baseline.

## Run limits and status

`packages/protocol/src/limits.ts` currently validates `maxSteps` and
`maxToolCalls` as positive integers, `timeoutMs` as a safe positive integer,
optional `maxTokens` as a positive integer, and optional `maxCost` as finite
non-negative USD. It does not yet reject unsafe positive `maxSteps`,
`maxToolCalls`, or `maxTokens`, nor does it require positive micro-USD-
representable `maxCost`. `RunStatus` already contains `BUDGET_EXCEEDED` and
the independent `MAX_STEPS_REACHED`/`TIMEOUT` statuses.

## Existing AgentState usage accounting

`packages/core/src/agent-state.ts` initializes `steps`, `toolCalls`,
`inputTokens`, and `outputTokens` to zero. `settleAgentStepState` increments
`usage.steps` once and adds only known `inputTokens` and `outputTokens` from
the settled LLM usage. It does not update `toolCalls` or `cost`; it does not
derive a total from optional usage detail fields. Cancellation of an active
Step increments `steps` once. `packages/core/src/agent-step-gate.ts` uses
`state.usage.steps` for the existing max-step structural gate.

Therefore, before 10D:

- `usage.steps` is settled-Step accounting, including failed attempts.
- `usage.inputTokens` and `usage.outputTokens` are best-effort known-field
  projections from Step settlement.
- `usage.toolCalls` remains zero/reserved; model requests do not increment it.
- `usage.cost` is never updated by the AgentLoop/RunController.
- `AgentState.usage` is not safe as a sole enforcement authority after a crash.

## Existing LLM usage and normalization

`packages/llm/src/usage.ts` exposes optional nonnegative integer fields:
`inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, and
`reasoningTokens`. `packages/llm/src/providers/openai-compatible/usage.ts`
maps AI SDK `inputTokens`, `outputTokens`, `totalTokens`, cache-read input
tokens, and reasoning output tokens directly into those fields. The stream
adapter retains the latest usage snapshot and the Gateway validates the
provider-independent schema; it does not add snapshots together.

The current contract proves field shape, not that cache tokens are additive
or that reasoning tokens are outside output tokens. Phase 10D must therefore
use a conservative normalizer: prefer a safe consistent `totalTokens`, use
safe complete input/output when available, treat cached/reasoning details as
breakdowns rather than automatic additions, and retain the reservation when
the fields are missing or inconsistent.

## Step and Provider lifecycle

`AgentLoop` prepares context and the LLM request before creating a Step. Its
`beforeProviderTurn` lifecycle hook in
`packages/core/src/run-controller.ts` currently reloads the Run and commits
the new Step as `RUNNING` together with `llm.started`; a retry continuation is
cleared and `retry.started` is emitted in this same commit. Only after this
hook does the Provider call occur. Provider failure settles the Step and
increments `usage.steps`; retry scheduling then creates `WAITING_RETRY`.

This is the existing insertion point that must be split/reordered for 10D:
pure request validation and budget admission must happen before Step
persistence, while the budget reservation and Step `RUNNING` checkpoint must
be committed before the Provider call. Retry admission must precede
`retry.started`.

## Tool invocation lifecycle and accounting point

`packages/tools/src/dispatcher.ts` validates the immutable registry input,
persists `REQUESTED` through the injected Tool execution Store, evaluates the
injected Security Gate, handles approval boundaries, and commits
`REQUESTED -> RUNNING` plus `tool.started` before invoking the handler. The
handler result is validated/sanitized and atomically settled with the terminal
Invocation, Observation, effects, and lifecycle event. Handler throws and
uncertain side effects have dedicated sanitized outcomes.

`packages/tools/src/batch-coordinator.ts` validates the entire batch first,
then calls the Dispatcher sequentially in source order. It stops at approval
or uncertainty and supplies skipped results for trailing calls. It currently
does not calculate an executable segment or reserve Tool-call capacity.

The 10D exact-once Tool accounting point is the first durable
`REQUESTED -> RUNNING` boundary, atomically paired with a budget reservation
transition to `IN_FLIGHT`. Security DENY, schema failure, unavailable Tool,
approval waiting/rejection, and handlers that never start must remain zero.

## Security and Approval ordering

Security is injected into the Tool Dispatcher as a gate and is evaluated
after durable `REQUESTED` persistence but before the handler start checkpoint.
Approval requests are created durably as a waiting boundary. The Run
Controller persists `WAITING_APPROVAL`, and approval resolution later resumes
the Tool boundary. No current code reserves Tool budget for an approval wait;
10D must preserve that zero-consumption behavior and rerun admission after
approval.

## Context token estimation

`packages/context/src/token-estimator.ts` provides the injectable
`TokenEstimator` port and `Utf8HeuristicTokenEstimator`, which estimates
UTF-8 bytes divided by three and rounded up. `ContextBuilder` uses this
estimator for the rendered system/project context, conversation messages,
relevant-file sections, current turn, and Tool-result messages through the
assembled context budget. `estimateLLMMessage` estimates a serialized full
message. No Provider-specific tokenizer exists.

The preferred 10D decision is to reuse this provider-independent heuristic
for the complete built LLM request, including serialized Tool definitions,
and expose a Core `LLMTokenEstimatorPort` adapter. The implementation must
document it as conservative/heuristic rather than exact. A configured
`maxTokens` with no safe estimator must fail closed before a Provider call.

## Storage transactions and migrations

Storage uses committed Drizzle migrations and a `CaelushDatabase` wrapper
around SQLite. `SqliteRunExecutionStore.commit` and
`SqliteToolExecutionStore.commit` both validate invariants, execute
`BEGIN IMMEDIATE`, write durable entities and events, commit, then notify
through the caller. Durable events are persisted before publication.

The Tool execution transaction already joins Invocation, Approval,
Observation, AgentState effects, and Tool lifecycle events. The Run execution
transaction joins Run, State, Step, conversation, continuation, and events.
Phase 10D adds one narrow `run_budget_entries` migration and must extend the
relevant transaction composition rather than write a budget row in a
separate race-prone transaction. Public Storage APIs must expose repository
contracts, not SQLite clients or row types.

## Pricing characterization

There is no existing pricing resolver, cost calculator, billing integration,
or live pricing lookup. The 10D port must be Provider-independent and accept
host-injected/versioned USD rates. The ledger must persist the selected
snapshot identity and rates so a restart or host pricing change cannot alter
the accounting of an existing attempt. `maxCost` is an enforcement estimate,
not a Provider billing guarantee.

## Explicit pre-10D gaps

The following are intentionally absent at this baseline and are the target
of the Phase 10D implementation: durable Tool/LLM reservation ledger,
BudgetManager, Tool batch budget admission, Tool start accounting,
token-estimator integration with Provider admission, `maxOutputTokens`
clamping, canonical usage normalization, micro-USD cost arithmetic, injected
pricing snapshots, cost/token settlement and recovery, budget terminal
finalization, `BUDGET_EXCEEDED_PENDING`, `budget.exceeded`, and usage
reconciliation. No Phase 11 Verification or `COMPLETED` work belongs here.
