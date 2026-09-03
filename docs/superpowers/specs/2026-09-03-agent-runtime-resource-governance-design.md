# Caelush — Agent Runtime Resource Governance Design

**Status:** Approved for implementation

**Milestone:** Cross-Cutting Runtime Refactor / Production Hardening

**Scope:** Internal Tasks 1–8. This is not a new product Phase and does not start Phase 14.

## 1. Goal and non-goals

The current production defaults (`maxSteps = 8`, `maxToolCalls = 8`, `timeoutMs = 10_000`) conflate normal operating capacity with an enterprise safety ceiling. A healthy workspace scan can therefore be terminated before discovery is complete. This design replaces the low fixed lifetime Tool-call ceiling with adaptive governance while preserving exact financial accounting, durable recovery, security, Approval, Verification, and hard enterprise termination.

This milestone does not implement MCP, Web Search, RAG, a sub-agent system, a generic policy DSL, distributed scheduling, Redis/Kafka, hard OS sandboxing, or new execution phases. It also does not make the LLM decide whether progress occurred.

## 2. Current execution graph and baseline finding

The current path is:

```text
User / client
  ↓ POST /api/v1/sessions/:sessionId/runs
CreateRunRequestSchema → RunLimits
  ↓ daemon RunService creates PENDING AgentRun
RunController.start()
  ↓ starts Run and derives deadline from run.limits.timeoutMs
AgentLoop.run() / resumeWithToolResults()
  ↓ evaluateAgentStepGate(state, run.limits)
  ↓ beforeProviderAdmission → RunBudgetPort.admitLLM()
LLMGateway → selected LLMProvider (one provider turn)
  ↓ AgentLoop classifies TOOL_CALLS_REQUESTED or FINAL_CANDIDATE
RunController persists the decision / continuation
  ↓ ToolBatchCoordinator.execute()
ToolBatchCoordinator preflight
  ↓ currently RunBudgetPort-backed Tool budget admission
ToolDispatcher → Gate → durable REQUESTED → RUNNING → handler → settlement
  ↓ results normalized to assistant source order
RunController resumes AgentLoop or enters VERIFYING
  ↓ budget settlement / reconcileState / status transition
BUDGET_EXCEEDED when hard legacy accounting rejects the batch
```

Concrete current ownership:

- `packages/protocol/src/limits.ts` defines the required legacy `RunLimits` contract.
- `packages/core/src/agent-step-gate.ts` gates Agent steps using `run.limits.maxSteps`.
- `packages/core/src/agent-loop.ts` creates one `AgentStep` per settled provider turn and calls the injected provider-admission hook.
- `packages/core/src/budget-manager.ts` currently treats `limits.maxToolCalls` as the lifetime Tool-call ceiling and separately handles exact token/cost admission.
- `packages/storage/src/run-budget-port.ts` reserves LLM or Tool accounting through `SqliteBudgetLedgerRepository`; `settleLLM()` and `recover()` retain crash-safe accounting.
- `packages/tools/src/batch-coordinator.ts` performs complete-batch preflight before invoking the Dispatcher.
- `packages/tools/src/dispatcher.ts` is the only single-Tool execution boundary and owns durable invocation lifecycle through the injected store.
- `packages/core/src/run-controller.ts` owns Run transitions, continuation checkpoints, budget settlement, recovery, and Verification boundaries.
- `packages/core/src/run-deadline.ts` derives `startedAt + run.limits.timeoutMs`; `run-deadline-registry.ts` schedules an ephemeral callback and rechecks after wake.
- `apps/daemon/src/daemon-composition.ts` currently publishes `DEFAULT_RUN_CONFIGURATION` with `maxSteps: 8`, `maxToolCalls: 8`, and `timeoutMs: 10_000`.

The first regression test intentionally captures the current failure: with `maxToolCalls = 8`, four calls already accounted, and a five-call model batch, the old admission returns `BUDGET_EXCEEDED`. The test remains as the red baseline characterization and is changed to assert adaptive behavior after the migration.

