# Agent Runtime Resource Governance Baseline

**Baseline commit:** `5f526ad90c0638c6e8bae342ad43c6b4f63cd7bd`

**Task branch:** `codex/runtime-resource-governance-refactor`

## Current execution graph

```text
Client User
  ↓ POST /api/v1/sessions/:sessionId/runs
CreateRunRequestSchema (packages/protocol/src/api/run.ts)
  ↓ RunService persists PENDING AgentRun with RunLimits
RunController.start()
  ↓ startAgentState / startAgentRun; deadline is derived from run.limits.timeoutMs
AgentLoop.run() or AgentLoop.resumeWithToolResults()
  ↓ evaluateAgentStepGate(state, run.limits)
  ↓ lifecycle.beforeProviderAdmission()
RunBudgetPort.admitLLM() → BudgetManager.admitLLM()
  ↓ one LLM provider turn through the LLMGateway
AgentLoop classifies TOOL_CALLS_REQUESTED or FINAL_CANDIDATE
  ↓ RunController persists the open Tool continuation
ToolBatchCoordinator.execute()/recover()
  ↓ dispatcher.preflightBudget() for the complete batch
ToolDispatcher → durable REQUESTED → RUNNING → handler → observation settlement
  ↓ normalizeToolResultBatch() and toLLMToolResultMessages()
RunController resumes AgentLoop or creates the Verification boundary
  ↓ RunBudgetPort.settleLLM(), reconcileState(), and canonical Run transition
BUDGET_EXCEEDED when the lifetime Tool-call admission rejects a batch
```

## Current ownership observations

| Concern | Current owner and behavior |
| --- | --- |
| Agent step admission | `packages/core/src/agent-step-gate.ts:evaluateAgentStepGate` compares `state.usage.steps` with `run.limits.maxSteps`. |
| Agent Turn creation | `packages/core/src/agent-loop.ts:executeProviderTurn` creates one `AgentStep` for one provider response. |
| LLM reservation | `packages/storage/src/run-budget-port.ts:admitLLM` snapshots the budget, calls `BudgetManager.admitLLM`, inserts a durable reservation, and marks it in flight. |
| Tool reservation | `SqliteRunBudgetPort.admitToolBatch` calls `BudgetManager.admitToolCalls` using `limits.maxToolCalls`, then creates one durable entry per invocation. |
| Tool batch gate | `packages/tools/src/batch-coordinator.ts` validates the full batch and calls the injected Dispatcher preflight before dispatching. |
| Tool commit | `ToolDispatcher` starts only after the durable `RUNNING` checkpoint and settles the invocation/observation through the execution store. |
| LLM settlement | `RunController.settleBudgetAttempt` calls `RunBudgetPort.settleLLM`; the Storage port settles exact usage or marks conservative. |
| Cost settlement | `SqliteRunBudgetPort.settleLLMForOwner` computes micro-USD from the stored pricing snapshot and exact normalized usage. |
| Recovery | `RunController.recover` rebuilds the durable execution boundary; `RunBudgetPort.recover` calls `recoverInFlight` so reservations are not counted twice. |
| State reconciliation | `SqliteRunBudgetPort.reconcileState` reads the accounting snapshot and rewrites usage counters through `AgentStateSchema`. |
| Deadline | `deriveRunDeadline` computes `startedAt + run.limits.timeoutMs`; `RunDeadlineRegistry` schedules and rechecks the callback. |
| Status transition | `RunController` calls the canonical state/run transition helpers; `budget.exceeded` is emitted only by budget finalization. |
| Production defaults | `apps/daemon/src/daemon-composition.ts:DEFAULT_RUN_CONFIGURATION` currently sets `maxSteps: 8`, `maxToolCalls: 8`, and `timeoutMs: 10_000`. |

## Reproduced incident

The RED test in `packages/core/test/resource-baseline.test.ts` uses the production-shaped legacy limits (`8/8/10_000`), four already-consumed Tool calls, and a five-call model batch. On the baseline implementation, `BudgetManager.admitToolCalls()` returns:

```json
{
  "kind": "EXCEEDED",
  "dimension": "TOOL_CALLS",
  "accounted": 4,
  "limit": 8
}
```

This is the wrong behavior for an Adaptive healthy Run, but it is the expected behavior of the current legacy fixed policy. The regression remains red until Task 2 and Task 5 introduce explicit Adaptive policy admission.

## Healthy workload characterization

The same test defines twelve deterministic, distinct discovery operations across three conceptual Agent Turns: directory discovery, file selection, file reads, and targeted text searches. Every operation has a distinct fixture identity. This separates Tool operation count from Agent Turn count and is the seed for the later >100-operation integration workload.

## Timeout audit

The current `timeoutMs` is a Run-level deadline input. `deriveRunDeadline()` reads it from `AgentRun.limits` only after `startedAt` exists, and `RunDeadlineRegistry` schedules a callback which the RunController handles through the existing termination authority. The current code does not use `timeoutMs` as a Tool or Process timeout. Provider and Runtime operation timeout semantics remain at their respective injected boundaries and must not be inferred from this Run deadline.

## Baseline conclusion

The defect is semantic rather than a single off-by-one error: a lifetime accounting ceiling is being used as normal operational capacity. The refactor must preserve legacy behavior for explicit legacy payloads while moving new daemon-created Runs to a separately modeled Adaptive operational lease with hard enterprise limits remaining authoritative.
