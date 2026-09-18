# Caelush Architecture V2 — Phase 3 Responsibility and Compatibility Inventory

This document is the closing inventory for the **Phase 3 Agent Loop execution-chain migration**. It
states, for every responsibility that moved or stayed, where the canonical implementation now lives,
who reaches it in production, what remains declared for compatibility, and when that compatibility
ends.

It covers Phase 3A–3F only. It is not an inventory of the whole Architecture V2 migration: Context,
Tool, Security, Memory and Coding Agent still own substantial cross-package work, and §5 names where
each of those remains.

---

## 0. Evidence base, and what was not available

The Phase 3 design attachments (`Caelush_Agent_Loop_V2_Refactor_Spec*.md`,
`Caelush_Agent_Loop_V2_Current_to_Target_Interface_Freeze*.md`) and the Phase 3A–3E round reports are
**not present in this repository**. `git ls-files` finds no such file under any name or suffix
variant, and `docs/architecture/v2/` contains only the Phase 1 and Phase 2 documents.

Two consequences are recorded rather than papered over:

1. Every "frozen clause" statement in this inventory is derived from the **frozen contracts as they
   exist in source** — `packages/agent/src/loop/**`, `packages/agent/src/run/**`, the Phase 3A/3B/3C
   contract tests under `packages/agent/test/contracts/`, and the Phase 3C/3D/3E/3F architecture
   guards under `tests/architecture/`. Source is the implementation fact.
2. The Phase 3A–3E **round narratives** exist only as commit messages on the phase branches
   (`deepseek/architecture-v2-phase-3a-*` … `phase-3e-*`). No historical claim in this document
   depends on a report that cannot be read.

---

## 1. Canonical owners

One responsibility, one home. "Production entry" names the expression a running daemon evaluates;
"Consumers" counts production call sites only.

| Responsibility                                  | Canonical owner                                                                                                                          | Production entry                                                             | Consumers      | Public surface          | Evidence                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| General Reason (`advance()`)                    | `packages/agent/src/loop/agent-loop.ts` — `createAgentLoop`                                                                              | `packages/core/src/run-agent-execution.ts` → `createRunAgentLoop`            | 1              | `@caelush/agent` root   | `packages/agent/test/agent-loop-advance.test.ts`, `standalone-kernel.test.ts`           |
| Model execution (one provider turn)             | `packages/agent/src/loop/turn/model-turn-executor.ts` — `createModelTurnExecutor`                                                        | `apps/daemon/src/daemon-composition.ts` (once)                               | 1 construction | `@caelush/agent` root   | `packages/agent/test/model-turn-executor.test.ts`; guard: `phase-3f-agent-loop-closure` |
| Decision classification                         | `packages/agent/src/loop/decision/decision-classifier.ts`                                                                                | composed in `run-agent-execution.ts` and `run-controller.ts`                 | 2              | `@caelush/agent` root   | `decision-classifier.test.ts`                                                           |
| Context assembly port                           | `packages/agent/src/loop/context/context-engine-port.ts` (contract only)                                                                 | host adapter: `packages/core/src/legacy-context-runtime-adapter.ts`          | 1              | `@caelush/agent` root   | `context-provider-conformance.test.ts`                                                  |
| Run execution decisioning                       | `packages/agent/src/run/run-execution-coordinator.ts`                                                                                    | `RunController.coordinator`                                                  | 1              | `@caelush/agent` root   | `run-execution-coordinator.test.ts`                                                     |
| Effect execution (Agent / Tool / Completion)    | `packages/agent/src/run/run-execution-driver.ts`                                                                                         | `RunController` — three constructions, one per effect                        | 3              | `@caelush/agent` root   | `run-execution-driver.test.ts`; guard: `phase-3f` §driver                               |
| Effect → durable commit planning                | `packages/agent/src/run/default-run-transition-planner.ts`                                                                               | `RunController.transitionPlanner`                                            | 1              | `@caelush/agent` root   | `run-transition-planner.test.ts`                                                        |
| Tool turn execution                             | `packages/core/src/run-tool-turn-coordinator.ts` (run-scoped adapter)                                                                    | `RunController.toolTurnDriver`                                               | 1              | Core-private            | `run-tool-turn-driver.test.ts`; guard: `phase-3d-tool-turn-boundaries`                  |
| Coding completion evaluation                    | `packages/core/src/run-completion-gate.ts` — `createRunCompletionGate`                                                                   | `packages/core/src/run-completion-assembly.ts` (once)                        | 1              | `@caelush/core` root    | `run-completion-gate.test.ts`; guard: `phase-3e-completion-authority`                   |
| General completion evaluation                   | `packages/agent/src/run/gates/direct-accept-completion-gate.ts`                                                                          | composed by a general host                                                   | 0 in this repo | `@caelush/agent` root   | `standalone-run-execution.test.ts`                                                      |
| Completion composition                          | `packages/core/src/run-completion-assembly.ts` — `createCodingCompletionAssembly`                                                        | `apps/daemon/src/daemon-composition.ts` → `RunController.completionAssembly` | 1              | `@caelush/core` root    | `run-completion-assembly.test.ts`                                                       |
| Run lifecycle commit                            | `packages/core/src/run-controller.ts`                                                                                                    | `RunController`                                                              | 1              | `@caelush/core` root    | `run-controller-*.test.ts`                                                              |
| Completion persistence (plan + verified result) | `packages/storage/src/run-execution-store.ts` — `SqliteRunExecutionStore implements RunExecutionStorePort, RunCompletionPersistencePort` | `RunController.completionPersistence()`                                      | 1              | `@caelush/storage` root | `verification-restart.test.ts`; guard: `phase-3e`                                       |
| Run state machine                               | `packages/agent/src/run/state/run-state-machine.ts`                                                                                      | re-exported by `packages/core/src/run-state-machine.ts`                      | 1              | `@caelush/agent` root   | `run-state-machine.test.ts`                                                             |
| Durable Step lifecycle                          | `packages/agent/src/run/turn/step-lifecycle.ts`                                                                                          | `RunController`                                                              | 1              | `@caelush/agent` root   | `run-state-machine.test.ts`                                                             |