## 3. Canonical policy model

`@caelush/protocol` gains an additive `RunResourcePolicy` contract. Exact property names may follow existing repository conventions, but the semantics below are fixed:

```ts
type RunResourcePolicy = {
  mode: "ADAPTIVE" | "LEGACY_FIXED";
  operationalLease: {
    maxAgentTurns: number;
    maxToolOperations: number;
  };
  batch: {
    maxToolCallsPerTurn: number;
  };
  progress: {
    windowTurns: number;
    identicalCallNudgeThreshold: number;
    noProgressTurnsBeforeReplan: number;
    replansBeforePause: number;
  };
  hardLimits: {
    maxAgentTurns?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    maxCost?: number;
    maxWallClockMs?: number;
    maxChangedFiles?: number;
    maxMutationBytes?: number;
  };
  inactivity: {
    nudgeAfterMs?: number;
    pauseAfterMs?: number;
  };
};
```

The daemon is the canonical owner of `DEFAULT_ADAPTIVE_RESOURCE_POLICY`. Initial defaults are a 24-Agent-Turn operational lease, a 64-operation operational lease, a 16-call per-turn batch bound, an 8-turn progress window, a three-repeat nudge threshold, a four-no-progress-turn replan threshold, and two unsuccessful replans before a guard pause. These are centralized constants, validated as positive safe integers, and never copied into Web or CLI.

Operational lease values are checkpoints, not lifetime quota. A healthy run renews the lease durably and continues. `toolCallsConsumed` and `agentTurnsConsumed` remain observable accounting counters, but only configured hard limits can terminally stop an Adaptive run for resource usage.

Legacy compatibility is explicit:

- A request containing `resourcePolicy` uses the canonical policy path.
- A request containing only legacy `limits` is normalized to `mode: "LEGACY_FIXED"`.
- `maxSteps` maps to hard maximum Agent Turns.
- `maxToolCalls` maps to hard maximum Tool operations.
- `timeoutMs` maps to the legacy hard Run deadline.
- `maxTokens` and `maxCost` remain exact financial/accounting hard limits.
- If an Enterprise policy exists, request policy and legacy limits are intersected with it; a client cannot increase an administrator limit.

New Runs use Adaptive defaults. Existing non-terminal Runs without a stored policy recover as `LEGACY_FIXED` using their stored `limits`, so a restart does not silently change their meaning.

## 4. Turn, Tool batch, lease, and hard-limit semantics

An Agent Turn is one settled LLM assistant response cycle. Five Tool Calls in one response consume one Agent Turn and five Tool operations. `maxToolCallsPerTurn` is a per-response sanity guard; it is not a lifetime budget and must not be used as the AgentLoop iteration count.

Before a Tool batch, governance evaluates the complete batch before dispatch. The possible outcomes are data-bearing decisions, not booleans:

```text
ALLOW
ALLOW_WITH_NUDGE
RENEW_AND_ALLOW
REPLAN
WAIT_FOR_RESOURCE_DECISION
HARD_STOP
```

Healthy progress at an operational checkpoint renews the lease and allows the entire batch. A batch over `maxToolCallsPerTurn` is atomically rejected with `REPLAN_REQUIRED`; it does not terminally fail the Run. A replan produces one safe synthetic Tool result for every requested Tool Call, in source order, and dispatches zero handlers. Ordinary pressure is not provider retry.

Hard token, cost, administrator Tool, mutation, or wall-clock ceilings remain authoritative. Hard cost cannot be converted into a replan. Soft lease renewal never creates a new financial reservation or increases a monetary ceiling. `budget.exceeded` is emitted only for an actual hard ceiling, preserving legacy event compatibility.

## 5. Durable resource governance state

