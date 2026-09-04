# Caelush V1.00 — Context Runtime Correctness Repair V2

> USER-APPROVED DESIGN

Date: 2026-09-04
Scope: production context-runtime correctness and observability repair only.

## Goal

Make every real daemon provider turn use an authoritative model profile, one coherent input-budget
calculation, bounded single/batch tool observations, recoverable open-turn pressure, closed
ExecutionUnit compaction, one-shot provider overflow recovery, and durable context telemetry.

The end state is `READY FOR USER MANUAL CONTEXT ACCEPTANCE`. This task does not merge `master` and
does not claim a real DeepSeek long-task, 50+ tool soak, or hour-scale production run.

## Root-cause boundary

The current branch baseline already contains partial repairs from the previous context round. The
v2 work therefore tests the actual current master instead of copying the older report: profile
injection and basic overflow recovery exist, while checkpoint token authority, open-turn raw-result
reprojection, typed durable cursors, authoritative checkpoint state, and complete telemetry remain
incomplete. Any candidate that is already fixed is recorded as such and is not reimplemented under a
new name.

## Architecture

`ContextRuntimeCoordinator` remains the sole production context authority. It resolves a local
`ModelContextProfile`, derives a `ContextPolicy`, loads durable context state, projects model-facing
observations from durable raw results, and executes a deterministic pressure ladder. `ContextBuilder`
continues to own message assembly and token estimation; it receives one effective input limit and
does not subtract the policy safety reserve a second time.

Closed conversation work is projected into `ExecutionUnit`s and compacted only at unit boundaries.
Open tool units remain present, but their model-facing observations can be regenerated at
`NORMAL`, `TIGHT`, `EMERGENCY`, or `MINIMAL` detail. Checkpoints persist a typed durable cursor,
authoritative bounded facts, and measured before/after estimates before the rebuilt request is
eligible for a provider side effect.

## Fixed profile and budget rules

Resolution precedence is explicit per-model configuration, verified local metadata, legacy input
limits, then conservative fallback; an existing override source remains supported only where the
public contract already exposes it. No network lookup is permitted. The single arithmetic authority
is:

```text
rawContextWindowTokens - outputReserveTokens - safetyReserveTokens
  = effectiveInputLimitTokens
```

The effective limit is the model input budget. Safety is consumed exactly once.

## Fixed observation and recovery rules

Policy owns both single-observation and complete-batch limits. Allocation is deterministic in
assistant source order and preserves a non-empty protocol-safe result for every requested call.
Durable raw output is retained separately; tightening never repeatedly truncates an already
truncated projection. Ordinary pressure is consumed internally. Only an unrecoverable mandatory
overflow becomes `CONTEXT_EXHAUSTED`; ordinary context pressure must not escape as runtime
`BUDGET_EXCEEDED`.

Provider context overflow is normalized by the provider adapter, triggers one emergency rebuild with
rehydration and a fresh request, and retries at most once. Tool invocations are never redispatched as
part of this recovery.

## Fixed telemetry rules

The existing `context_runtime_states` table is extended only through committed migration-safe fields;
no synonym table is introduced. Durable state contains safe numeric identity, profile, raw/effective
limits, estimate/remaining/ratio, pressure, compaction, build status, recovery stages, and numeric
breakdown fields. It never stores prompts, tool arguments/output, memory content, secrets, or hidden
reasoning. The existing Web ring and inspector consume this authoritative state without a layout
redesign.

## Non-goals

No V1.01/V1.02, Phase 14, new Context or Memory engine, MCP, RAG, web search, sub-agent runtime,
skill system, network model metadata, parallel tool execution, retry policy, timeout/cancellation
redesign, sandbox, remote runtime, or automatic merge to `master`.
