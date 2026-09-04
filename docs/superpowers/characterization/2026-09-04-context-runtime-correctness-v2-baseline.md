# Caelush V1.00 — Context Runtime Correctness V2 Baseline

Status: `CHARACTERIZATION IN PROGRESS`
Date: 2026-09-04
Baseline SHA: `c5489f75a243193c9832a9f15875d9e41d8b6810`
Task branch: `codex/v1-context-runtime-correctness-repair-v2`

## Git gate

The required baseline gate passed before any production behavior change:

- working tree: clean;
- `HEAD`: `c5489f75a243193c9832a9f15875d9e41d8b6810`;
- `master`: `c5489f75a243193c9832a9f15875d9e41d8b6810`;
- `origin/master`: `c5489f75a243193c9832a9f15875d9e41d8b6810`;
- baseline commit is an ancestor of `master`.

No worktree was created.

## Current production call graph

```text
WebSessionManager / Web prompt
  -> daemon create/start Run
  -> RunExecutionSupervisor
  -> RunController
  -> AgentLoop.run() / resumeWithToolResults()
  -> ContextRuntimeCoordinator.prepareModelContext()
  -> ContextBuilder.build()
  -> assembleContextBudget()
  -> buildAgentLLMRequest()
  -> LLMGateway -> provider adapter

Tool continuation:
  provider tool decision
  -> RunController
  -> ToolBatchCoordinator
  -> Security gate -> Dispatcher
  -> raw durable Tool result
  -> toLLMToolResultMessages()
  -> observation projection
  -> durable continuation result batch
  -> AgentLoop.resumeWithToolResults()
  -> ContextRuntimeCoordinator
  -> next Provider turn
```

Evidence is in `apps/daemon/src/daemon-composition.ts`,
`packages/core/src/run-controller.ts`, `packages/core/src/agent-loop.ts`,
`packages/core/src/agent-tool-batch.ts`, and
`packages/context/src/context-runtime-coordinator.ts`.

## Baseline focused test run

The existing focused context/core/daemon set passed at the baseline:

```text
pnpm vitest run packages/core/test/context-runtime-characterization.test.ts packages/context/test/context-runtime-coordinator.test.ts packages/context/test/context-budget.test.ts packages/context/test/compaction.test.ts packages/context/test/observation-projector.test.ts packages/core/test/context-runtime-integration-contract.test.ts apps/daemon/test/daemon-composition.test.ts
Test Files 7 passed (7)
Tests 20 passed (20)
```

These tests do not prove the v2 acceptance criteria; in particular, the coordinator tests still
accept placeholder checkpoint values and do not assert full durable telemetry or source-order raw
observation reprojection.

## Candidate matrix at current master

| Candidate                     | Current verdict   | Evidence before repair                                                                                                                                                                              |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Model profile wiring       | `PARTIALLY_FIXED` | `composeDaemon()` converts configured `modelProfiles` and injects `configuredProfiles`; known metadata, overrides, and a production registry are not independently wired.                           |
| B. Safety reserve twice       | `PARTIALLY_FIXED` | Policy path sets Builder `safetyMarginTokens` to `0`, but legacy/direct and policy semantics are not covered by a complete arithmetic matrix.                                                       |
| C. Observation hardcode       | `PARTIALLY_FIXED` | Core uses coordinator policy when available, but a legacy 32K-derived fallback remains and policy defaults retain an absolute single cap of 8192.                                                   |
| D. Fake/shallow compaction    | `PARTIALLY_FIXED` | History is no longer always cleared, but the coordinator checkpoint is built from placeholder authority and open-turn tightening receives already projected messages.                               |
| E. Proactive threshold        | `PARTIALLY_FIXED` | Coordinator checks the reported pressure ratio and conversation drop flag, but no explicit internal pressure state/hysteresis contract is durable.                                                  |
| F. Foundation wiring          | `PARTIALLY_FIXED` | ExecutionUnit, PressureController, and Rehydrator are called in coordinator code; authority inputs and durable cursor semantics are incomplete.                                                     |
| G. Provider overflow          | `PARTIALLY_FIXED` | AgentLoop calls `recoverProviderContextOverflow()` and rebuilds a request, but rehydration is a no-op and raw provider/attempt telemetry is not persisted.                                          |
| H. Checkpoint token telemetry | `CONFIRMED`       | `compact()` creates checkpoints with `tokensBefore` based on history only and `tokensAfter: 0`, then updates after a provisional build; this is not the required pre-provider authoritative record. |
| I. Restart usage hardcode     | `PARTIALLY_FIXED` | The old daemon `recoveredInputLimit = 32_000` path is absent, but persisted state lacks the complete v2 breakdown/recovery fields and profile restoration is not fully characterized.               |

## Reproduction to be added

The v2 regression must use a real `ContextRuntimeCoordinator`, real `ContextBuilder`, real policy,
real token estimator, and real model-facing Tool Result projection. The fixture contains one system
context, one user goal, one assistant Tool Call, and two Tool Results. The historical conversation is
eligible for removal while the mandatory open current turn remains oversized. The baseline assertion
records whether the current coordinator emits `ContextBudgetExceededError` or consumes it and emits
`ContextExhaustedError`; the distinction is intentional because the current branch already contains
partial recovery from the prior round and the report must not falsify the observed error.

## Observed RED evidence

The new real-builder characterization was run with:

```text
pnpm vitest run packages/core/test/context-runtime-correctness-v2-characterization.test.ts
Test Files 1 failed (1)
Tests 1 failed (1)
AssertionError: expected 2834 to be 810
```

The first real ContextBuilder report measured 810 model-input tokens. The coordinator's checkpoint
creation path measured only the durable history and wrote 2,834 tokens as `tokensBefore`; it also
created the checkpoint with `tokensAfter: 0`. This proves that checkpoint telemetry is not currently
describing the real pre-compaction and rebuilt contexts.

The current coordinator does consume some mandatory-content budget failures internally and can
eventually report `ContextExhaustedError`; therefore the older claim that every current-turn failure
still escapes directly as `ContextBudgetExceededError` is not reproduced on this master. The direct
real Builder budget path still raises `ContextBudgetExceededError`, and
`packages/core/src/agent-error-mapper.ts` maps that class to `BUDGET_EXCEEDED / RUNTIME`. V2 must
keep that mapping for genuine unrecoverable builder failures while ensuring ordinary pressure is
handled before it reaches the mapper.

## Static residual evidence

- `packages/context/src/context-runtime-coordinator.ts` computes checkpoint `tokensBefore` from
  `history` only, creates `tokensAfter: 0`, and uses a no-op rehydration callback in the AgentLoop
  overflow path.
- `packages/context/src/context-runtime-coordinator.ts` builds compaction units from a plain
  message array, so its source range is an array index rather than an explicitly typed durable
  conversation cursor.
- `packages/core/src/agent-tool-batch.ts` retains a legacy 32,000-derived observation policy when
  no runtime policy is available; the coordinator policy is not itself a raw-result store.
- `packages/storage/src/context-runtime-state-repository.ts` persists only the original seven-field
  breakdown and has no durable `lastBuildAt` or `lastRecoveryStages` field.
- `packages/protocol/src/api/context-usage.ts` and `apps/web/src/components/context-inspector.ts`
  do not expose raw context window, estimated used, or the full numeric breakdown.

## Prohibited baseline claims

No claim is made here that real DeepSeek, a 50+ Tool soak, 100+ Tool coding task, full-stack project
creation, or an hour-scale Run has been executed. Those belong to user manual acceptance.