The existing budget ledger remains the financial/accounting ledger. It continues to own reservations, exact settlement, conservative settlement, CAS/unique-owner behavior, and recovery. A separate SQLite resource-governance state stores bounded operational state:

- `runId`, policy version, and mode
- lease epoch, lease start Agent-Turn count, and lease start Tool-operation count
- last progress timestamp
- consecutive no-progress turns
- replan count and resource guard state
- bounded recent fingerprint/progress summary
- revision, created timestamp, and updated timestamp

No raw Tool arguments, raw Tool output, credentials, provider payloads, or secrets are stored. Lease renewals are durable and revision-checked. Recovery restores the epoch, progress summary, guard state, and accounting reconciliation without double-counting. A durable `WAITING_RESOURCE` boundary is recoverable and never causes already-settled Tool calls to run again.

## 6. Deterministic Progress Ledger and loop detection

Progress is computed from Runtime and durable observations. The implementation recognizes these signals where the existing ports can provide them:

- `NEW_DISCOVERY`
- `NEW_OBSERVATION`
- `WORKSPACE_MUTATION`
- `DIFF_CHANGED`
- `VALIDATION_DELTA`
- `VALIDATION_IMPROVEMENT`
- `PROCESS_DELTA`
- `PROJECT_FACT_DELTA`

There is no `MODEL_CLAIMS_PROGRESS` signal.

Every Tool observation gets internal request and result fingerprints. Request identity is a versioned hash of Tool name plus canonical JSON arguments. Result identity is a versioned hash of safe canonical result identity. The fingerprint is retained only as a hash in bounded durable state and telemetry; it is not included in public lifecycle payloads.

The detector uses a bounded recent window (initially eight turns and at most a configured 32–64 observation summary). Exact repeated request plus unchanged result is strong evidence; an unchanged request with a changed result is new information. Semantic string similarity alone never rejects a Tool call.

Escalation is deterministic:

```text
HEALTHY → OBSERVE → NUDGE → FORCED_REPLAN → WAITING_RESOURCE → HARD_STOP
```

`NUDGE` allows the current Tool batch and injects a short runtime guidance message on the next provider request. `FORCED_REPLAN` skips the complete current batch with zero side effects and returns cardinality-preserving synthetic Tool results. Repeated unsuccessful replans enter durable `WAITING_RESOURCE`, where only user/admin Continue or Cancel can decide the next action. No fake completion percentage is produced.

## 7. Core integration boundaries

The Resource Governor is an injected Core port/component. It may coordinate with the RunController and existing budget port, but AgentLoop remains provider-independent and Tool-agnostic. It does not execute Tools, access Storage directly, call Runtime, implement Approval, or own Verification.

Governance hooks occur at turn boundaries:

```text
before turn admission
  → one LLM provider turn
  → Tool batch admission / execution boundary
  → ordered Tool results
  → durable progress recording
  → after-turn decision
```

The RunController remains the canonical lifecycle owner. It atomically commits Run, AgentState, AgentStep, real conversation messages, continuation checkpoints, and durable lifecycle events. A final candidate moves the Run to Verification, never directly to `COMPLETED`. Approval and Security checks remain in their existing boundaries.

Resource guidance is safe and bounded. Normal healthy turns receive no large dynamic prompt. Nudge/pressure/replan guidance contains no raw hidden reasoning, model answer text, Tool arguments, secrets, internal costs, database revision, or hard thresholds.

## 8. Timeout and long-process ownership

Timeout authorities remain distinct:

- Provider timeout is a provider/LLM error.
- Tool timeout is a Tool error.
- Process timeout is a process error.
- Inactivity is a governance signal.
- Hard Run deadline is the only Run-level `TIMEOUT` authority.

Adaptive defaults do not install the old ten-second global Run timeout. A started Run deadline is derived from its original `startedAt` and its configured hard deadline; PENDING Runs have no active deadline. Deadline scheduling remains Core-owned, ephemeral, injectable, rechecked after wake, chunked for long delays, and disarmed for terminal/PENDING Runs.

