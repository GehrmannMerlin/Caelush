# Caelush Architecture V2 — Phase 4 Tool System Round Plan

```text
PHASE 4 — Tool System V2 structural migration
rounds   exactly six: 4A, 4B, 4C, 4D, 4E, 4F
```

This document fixes the Phase 4 round decomposition and the acceptance boundary of each round. The
decomposition is frozen: no `4A-1`, no `4G`, no "cleanup round", and no work moved from an earlier
round into a later one to make the earlier round fit.

The whole of Phase 4 is a **structural migration of a serial Tool system**. No round in this phase
enables real parallel Tool execution, and no round changes a frozen Phase 3 contract.

---

## 0. Sources and authority

```text
Caelush_Tool_System_V2_Refactor_Spec                     the architecture intent
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze the frozen public contracts and target behaviour
docs/architecture/v2/MIGRATION_EXECUTION_CONTRACT.md      migration mechanics and evidence
Phase 3 documents                                         the frozen Run/Loop interfaces Phase 4 must not break
```

Priority when they disagree:

```text
1  this round's authorising prompt     the phase boundary
2  the Interface Freeze                the public contract and target behaviour
3  the Refactor Spec                   the architecture intent; its conceptual examples never override 2
4  the Phase 3 frozen interfaces       still in force
5  the Migration Execution Contract     ownership, compatibility direction, evidence
6  current source                      真实行为 and post-baseline drift; never overrides a frozen target
```

Both Tool documents were written against `master @ c5489f75a243193c9832a9f15875d9e41d8b6810`, which
is **not** the implementation baseline. Phase 4A records the document-to-source divergence in
[PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md](PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md) §1.

---

## 1. The six rounds

| Round  | Scope (fixed)                                                                                                                                                                                                                                    | Owner of the result                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **4A** | Tool contracts, general `AgentToolRegistry`, schema compilation and policy, `ToolCallPreparer`, `CodingToolDefinition`/`CodingToolCatalog` foundation, and the legacy entry adaptation that makes production registration and preflight delegate | `@caelush/agent`, `@caelush/coding-agent`                 |
| **4B** | `ToolInvocationExecutor`, result pipeline, safe transient updates                                                                                                                                                                                | `@caelush/agent`                                          |
| **4C** | Admission, Approval/Budget coordination, settlement, durable coordinator, Storage atomic-commit adaptation                                                                                                                                       | `@caelush/agent` ports, `@caelush/storage` implementation |
| **4D** | Batch coordinator, model feedback projection, result normalizer, production `ToolTurn` wiring                                                                                                                                                    | `@caelush/agent`, `@caelush/core`                         |
| **4E** | All nine Coding builtins, Operations ports, Runtime adapters, Coding metadata/effects/presentation/prompt integration                                                                                                                            | `@caelush/coding-agent`                                   |
| **4F** | Final production assembly, legacy production dependency removal, compatibility retirement, whole-phase acceptance                                                                                                                                | hosts and the whole Tool System                           |

### 1.1 What each round is allowed to leave open

A round may leave a responsibility with the legacy implementation **only** if this table names the
round that takes it. "Later" is not an exit round.

