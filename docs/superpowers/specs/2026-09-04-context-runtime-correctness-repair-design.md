# Caelush V1.00 Context Runtime Correctness Repair Design

Status: `USER-APPROVED DESIGN`
Date: 2026-09-04
Scope: Context Runtime correctness repair only; no new Phase or UI redesign.

## Objectives

The daemon is the authority for model context capacity. Every provider turn must use one coherent
budget calculation:

```text
raw context window - output reserve - safety reserve = effective input limit
```

The final built input must satisfy `estimatedInputTokens <= effectiveInputLimit`. Safety is consumed
exactly once. Tool observations are projections of durable raw results, bounded both per item and
per batch, and may be tightened while preserving one assistant tool call to one tool result.

## Profile resolution

Resolution order is:

1. Explicit per-model daemon configuration.
2. Verified known metadata already present in the repository.
3. Legacy run `contextLimits.maxInputTokens`, marked `LEGACY_LIMITS` and not mislabeled as raw
   provider context.
4. Conservative `FALLBACK` only when no better authority exists.

The client does not select context capacity. `modelProfiles` is provider configuration data and does
not contain credentials. Environment JSON is strictly parsed and fails startup on malformed input.

## Runtime pipeline

`ContextRuntimeCoordinator` will resolve the profile and policy, load the durable checkpoint and
memory, build ExecutionUnits, project open-turn observations, build the context, measure pressure,
and apply a pressure ladder:

- `NORMAL`: send without compaction if the builder did not drop history.
- `PROACTIVE`: compact eligible closed history when the proactive threshold or dropped-history signal
  is reached.
- `EMERGENCY`: tighten open observations and shed optional context when ordinary compaction is not
  sufficient.
- `EXHAUSTED`: throw `ContextExhaustedError` only when system authority, goal, and minimal protocol
  content cannot fit.

Compaction persists a real structured checkpoint before rebuilding. Closed units may be absorbed by
the checkpoint; recent closed units remain as a recent tail; the open unit is never absorbed by
ordinary history compaction. Rehydration merges current authoritative state over durable checkpoint
state using the existing `ContextRehydrator`.

## Observation projection

`ContextPolicy` supplies `maxSingleObservationTokens` and `maxObservationBatchTokens`. Allocation is
deterministic in assistant source order, preserves required tool identity/status/reference data,
and gives each item a bounded share of the batch. Tightening levels reduce detail without deleting
protocol messages. Durable raw tool output remains in the tool observation store.

## Provider overflow

AgentLoop will use one recovery boundary around the provider turn. A structured context overflow
causes force pressure recovery, observation reprojection, closed-unit compaction, rehydration, a
fresh context build, and a rebuilt request. The retry is performed at most once. The original request
is never reused, and this occurs before a future tool side effect exists.

## Durable telemetry

Context runtime state is persisted as a small canonical projection containing profile identity,
window/effective limits, estimates, pressure, compaction count, safe breakdown numbers, last build
status, and update time. The ring reads this state after restart. Failure telemetry preserves the
last attempted bounded numbers and reports `CONTEXT_EXHAUSTED` separately from resource
`BUDGET_EXCEEDED`.

The Web layout remains frozen; only the existing ring/inspector data fields are corrected.

## Non-goals

No MCP, RAG, new Context V2, Settings Center, model UI, Terminal, diff viewer, parallel tool
execution, remote runtime, hard OS sandbox, memory extraction redesign, or merge to `master` is in
scope.