### 1.1 The eight questions, answered

```text
who calls the model             the Run Layer, through the frozen ModelTurnExecutor the daemon built
who executes Tools             the Tool System, through the Run Layer's run-scoped Tool turn adapter
who creates the reviewer       the completion assembly — never the Run Layer, never the daemon
who creates the gate           the completion assembly — once per Run evaluation
who opens the candidate        the Run Layer (openCompletionBoundary); the assembly only plans it
  boundary
who produces acceptance        the coding verification subsystem, behind the frozen CompletionGate
  evidence
who commits the Run terminal   RunController, and nothing else
who recovers a continuation    RunController.recover() → coordinator → the same frozen driver
legacy fallback                none: no second Reason, Tool or completion path is reachable
```

---

## 2. What Phase 3F changed

### 2.1 Run Layer dependency surface

```text
BEFORE  RunControllerDependencies carried eighteen verification* fields, read one by one
        by the Run Layer, which also built the TaskAcceptanceReviewer itself
AFTER   RunControllerDependencies.completion is one RunCompletionAssembly port
```

|                                                               | Before              | After                                  |
| ------------------------------------------------------------- | ------------------- | -------------------------------------- |
| Completion collaborators named by `RunController`             | 18 optional fields  | 1                                      |
| Modules that read the flat group                              | `run-controller.ts` | `run-completion-compatibility.ts` only |
| Modules that build the reviewer                               | `run-controller.ts` | `run-completion-assembly.ts` only      |
| Modules that reach `@caelush/verification` from the Run Layer | `run-controller.ts` | none                                   |
| Verification field names in `run-controller.ts`               | 18                  | 0 (guard-enforced)                     |

The eighteen fields are **not deleted**: `MIGRATION_EXECUTION_CONTRACT.md` Rule 5 keeps a public entry
point stable until the subsystem's deletion stage, and they were consumed by daemon and test
compositions. They stay declared on `RunControllerDependencies`, and
`run-completion-compatibility.ts` is the single module that reads them.

### 2.2 Controller composition closure

| Moved out of `RunController`                                             | New owner                    |
| ------------------------------------------------------------------------ | ---------------------------- |
| `new TaskAcceptanceReviewer({...})`                                      | `run-completion-assembly.ts` |
| `createRunCompletionGate(dependencies)`                                  | `run-completion-assembly.ts` |
| `createRunCandidateBoundaryPlanner({...})`                               | `run-completion-assembly.ts` |
| Per-field assembly of the gate's 18 host facts                           | `run-completion-assembly.ts` |
| `verificationRecoveryStore()` — the execution-store compatibility bridge | `run-completion-assembly.ts` |
| `compileVerificationRepairContext({...})`                                | `run-completion-assembly.ts` |