| Responsibility                                                      | 4A               | 4B        | 4C        | 4D          | 4E           | 4F                  |
| ------------------------------------------------------------------- | ---------------- | --------- | --------- | ----------- | ------------ | ------------------- |
| `AgentTool` / `AgentToolResult` / execution identity, mode, updates | **moves**        |           |           |             |              |                     |
| Canonical schema runtime, schema policy, JSON helpers               | **moves**        |           |           |             |              |                     |
| `AgentToolRegistry` + builder + model-spec projection               | **moves**        |           |           |             |              |                     |
| `ToolCallPreparer`                                                  | **moves**        |           |           |             |              |                     |
| `CodingToolDefinition` / `CodingToolCatalog` contracts              | **moves**        |           |           |             |              |                     |
| Legacy registration, preflight, argument validation                 | adapter          |           |           |             |              | retired             |
| `AgentTool.execute()` invocation                                    | façade           | **moves** |           |             |              |                     |
| Result validation / sanitization / bounding                         | legacy           | **moves** |           |             |              |                     |
| Transient execution updates                                         | —                | **moves** |           |             |              |                     |
| Security facts, admission, approval, budget                         | legacy           |           | **moves** |             | Coding facts | retired             |
| Invocation lifecycle, observation, durable settlement               | legacy           |           | **moves** |             |              |                     |
| Batch coordination, result ordering, model feedback                 | legacy           |           |           | **moves**   |              | legacy path removed |
| Production `ToolTurn` implementation                                | Phase 3D adapter |           |           | **rewires** |              |                     |
| The nine builtins and their Operations                              | legacy           |           |           |             | **move**     |                     |
| Effects, presentation, prompt snippets (Coding)                     | contracts        |           |           |             | **move**     |                     |
| `packages/tools` deletion, `protocol.ToolDefinition` retirement     | —                | —         | —         | —           | —            | **only 4F**         |

### 1.2 What every round must not do

```text
break a Phase 3 frozen interface            AgentLoop, AgentLoopAdvanceResult, ModelTurnExecutor,
                                            RunExecutionCoordinator, RunExecutionDirective,
                                            RunExecutionDriver(+Dependencies), RunExecutionEffect*,
                                            RunTransitionPlanner, RunContinuationCheckpoint,
                                            ToolTurnCoordinator, ToolTurnRequest, ToolTurnResult,
                                            CompletionGate(+Input/Decision)
enable real parallel Tool execution         PARALLEL_SAFE stays a declaration
implement terminate: true                   a Tool never ends a Run
add a DB table, migration or protocol field
put Workspace / Runtime / Registry / Store into ToolTurnRequest
add a ToolTurnResult discriminant for wiring convenience
let a Tool decide Run completed/failed/cancelled
bypass CompletionGate or Coding Verification
introduce MCP, Skills, Browser, Web Search, Multi-Agent or a remote Runtime
delete packages/tools or protocol.ToolDefinition before 4F
```

Dependency direction is unchanged: `agent` may depend only on `ai` and `protocol`
(plus `ajv` for the Tool schema runtime); `coding-agent` may depend on `ai`, `protocol`, `agent`
and `runtime`; compatibility always flows legacy → target, never target → legacy.

---

## 2. Phase 4A — the round this document fixes in detail

### 2.1 Authorised scope

```text
general executable Tool contracts
AgentToolRegistry
Tool schema compilation and generic schema policy
ToolCallPreparer
CodingToolDefinition / CodingToolCatalog foundation
legacy production registration and argument preparation adapted onto the target implementations
```

### 2.2 The questions 4A must be able to answer

```text
who owns the executable Tool contract?          @caelush/agent  (AgentTool extends AIToolSpec)
who owns schema compilation?                    @caelush/agent  (one AJV policy, one compiler)
who owns registration and resolution?           @caelush/agent  (AgentToolRegistry)
who owns argument preparation and validation?   @caelush/agent  (ToolCallPreparer)
where does Coding metadata live?                @caelush/coding-agent  (CodingToolCatalog)
how does the legacy entry delegate?             @caelush/tools adapters + facades, legacy → target
what is still the legacy Dispatcher's?          invocation lifecycle, admission, execution, result
                                                pipeline, settlement, recovery, batch — 4B to 4D
```

### 2.3 Forbidden deliverables

```text
adding interfaces only
adding a test-only V2 registry
leaving the legacy registry compiling and resolving on its own
maintaining two argument-validation algorithms
mechanically moving packages/tools into agent
creating throwing "implementations" that pretend 4B–4C exist
```

### 2.4 Milestones inside 4A (not rounds)

```text
A  frozen scope and contract map          the two Phase 4 documents
B  Tool foundation contracts              packages/agent/src/tools/types/**
C  canonical schema and registry          packages/agent/src/tools/schema|registry/**
D  Coding definition and catalog          packages/coding-agent/src/tools/**
E  canonical ToolCallPreparer             packages/agent/src/tools/call/**
F  production delegation and closure      packages/tools/** facades and adapters
G  behaviour tests and architecture guards
H  verification, commit, push, report
```