Long-running process sessions remain Runtime-owned and are observed through existing bounded session APIs. `yield_time_ms` remains observation wait, not a kill timeout. The agent must not busy-poll the LLM merely because a process is still running.

## 9. Context and workspace discovery

The existing Context package remains responsible for `ProjectIntelligenceSnapshot`, bounded discovery, and relevant-file planning. It does not depend on Core governance or LLM types. Workspace scans should prefer project facts, `find_files`, and targeted `search_text`, and should avoid repeated unscoped `list_directory` calls. No second project scanner is introduced.

Durable conversation preserves user, assistant, and normalized external Tool-result messages. Synthetic relevant-file context and bounded model projections are not appended to the durable ledger. Context limits remain bounded independently of the lifetime Tool-operation count.

## 10. Protocol, daemon, client, CLI, and Web

Protocol changes are additive and schema-validated. `DaemonInfo.defaultRunConfiguration` publishes the canonical adaptive policy summary. Existing V1 clients remain accepted through the legacy adapter. Invalid or ambiguous policy payloads fail explicitly rather than being silently interpreted.

The client exposes safe resource-guard projections and a Continue action. CLI and Web consume the same client/protocol semantics. Web adds only an inline Resource Guard card and a suitable sidebar status icon with accessible labels; it does not add a resource dashboard or settings center. Public language uses “调整执行策略”, “任务已安全暂停”, or “达到资源限制”, not internal lease numbering. The UI never renders a fabricated progress percentage.

`WAITING_RESOURCE` is non-terminal. Continue resumes the same Run, does not rerun settled Tool invocations, does not bypass Approval, cannot increase Enterprise limits, and does not alter Verification authority. Cancel and Reload/Recovery retain existing canonical RunController paths.

## 11. Testing and delivery gates

Each internal Task follows TDD: write a focused failing test, observe the expected failure, implement the minimum behavior, run the focused suite, then run the relevant package suite. Existing BudgetManager, maxSteps, maxToolCalls, token, cost, reservation, settlement, and recovery tests are retained and explicitly classified as legacy or hard-limit behavior.

Required coverage includes:

- protocol policy validation and legacy mapping
- durable state migration, CAS, lease renewal, and recovery
- deterministic progress/fingerprint and exact-repeat escalation
- replan zero-side-effect and Tool Call↔Tool Result cardinality
- AgentLoop turn semantics and atomic RunController boundaries
- bounded context/workspace discovery
- separated timeout behavior and long-process observation
- daemon defaults and info projection
- client, CLI, Web Resource Guard Continue/Cancel/Recovery
- a workspace scan with more than eight Tool operations
- a deterministic workload with more than 100 Tool operations and multiple lease renewals
- legacy and new create-run payload E2E
- hard cost/Tool ceilings, Approval, Security, Verification, and duplicate-side-effect recovery

Final validation order:

```text
git diff --check
changed-file formatting check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:web:e2e
pnpm build:release
pnpm test:release
```

Sub-agents are not required for this implementation. If one is created later, it must use exactly `gpt-5.6-luna`; no silent fallback is permitted, and the completion report must record the model audit.

## 12. Fixed internal task sequence

1. Runtime / Budget / Long-task Baseline Audit
2. Canonical Resource Policy + Protocol Compatibility
3. Durable Resource Ledger + Renewable Operational Lease
4. Progress Ledger + No-progress / Loop Detection
5. AgentLoop Resource Awareness + Replan Admission
6. Timeout / Polling / Workspace Discovery / Context Pressure Refactor
7. Resource Guard Pause / Continue / CLI + Web Integration
8. Long-workload Integration / E2E / Regression / Release / Git Seal

These are internal implementation tasks only. No Task 8-1, Task 8-2, Task 9, Phase 14, or later product capability is introduced.