| Kept by `RunController`                                                                    | Why                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `load()` / `withLock()` / `cancel()`                                                       | lifecycle and lock authority                           |
| `coordinator.next()`                                                                       | the only routing authority                             |
| `createRunExecutionDriver({...})` ×3                                                       | the only effect execution path                         |
| `commit()` / `commitCandidateBoundary()` / `commitVerifiedCompletion()`                    | the only lifecycle committer                           |
| `notify()`                                                                                 | durable events publish only through the ledger's owner |
| `finalizeCancellation` / `finalizeTimeout` / `finalizeMaxSteps` / `finalizeBudgetExceeded` | termination authority                                  |
| `resultFromSnapshot()`                                                                     | terminal/suspended projection                          |

---

## 3. Compatibility inventory

Every entry is a **declared** compatibility surface with a named owner, a named consumer set, and an
exit condition. "Authority" states what it explicitly does _not_ own.

| #   | Compatibility surface                                                                                                 | Reason kept                                                                                                      | Consumers                                             | Dependency direction                       | Authority it does not have                                                                                                             | Exit condition                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `RunControllerDependencies.verification*` (18 flat fields)                                                            | Rule 5 public-surface stability; daemon and test compositions used them                                          | `run-completion-compatibility.ts` only                | Core-internal                              | Executes nothing; regroups fields and calls the one assembly factory                                                                   | Deleted with the flat group at the verification subsystem's deletion stage       |
| 2   | `run-completion-compatibility.ts`                                                                                     | the one place the flat group is read                                                                             | `RunController` constructor                           | Core-internal                              | No gate, no reviewer, no store, no commit (guard-enforced)                                                                             | same as #1                                                                       |
| 3   | `packages/core/src/legacy-model-turn-executor.ts` (`createLegacyModelTurnExecutor`)                                   | declared public export of `@caelush/core`; the frozen `AgentLoopDependencies` port shape                         | its own tests; `packages/core/src/index.ts` re-export | Core-internal                              | Not constructed by any production file (guard-enforced)                                                                                | Deleted with the legacy Core `AgentLoop` facade                                  |
| 4   | `packages/core/src/model-turn-error-mapping.ts`                                                                       | the legacy facade drives a throw-based executor and needs a thrown-failure projection                            | `agent-loop.ts`; re-exported by #3                    | Core-internal, `@caelush/agent` types only | Not a second `AIError` classifier for the frozen executor                                                                              | Deleted with #3                                                                  |
| 5   | `packages/core/src/agent-loop.ts` (`AgentLoop` class)                                                                 | declared public export; the pre-3B Reason facade with its own parity tests                                       | its own tests; `packages/core/src/index.ts` re-export | Core → `@caelush/agent` (legacy → target)  | No production execution consumer; it delegates to `createAgentLoop` and adds no budget, Step, retry or completion semantics of its own | Deleted when its parity coverage is retired                                      |
| 6   | `packages/core/src/legacy-context-runtime-adapter.ts`                                                                 | the frozen `ContextEnginePort` must be realised over the current Context System                                  | `apps/daemon/src/daemon-composition.ts`               | Core → `@caelush/context`                  | Assembles no provider prompt and owns no model-call policy                                                                             | Deleted when Context V2 owns real context assembly                               |
| 7   | `packages/core/src/run-message-compatibility.ts`, `run-continuation-compatibility.ts`, `agent-continuation-schema.ts` | durable conversation and continuation encodings are already persisted; renaming them would be a schema migration | `run-execution-store.ts`, storage codecs              | Core-internal                              | No second continuation discriminant is added; historical encodings are immutable                                                       | Deleted when the durable encodings are rewritten under their own subsystem phase |
| 8   | `packages/core/src/run-completion-store.ts` (`RunCompletionPersistencePort`)                                          | keeps the general Run store port free of verification vocabulary                                                 | `SqliteRunExecutionStore`, `RunController`            | Core-internal                              | Reads and commits only; owns no verification workflow                                                                                  | Converged into the completion subsystem's own phase                              |
| 9   | `packages/core/src/run-agent-deferred-ports.ts` (`MISROUTED_*`)                                                       | the frozen driver requires all three collaborators per effect                                                    | `RunController`                                       | Core-internal                              | Fails closed; it is not an unimplemented placeholder                                                                                   | Kept permanently                                                                 |
| 10  | `@caelush/core` itself                                                                                                | the Coding-side composition that has not moved into `@caelush/coding-agent`                                      | `apps/daemon`                                         | legacy → target where it can be            | Not the general kernel: `@caelush/agent` owns that                                                                                     | The Coding Agent subsystem's own migration                                       |