### 2.5 Transition boundary 4A deliberately preserves

The new Preparer creates no Invocation. The legacy Dispatcher's outer outcome and persistence
behaviour — including how it historically recorded an argument failure — is **not** rewritten in 4A.
Switching the production rejection path onto the new pipeline is a 4D acceptance item, and 4A must
not claim that the whole production Tool pipeline already satisfies Tool System V2.

---

## 3. Verification model

```text
per round        the round's target tests, the legacy suites its facades serve, the Phase 3 guards,
                 the daemon regression suites, and the full gate set below
whole phase      every round's evidence plus the 4F acceptance run
architecture     baseline_after <= baseline_before, new violations 0, stale baseline entries 0
```

Full gate set used by every round:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm check:architecture:ci
pnpm test
git diff --check
prettier --check <changed files>
```

Tests are evidence of behaviour and migration authority, never a completion metric: a round does not
finish by adding tests, and it never finishes by deleting assertions, lowering a bound, or adding a
skip.

---

## 4. Round completion references

A completed round links its own evidence here. Recording a completion does not change the round
decomposition above.

```text
4A  docs/architecture/v2/PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md
    docs/architecture/v2/PHASE_4A_TOOL_FOUNDATION_REPORT.md
    tests/architecture/phase-4a-tool-contract-boundaries.test.ts

4B  docs/architecture/v2/PHASE_4B_TOOL_EXECUTION_RESULT_ACCEPTANCE_MAP.md
    docs/architecture/v2/PHASE_4B_TOOL_EXECUTION_RESULT_REPORT.md
    tests/architecture/phase-4b-tool-execution-result-boundaries.test.ts

4C  docs/architecture/v2/PHASE_4C_DURABLE_TOOL_ORCHESTRATION_ACCEPTANCE_MAP.md
    docs/architecture/v2/PHASE_4C_DURABLE_TOOL_ORCHESTRATION_REPORT.md
    tests/architecture/phase-4c-durable-tool-orchestration-boundaries.test.ts

4D  docs/architecture/v2/PHASE_4D_BATCH_FEEDBACK_TOOLTURN_ACCEPTANCE_MAP.md
    docs/architecture/v2/PHASE_4D_BATCH_FEEDBACK_TOOLTURN_REPORT.md
    tests/architecture/phase-4d-tool-batch-feedback-boundaries.test.ts

4E  BLOCKED — stopped at its own Milestone A reconciliation gate; no code was changed. Evidence:
    docs/architecture/v2/PHASE_4E_CODING_TOOLS_OPERATIONS_ACCEPTANCE_MAP.md
    docs/architecture/v2/PHASE_4E_CODING_TOOLS_OPERATIONS_REPORT.md

4F  not started
```

### 4.4 The 4E blocked boundary, stated once

```text
Blocking condition   two frozen Operations contracts cannot express arguments their Tools must honour

  GitOperations.status   §169 carries { environment, signal } only, while git_status passes a real Git
                         pathspec to `git status -- <path>` and exposes a `limit` up to 1000. The
                         freeze demonstrably knows how to carry per-call arguments — GitOperations.diff
                         takes `args` and is explicitly allowed to carry scope and path — so status is
                         a deliberate omission rather than an oversight.

  SearchTextOperations   §165 carries { environment, pattern, path?, signal } only, while search_text
                         exposes `include` (ripgrep --glob, a path-level pre-filter applied before
                         truncation) and `limit`. Tool-side post-filtering cannot be equivalent,
                         because the port's own `limit` is the ceiling the Tool can request.

Forbidden treatments  widening either interface · silently dropping include/limit/path ·
                      simulating a Git pathspec with string matching · folding include into pattern ·
                      hidden global state · letting builtin code import RuntimeResolver

Also forbidden        migrating part of the nine and returning later; the round's own rule is to decide
                      implementable-or-BLOCKED before moving any Tool

