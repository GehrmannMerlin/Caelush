# Caelush Context Runtime Correctness Baseline

Status: `CHARACTERIZATION COMPLETE`  
Date: 2026-09-04  
Baseline: `3be40eaf6d012216b30b29cfc38b43b8be5d7762`  
Task branch: `codex/v1-context-runtime-correctness-repair`

This document records the production-path evidence gathered before changing production logic. The
characterization suite is `packages/core/test/context-runtime-characterization.test.ts`, and was
run with `pnpm vitest run packages/core/test/context-runtime-characterization.test.ts`.

## Actual production call graph

The source call graph is:

```text
Web Prompt
  -> daemon HTTP route / RunExecutionSupervisor
  -> RunController
  -> AgentLoop
  -> prepareTurn()
  -> ContextRuntimeCoordinator.prepareModelContext()
  -> ContextBuilder.build()
  -> assembleContextBudget()
  -> buildAgentLLMRequest()
  -> LLMGateway/provider turn
```

The tool continuation path is:

```text
LLM tool decision
  -> RunController
  -> ToolBatchCoordinator
  -> Dispatcher
  -> raw Tool result
  -> toLLMToolResultMessages()
  -> Model Observation projection
  -> AgentLoop.resumeWithToolResults()
  -> ContextRuntimeCoordinator
  -> next provider turn
```

Evidence: `packages/core/src/agent-loop.ts`, `packages/core/src/agent-tool-batch.ts`,
`packages/core/src/run-controller.ts`, `apps/daemon/src/daemon-composition.ts`, and
`packages/context/src/context-runtime-coordinator.ts`.

## Candidate root-cause ledger

| Candidate                                                                               | Evidence                                                                                                                                                                              | File(s)                                                                                         | Test/evidence                                                                                                              | Verdict   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------- |
| A. Production composition does not inject model profiles                                | `composeDaemon()` constructs `ContextRuntimeCoordinator` without configured/known/override/fallback profile inputs.                                                                   | `apps/daemon/src/daemon-composition.ts`                                                         | Profile characterization returns `FALLBACK` with `contextWindowTokens=16000` for an otherwise configured daemon path.      | CONFIRMED |
| B. Safety reserve is deducted twice on the policy path                                  | `ContextBuilder` converts a policy effective limit into `limits.maxInputTokens` while retaining the same policy safety reserve; `assembleContextBudget` subtracts that reserve again. | `packages/context/src/context-builder.ts`, `packages/context/src/context-budget.ts`             | Real builder/profile test with 16K/2048/512 reproduces `ContextBudgetExceededError` for content that belongs under 13,440. | CONFIRMED |
| C. Tool observation has no dynamic whole-batch policy                                   | Conversion uses `MAX_MODEL_OBSERVATION_TOKENS = 8192` per result and has no policy/batch allocation input.                                                                            | `packages/core/src/agent-tool-batch.ts`                                                         | Source scan and observation projection tests show per-item cap only.                                                       | CONFIRMED |
| D. Compaction drops history rather than compacting execution units                      | Coordinator creates a minimal checkpoint and returns `history: []`; `currentTurnMessages` is unchanged.                                                                               | `packages/context/src/context-runtime-coordinator.ts`                                           | Large real open continuation still fails after history is empty because mandatory current-turn content remains.            | CONFIRMED |
| E. Proactive threshold is not wired into coordinator                                    | Policy exposes 0.75 threshold, but coordinator only compacts after emergency pressure or a build error.                                                                               | `packages/context/src/context-policy.ts`, `packages/context/src/context-runtime-coordinator.ts` | Existing policy threshold behavior passes in isolation; production coordinator has no proactive branch.                    | CONFIRMED |
| F. Existing ExecutionUnit/Rehydrator/PressureController are not composed by coordinator | These types exist and have unit tests, but coordinator does not build units, call the pressure controller, or rehydrate after compaction.                                             | `packages/context/src/execution-unit.ts`, `compaction.ts`, `context-rehydrator.ts`, coordinator | Call graph/source scan.                                                                                                    | CONFIRMED |
| G. Provider overflow recovery is not integrated into AgentLoop                          | `recoverProviderContextOverflow()` exists, but `executeProviderTurn()` calls the provider directly and maps the first error to failure.                                               | `packages/context/src/context-overflow.ts`, `packages/core/src/agent-loop.ts`                   | Deterministic overflow integration characterization is part of the repair suite; current code has no recovery call site.   | CONFIRMED |
| H. Checkpoint telemetry uses message count/zero instead of token estimates              | Coordinator writes `tokensBefore: history.length` and `tokensAfter: 0`.                                                                                                               | `packages/context/src/context-runtime-coordinator.ts`                                           | Source evidence; storage checkpoint tests currently accept the malformed values.                                           | CONFIRMED |
| I. Restart usage recovery hardcodes 32K                                                 | Daemon fallback uses `recoveredInputLimit = 32_000` and fabricates a normal usage projection.                                                                                         | `apps/daemon/src/daemon-composition.ts`                                                         | Source evidence; restart-state integration test will fail before repair.                                                   | CONFIRMED |

## Baseline test outcomes

- Real continuation protocol grouping remains three messages per open tool turn and preserves the
  assistant/tool relationship across 32 cycles.
- The real coordinator with a large open tool result fails as `ContextBudgetExceededError` because
  the current turn is mandatory and compaction has no current-turn reprojection path.
- The real profile resolver falls back to `FALLBACK` and 16,000 tokens when daemon composition
  provides no model profile.
- The safety arithmetic characterization is intentionally RED before repair: the policy effective
  limit is 13,440, but the builder path cannot admit a mandatory payload that should fit because it
  subtracts the 512-token reserve a second time.

The RED result is the gate for production changes. No fake builder or fabricated pressure trace was
used.