### 3.1 Known divergence, recorded

`packages/core/src/model-turn-error-mapping.ts` and `@caelush/agent`'s own
`toModelTurnExecutionError` are two projections of the same event. They are **not** semantically
identical: the Core one maps _any_ object carrying a string `code` and always uses one sanitized
sentence; the kernel one maps an `AIError` instance and prefers its (already sanitized) message.
Merging them would change the legacy facade's observable error text, which Rule 10 forbids inside a
migration unit and Rule 5 forbids as a side effect of relocating code. The divergence is therefore
recorded, not removed, and its convergence is an explicit deletion-stage act (compatibility #4).

---

## 4. What was checked and found already correct

These were verified in source during Phase 3F and needed no change:

| Property                                                              | Where it is enforced                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `advance()` is the only general Reason entry                          | `packages/agent/src/loop/agent-loop.ts`                              |
| `AgentLoop` executes no Tool and writes no Run state                  | kernel source + `standalone-run-execution.test.ts`                   |
| Step identity is allocated by the Run Layer                           | `RunController` + `nextAgentStepSequence`                            |
| The durable boundary precedes provider I/O                            | `run-model-turn-boundary.ts` + `phase-3c` guard                      |
| The coordinator is pure and deterministic                             | `run-execution-coordinator.ts` + `run-execution-coordinator.test.ts` |
| The driver executes effects and commits no lifecycle                  | `run-execution-driver.ts`                                            |
| `FINAL_CANDIDATE` never equals `COMPLETED`                            | `run-completion-gate.ts`, `completion-authority.ts`                  |
| The completion decision union is exactly `ACCEPT/REPAIR/REJECT/ERROR` | `phase-3e` guard                                                     |

---

## 5. Remaining targets and their owning subsystem

Nothing below is started, promised or scheduled by Phase 3F. It is the honest remainder of
Architecture V2 after the Agent Loop execution chain closed.

| Remaining target                                                             | Owning subsystem               | Why it is not Phase 3F                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@caelush/context` → `agent` + `coding-agent` split                          | Context V2                     | the frozen `ContextEnginePort` is satisfied by an adapter; the package split is its own migration |
| Context summary / compaction algorithm                                       | Context V2                     | a new algorithm is a subsystem change, not a relocation                                           |
| `@caelush/tools` → `agent` (contracts) + `coding-agent` (built-ins) split    | Tool System V2                 | the frozen `ToolTurnCoordinator` port is already the general boundary                             |
| `@caelush/security` → `agent` + `coding-agent` + `runtime` split             | Security V2                    | the Gate port is already general; the policy implementations are coding-side                      |
| `@caelush/verification` → `agent` + `coding-agent` split                     | Coding Agent / Verification V2 | this is what compatibility #1 and #8 wait on                                                      |
| Coding Agent package consolidation                                           | Coding Agent V2                | the whole `@caelush/core` coding side moves with it                                               |
| Memory automatic extraction closure                                          | Memory V2                      | a daemon worker exists; the loop is a subsystem feature                                           |
| Message System V2 / Session V2                                               | Message & Session V2           | durable encodings are frozen by compatibility #7                                                  |
| MCP, Skills, Browser Agent, Computer Use, Web Search, Multi-Agent, Sub-Agent | their own subsystems           | none is part of the Agent Loop execution chain                                                    |
| True parallel Tool execution                                                 | Tool System V2                 | Phase 7C froze sequential execution deliberately                                                  |
| A general durable Run store with no verification shape                       | Run Layer V2                   | the durable `AWAITING_VERIFICATION` continuation is a frozen encoding; see the Phase 3F report §8 |