Minimum decision      §165 gains `include?` and `limit`; §169.status gains `args: JsonObject`, symmetric
                      with the diff arm that already has one — or the freeze explicitly states the
                      reduced Tool behaviour as a deliberate product decision

Not a 4F concern      this is a missing statement in the freeze, not compatibility retirement

Unchanged by 4E       the whole 4D production Tool chain, all nine builtin owners, packages/tools,
                      protocol.ToolDefinition, and the architecture baseline (27 / 0 new / 0 stale)
```

### 4.3 The 4D transition boundary, stated once

```text
@caelush/agent now owns:  the canonical ToolBatchCoordinator (batch validation, duplicate
                          externalCallId validation, whole-batch budget preflight, strictly sequential
                          scheduling, the pre-invocation REJECTED item, the uncertain skip barrier, the
                          waiting-approval / budget / cancellation stops), the canonical
                          ToolResultBatchNormalizer, and the canonical ModelToolFeedbackProjector —
                          the model-facing Tool result exit.

@caelush/core now owns:   the Run ToolTurn host adaptation, Run resource governance, the Run lifecycle
                          compatibility, the Context token-projection adapter, and the frozen ToolTurn
                          mapping. It no longer owns a generic Tool batch algorithm, a generic result
                          batch normalization or generic model Tool feedback semantics.

@caelush/tools still owns: the legacy builtins, the legacy registration surface, the legacy Dispatcher
                          facade and its direct API, and the legacy Coding effects/facts/presentation.
                          Those exit in 4E / 4F. The legacy batch coordinator and the legacy batch
                          types remain as unreferenced compatibility surface.

Now true:                 production Tool requests travel from the model's ToolCalls to the next
                          AgentLoop TOOL_RESULTS entirely through Tool System V2. A pre-invocation
                          rejection creates **no** ToolInvocation row and still reaches the model as
                          safe feedback; the batch is the canonical one; the model view is produced by
                          the canonical projector and proved by the canonical normalizer.

Not yet true:             the nine Coding builtins are still legacy registrations, Operations
                          interfaces do not exist, real Coding builtin progress is not yet published,
                          no host consumes transient updates, and the legacy compatibility surface has
                          not been retired.
```

### 4.2 The 4C transition boundary, stated once

```text
@caelush/agent now owns:  the Tool security context, the admission ports and the admission
                          coordinator, the Tool budget admission port, the durable metadata seam,
                          the ToolInvocation lifecycle, the ToolObservation lifecycle, the durable
                          Tool store contract, the durable Tool events, ToolSettlementCoordinator
                          and DurableToolExecutionCoordinator — the Tool Invocation Lifecycle
                          Authority.

@caelush/storage now owns: the canonical ToolExecutionStorePort implementation, the atomic budget
                          terminal transition inside the terminal commit, and the named settlement
                          extension compatibility decoder.

@caelush/tools still owns: the batch coordinator and its outcomes, the legacy dispatcher entry point
                          and its outcome translation, the historical argument-failure durable row,
                          the nine builtins and the Coding effect vocabulary and its projection.
                          Those exit in 4D / 4E / 4F.

Not yet true:             the production Tool pipeline is not Tool System V2. A pre-invocation
                          rejection still creates the historical durable failure, the batch is still
                          the legacy coordinator, real Coding builtin progress is not yet published,
                          and no host consumes transient updates.
```

### 4.1 The 4B transition boundary, stated once

```text
@caelush/agent now owns:  AgentTool invocation (ToolInvocationExecutor), the safe transient update
                          lifecycle, and result processing (ToolResultPipeline).

@caelush/tools still owns: durable invocation lifecycle and recovery, admission/gate, approval,
                          budget, observation and event creation, the atomic settlement commit, the
                          batch coordinator, the nine builtins and the Coding effect vocabulary.
                          Those exit in 4C / 4D / 4E / 4F.

Not yet true:             the production Tool pipeline is not Tool System V2. A pre-invocation
                          rejection still creates the historical durable failure, real Coding builtin
                          progress is not yet published, and no host consumes transient updates.
```
