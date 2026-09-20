# Caelush Architecture V2 — Phase 4C Durable Tool Orchestration Report

```text
PHASE 4C — Admission, Durable Tool Lifecycle & Atomic Settlement Migration
branch    deepseek/architecture-v2-phase-4c-durable-tool-orchestration
base      Phase 4B tip  53717d1e44afe3376e4a6a61b6ed3467cfc370e1
```

Phase 4C is the third of the six frozen Phase 4 rounds. It moved **Admission, Approval and Tool Budget
coordination, the ToolInvocation and ToolObservation lifecycles, durable recovery, the durable Tool
store contract, terminal settlement and the Coding effects compatibility bridge** out of the legacy
`ToolDispatcher` and into `@caelush/agent`, and made `@caelush/storage` implement the canonical store
port directly.

The result is one authority:

```text
DurableToolExecutionCoordinator   the Tool Invocation Lifecycle Authority
```

It did **not** rewrite the batch coordinator, migrate the nine builtins, retire the legacy
pre-invocation rejection path, or delete `packages/tools`. Those are 4D, 4E and 4F.

---

## 1. Phase identity and the fixed six rounds

```text
4A  Tool contracts, general Registry, schema, call preparation, Coding catalog foundation      COMPLETE
4B  Invocation Executor, Result Pipeline, safe transient updates                                COMPLETE
4C  Admission, Approval/Budget, Settlement, Durable Coordinator, Storage atomic-commit          THIS ROUND
4D  Batch, Model Feedback, Result Normalizer, production ToolTurn wiring                        NOT STARTED
4E  All nine Coding builtins, Operations, Runtime adapters, Coding metadata/effects/presentation NOT STARTED
4F  Final production assembly, legacy removal, compatibility retirement, whole-phase acceptance   NOT STARTED
```

Frozen in [PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md](PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md). No `4C-1`, no `4C-2`,
no `4G`, no "cleanup round". Milestones A–I existed only as internal construction stages inside 4C.

---

## 2. Baseline, branch, base SHA

|                       | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Repository            | `D:/Develop/Caelush`                                               |
| Base branch           | `deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline` |
| Base SHA              | `53717d1e44afe3376e4a6a61b6ed3467cfc370e1`                         |
| Base ancestor of HEAD | yes (`git merge-base --is-ancestor` exit 0)                        |
| Working branch        | `deepseek/architecture-v2-phase-4c-durable-tool-orchestration`     |
| Remote 4C branch      | did not exist before this round, so nothing was overwritten        |
| Starting working tree | clean                                                              |

---

## 3. Specifications read

The two frozen Tool documents are **not present in this repository**. They were supplied as attachments
in earlier rounds and are referenced by
[PHASE_4A_TOOL_FOUNDATION_REPORT.md](PHASE_4A_TOOL_FOUNDATION_REPORT.md) §3 and
[PHASE_4B_TOOL_EXECUTION_RESULT_REPORT.md](PHASE_4B_TOOL_EXECUTION_RESULT_REPORT.md) §3 with their line
counts:

```text
Caelush_Tool_System_V2_Refactor_Spec.md                        4015 lines
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md   6196 lines
```

They remain unreachable from this checkout, so **no clause was guessed and no section number was
invented**. Every frozen interface this round implements was taken from the Phase 4C authorising
prompt, which states each contract verbatim, and the acceptance map records the divergence at §L.1.

Read from the repository, at the Phase 4B baseline:

```text
AGENTS.md
docs/architecture/v2/MIGRATION_EXECUTION_CONTRACT.md
docs/architecture/v2/PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md
docs/architecture/v2/PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md
docs/architecture/v2/PHASE_4A_TOOL_FOUNDATION_REPORT.md
docs/architecture/v2/PHASE_4B_TOOL_EXECUTION_RESULT_ACCEPTANCE_MAP.md
docs/architecture/v2/PHASE_4B_TOOL_EXECUTION_RESULT_REPORT.md
docs/architecture/v2/PHASE_3F_AGENT_LOOP_CLOSURE_REPORT.md
docs/architecture/v2/PHASE_3_AGENT_LOOP_MIGRATION_SUMMARY.md
docs/architecture/v2/PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md
docs/architecture/v2/PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md
scripts/architecture/v2-rules.mjs
scripts/architecture/legacy-import-baseline.json
```

---

## 4. Source scanned

Every path in the authorising scope was located and read.

```text
packages/agent/src/tools/**                     every module, including the 4A/4B layers
packages/agent/src/index.ts
packages/tools/src/dispatcher.ts                (1486 lines at the base)
packages/tools/src/{dispatcher-types,dispatcher-ports,dispatcher-errors,execution-store,
                    invocation-lifecycle,observation,event-factory,approval-key,security-context,
                    tool-failure-memory,settlement-extension-bridge,registry,registry-builder,
                    tool-adapters,tool-effects,output-policy,result-validation,preflight,index}.ts
packages/security/src/{tool-gate,default-composition,index}.ts and the policy/evaluator modules
packages/coding-agent/src/tools/**
packages/storage/src/{tool-execution-store,run-budget-port,budget-ledger-repository,storage,index}.ts
packages/storage/src/repositories/{approval,observation,tool-invocation}-repository.ts
packages/storage/src/state-snapshot-writer.ts
packages/storage/src/events/**
packages/core/src/{budget-manager,budget-ports,agent-errors,tool-security-context,
                    run-tool-turn-coordinator,agent-tool-batch}.ts
packages/protocol/src/{tool,approval,run}.ts and protocol/src/events/**
apps/daemon/src/{daemon-composition,daemon}.ts
the dispatcher, approval, budget, storage, recovery, architecture and daemon-composition test suites
```

---

## 5. What was built

### 5.1 `@caelush/agent` — the canonical tool shell

```text
packages/agent/src/tools/admission/
  security-context.ts         ToolSecurityContext, its assertion and its typed error
  durable-metadata-port.ts    ToolDurableMetadata / ToolDurableMetadataPort (the migration seam)
  admission-decision.ts       ToolAdmissionRequest, ToolApprovalRequirement, ToolPolicyDecision
  admission-port.ts           ToolAdmissionPort, ToolAdmissionPreCheck
  approval-port.ts            ToolApprovalLookupPort, ToolApprovalRequestFactory
  budget-port.ts              ToolBudgetAdmissionPort
  admission-coordinator.ts    ToolAdmissionCoordinator, ToolAdmissionOutcome

packages/agent/src/tools/durable/
  invocation-lifecycle.ts     the one transition table, and the lifecycle invariant
  observation.ts              createToolObservation, assertToolObservationInvariant
  durable-events.ts           the canonical durable Tool event factories
  execution-store-port.ts     ToolExecutionStorePort, Snapshot, Commit, CommitResult, event types
  durable-errors.ts           ToolExecutionConflictError, ToolExecutionInvariantError
  failure-settlement.ts       the bounded durable failure settlement
  settlement-coordinator.ts   ToolSettlementCoordinator
  durable-execution-coordinator.ts   DurableToolExecutionCoordinator
```

### 5.2 `@caelush/tools` — compatibility only

```text
security-context.ts       → re-exports @caelush/agent
invocation-lifecycle.ts   → re-exports @caelush/agent
observation.ts            → re-exports @caelush/agent
execution-store.ts        → re-exports @caelush/agent
event-factory.ts          → re-exports @caelush/agent

dispatcher.ts             → a compatibility facade: validate, prepare, delegate, translate
tool-admission-adapter.ts      Security/Coding ToolAdmissionPort over the legacy gate
approval-lookup-adapter.ts     the legacy approval lookup onto the canonical port
tool-budget-adapter.ts         the legacy budget shape onto the canonical port
tool-execution-store-compatibility.ts   the effects facets onto the opaque extension
settlement-extension-bridge.ts  project and decode the coding effects extension
tool-failure-memory.ts          the failure memory as a ToolAdmissionPreCheck
```

### 5.3 `@caelush/storage`

```text
tool-execution-store.ts               implements @caelush/agent ToolExecutionStorePort
tool-settlement-extension-adapter.ts  the named compatibility decoder
run-budget-port.ts                    the legacy Tool budget plus createSqliteToolBudgetAdmission
repositories/approval-repository.ts   implements the canonical approval lookup
storage.ts                            threads the settlement decoder into the store
```

### 5.4 Production composition

`apps/daemon/src/daemon-composition.ts` now assembles every canonical port from its real
implementation and hands the coordinator to the facade; `apps/daemon/src/daemon.ts` wires the
settlement decoder where the storage instance is opened.

---

## 6. Before/after durable responsibility inventory

| Responsibility                  | Before 4C                                    | After 4C                                  | Bridge                               | Exit    |
| ------------------------------- | -------------------------------------------- | ----------------------------------------- | ------------------------------------ | ------- |
| create `REQUESTED`              | `ToolDispatcher.dispatchLocked`              | `DurableToolExecutionCoordinator`         | —                                    | —       |
| commit `REQUESTED`              | `ToolDispatcher.commitAndNotify`             | `DurableToolExecutionCoordinator`         | —                                    | —       |
| policy admission (`applyGate`)  | `ToolDispatcher.applyGate`                   | `ToolAdmissionCoordinator`                | `createCodingToolAdmissionPort`      | 4E / 4F |
| approval grant check            | `ToolDispatcher.applyGate`                   | `ToolAdmissionCoordinator`                | `toCanonicalApprovalLookup`          | 4F      |
| approval key computation        | `packages/tools/approval-key.ts`             | the Security/Coding admission adapter     | re-exported entry point              | 4F      |
| `ApprovalRequest` creation      | `ToolDispatcher.createApprovalRequest`       | the injected `ToolApprovalRequestFactory` | `createV1ToolApprovalRequestFactory` | 4F      |
| Tool budget reserve / `admit`   | `ToolDispatcher.startAndExecute`             | `ToolAdmissionCoordinator`                | `toCanonicalToolBudgetPort`          | 4D / 4F |
| budget `IN_FLIGHT`              | `ToolDispatcher.startAndExecute`             | the `RUNNING` commit, same transaction    | `budgetStart` hint                   | 4F      |
| budget settle                   | `ToolDispatcher.executeHandler`              | the terminal commit, same transaction     | idempotent `settle`                  | 4F      |
| `RUNNING` transition            | `ToolDispatcher.startAndExecute`             | `DurableToolExecutionCoordinator`         | —                                    | —       |
| invoke `ToolInvocationExecutor` | `ToolDispatcher.executeHandler`              | `DurableToolExecutionCoordinator`         | host factory                         | 4F      |
| invoke `ToolResultPipeline`     | `ToolDispatcher.executeHandler`              | `DurableToolExecutionCoordinator`         | host factory                         | 4F      |
| terminal invocation creation    | `ToolDispatcher.executeHandler`              | `ToolSettlementCoordinator`               | —                                    | —       |
| `ToolObservation` creation      | `ToolDispatcher.executeHandler`              | `ToolSettlementCoordinator`               | —                                    | —       |
| extension decode                | `ToolDispatcher.legacyEffectsFromSettlement` | the storage compatibility decoder         | `tool-settlement-extension-adapter`  | 4E / 4F |
| apply `ToolEffect[]`            | `ToolDispatcher` → store                     | the storage compatibility boundary        | the injected `HostToolEffectsPort`   | 4E / 4F |
| `AgentState` mutation           | `tool-execution-store.ts`                    | unchanged, now through the decoder port   | the decoder port                     | 4F      |
| `RUNNING` recovery              | `ToolDispatcher.failInterrupted`             | `DurableToolExecutionCoordinator`         | —                                    | —       |
| `WAITING_APPROVAL` recovery     | `ToolDispatcher.recoverWaitingApproval`      | `DurableToolExecutionCoordinator`         | —                                    | —       |
| terminal recovery               | `ToolDispatcher.recoverLocked`               | `DurableToolExecutionCoordinator`         | —                                    | —       |
| durable event creation          | `packages/tools/event-factory.ts`            | `@caelush/agent` factories                | re-exported entry point              | 4F      |
| committed event notification    | `ToolDispatcher.commitAndNotify`             | the coordinator and the settlement layer  | —                                    | —       |

---

## 7. Ownership answers

```text
Who owns ToolInvocation lifecycle?        DurableToolExecutionCoordinator
Who owns Admission?                       ToolAdmissionCoordinator
Who defines Admission ports?              @caelush/agent
Who implements Coding/Security admission? the Security/Coding compatibility adapter
Who owns Tool execution?                  ToolInvocationExecutor                     (4B)
Who owns result processing?               ToolResultPipeline                         (4B)
Who owns terminal settlement?             ToolSettlementCoordinator
Who defines durable Tool store contract?  @caelush/agent
Who implements durable persistence?       @caelush/storage
Who owns Run lifecycle?                   RunController
```

`DurableToolExecutionCoordinator` writes no `Run.status`, imports no Core, and names no `AgentRun`. The
Phase 4C guard asserts both.

---

## 8. Canonical declarations, exactly once

```text
ToolExecutionStorePort / Snapshot / Commit / CommitResult   @caelush/agent, one declaration each
ToolSecurityContext                                          @caelush/agent
AgentBudgetBlock                                             @caelush/agent; Core re-exports it
ToolAdmissionPort / ToolBudgetAdmissionPort                  @caelush/agent
ToolAdmissionCoordinator / ToolAdmissionOutcome              @caelush/agent
ToolSettlementCoordinator / DurableToolExecutionCoordinator   @caelush/agent
the invocation transition table                              @caelush/agent
createToolObservation / assertToolObservationInvariant       @caelush/agent
ToolExecutionConflictError / ToolExecutionInvariantError     @caelush/agent, re-exported by tools
```

`error instanceof ToolExecutionConflictError` therefore works identically through either package.

---

## 9. Budget: no terminal crash gap

```text
REQUESTED
  ↓ budget.admit                     → RESERVED
RUNNING commit + budgetStart         → IN_FLIGHT        one transaction
terminal commit                      → SETTLED | CONSERVATIVE | RELEASED   one transaction
ToolBudgetAdmissionPort.settle(...)  → idempotent restatement
```

| Terminal state                            | Ledger entry   | Why                                                    |
| ----------------------------------------- | -------------- | ------------------------------------------------------ |
| `COMPLETED`, or a decided Tool failure    | `SETTLED`      | the handler reached its durable start and finished     |
| `FAILED` with `UNCERTAIN_SIDE_EFFECT`     | `CONSERVATIVE` | external work may have happened and cannot be measured |
| a refusal, a rejection, a pre-start abort | `RELEASED`     | the handler provably never started                     |
| no ledger entry                           | no-op          | this host enforces no Tool budget                      |

The frozen `ToolExecutionCommit` has no `budgetSettlement` field, and none was added: the store
recognises the invocation's own terminal state and finishes the matching entry in the same
transaction. `ToolBudgetAdmissionPort.settle(...)` remains callable and idempotent.

---

## 10. Recovery matrix

| Durable status         | What 4C does                                                                                           | Executor calls      |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| `REQUESTED`            | re-enters admission from current durable state                                                         | after allow         |
| `WAITING_APPROVAL`     | PENDING → wait; APPROVED → recompute key, verify stored key and scope, re-admit; other → safe `FAILED` | 0 or after approval |
| `RUNNING`              | `FAILED` + `executionDisposition = UNCERTAIN_SIDE_EFFECT` + safe observation                           | **0**               |
| `COMPLETED` / `FAILED` | returns the existing observation; no second observation, no second terminal event                      | 0                   |
| `CANCELLED`            | returns `CANCELLED`; never executes; no new transition into it                                         | 0                   |

---

## 11. Failure semantics matrix

| Situation                               | Durable result                                                    | Boundary          |
| --------------------------------------- | ----------------------------------------------------------------- | ----------------- |
| policy `DENY`                           | `FAILED` + `PERMISSION_DENIED` + safe observation + `tool.failed` | `SETTLED`         |
| failure-memory block                    | `FAILED` + `TOOL_EXECUTION_ERROR` + safe observation              | `SETTLED`         |
| approval rejected / expired / cancelled | `FAILED` + `APPROVAL_REJECTED` + safe observation                 | `SETTLED`         |
| budget exceeded                         | `FAILED` + `BUDGET_EXCEEDED` + safe observation                   | `BUDGET_EXCEEDED` |
| Tool returns `isError: true`            | `FAILED` + observation                                            | `SETTLED`         |
| Tool returns success                    | `COMPLETED` + observation                                         | `SETTLED`         |
| `ToolExecutionUncertainError`           | `FAILED` + `UNCERTAIN_SIDE_EFFECT` + safe warning                 | `SETTLED`         |
| unexpected handler throw                | `FAILED` + `RUNTIME_ERROR`, then throw                            | `EXECUTION`       |
| `ToolResultValidationError`             | `FAILED` + `TOOL_OUTPUT_ERROR`, then throw                        | `RESULT_PIPELINE` |
| sanitizer / extension projector throws  | no successful settlement; invocation stays `RUNNING`              | `RESULT_PIPELINE` |
| settlement commit / effect decode fails | nothing committed                                                 | `SETTLEMENT`      |
| admission port throws                   | nothing committed                                                 | `ADMISSION`       |
| recovery invariant broken               | nothing committed                                                 | `RECOVERY`        |

No `catch (error) { return isError: true }` exists on any of these paths.

---

## 12. ToolDispatcher: what it lost and what it kept

Removed from the facade — it no longer exists there:

```text
create REQUESTED          applyGate               createApprovalRequest
approval grant check      budget admit/start/settle lifecycle
RUNNING transition        terminal transition     ToolObservation creation
durable Tool events       settlement commit       RUNNING recovery
WAITING_APPROVAL recovery activeCalls set         legacyEffectsFromSettlement
```

Retained, and translated:

```text
legacy ToolDispatchRequest validation
the canonical Preparer call
the historical invalid-argument durable failure      ← the Phase 4A difference, exit round 4D
UNAVAILABLE_TOOL outcome mapping
PREFLIGHT / GATE / EXECUTION debug diagnostics
canonical outcome → ToolDispatcherOutcome translation
canonical error → ToolDispatcherInfrastructureError translation
budget preflight for the legacy batch
```

The failure memory is no longer consulted in front of the durable path: it is an injected
`ToolAdmissionPreCheck`, and its refusal settles through the one canonical failure settlement. The
facade only _records_ a model-recoverable failure.

---

## 13. Phase 4D, 4E and 4F are not started

```text
4D  not started   the batch coordinator, batch outcomes, model feedback, the production ToolTurn
                  rewiring and the pre-invocation rejection no-row cutover are all untouched
4E  not started   the nine builtins, their Operations ports, the Runtime adapters and the Coding
                  metadata/effects/presentation/prompt parents have not moved
4F  not started   packages/tools exists, protocol.ToolDefinition exists, every compatibility export
                  remains, and no legacy production dependency was deleted
```

---

## 14. Architecture baseline

```text
                                  before 4C    after 4C
baseline entries                       31          27
legacy violations frozen               31          27
new violations                          0           0
stale baseline entries                  0           0
private subpath imports                 0           0
cross-project relative imports          0           0
readiness                          READY       READY
```

Four entries were retired in this unit, and they are the four `STORAGE_MUST_NOT_DEPEND_ON_TOOLS`
source imports the migration removed:

```text
packages/storage/src/tool-execution-store.ts
packages/storage/src/run-budget-port.ts
packages/storage/src/repositories/approval-repository.ts
packages/storage/src/storage.ts
```

The baseline was shrunk with the sanctioned writer
(`node scripts/architecture/check-boundaries.mjs --write-baseline`), whose own audit reported "no entry
would be added; the write can only remove entries". Its `baselineSourceCommit` and `generatedAt`
provenance fields were restored to the recorded Phase 1A expansion values, because those fields describe
the last audited **expansion**, not the last shrink. No rule was deleted and no exception was added.

`packages/storage/package.json` still declares `@caelush/tools`, and that manifest entry stays in the
baseline: the storage **test** suite imports the production effect projection through it, and Rule 7
retires a manifest edge only when its last import does. The package has no production source import of
the legacy Tool System left.

---

## 15. Tests

```text
new
  packages/agent/test/tool-admission-coordinator.test.ts            13 tests
  packages/agent/test/durable-tool-execution-coordinator.test.ts    24 tests
  packages/agent/test/tool-settlement-coordinator.test.ts           16 tests
  packages/storage/test/tool-settlement-atomicity.test.ts            8 tests
  tests/architecture/phase-4c-durable-tool-orchestration-boundaries.test.ts   18 tests

updated for the migrated contracts
  tests/architecture/phase-4b-tool-execution-result-boundaries.test.ts   restated for the 4C switch
  tests/architecture/phase-2c-model-authority-boundaries.test.ts         the Agent root export list
  tests/architecture/phase-3a-agent-kernel-boundaries.test.ts            the bounded host-vocabulary exception
  packages/storage/test/{tool-execution-store,read-only-filesystem-tools-integration,
                         run-controller-tool-integration}.test.ts        the decoder and the extension
  packages/tools/test/*                                                  the delegated facade
```

Assertions were **restated, never removed or weakened**. Where a 4B guard asserted a mechanism that 4C
moved to the canonical layer, it now asserts the new authority — and the 4C guard asserts the old
mechanism is gone. Two guards that counted files re-read the whole production tree per assertion and
were routed through one cache so their whole-repository checks fit the default timeout; the assertions
themselves are unchanged.

### 15.1 Failure injection covered

```text
admission port throw                   → ADMISSION infrastructure failure
admission port synchronous throw       → ADMISSION infrastructure failure
admission with no approval infra       → ADMISSION infrastructure failure
approval identity mismatch             → RECOVERY infrastructure failure
budget block                           → BUDGET_EXCEEDED, invocation durably FAILED
REQUESTED commit failure               → SETTLEMENT infrastructure failure
RUNNING commit failure                 → SETTLEMENT infrastructure failure
executor uncertain throw                → FAILED + UNCERTAIN_SIDE_EFFECT
executor unknown throw                  → RUNTIME_ERROR committed, then EXECUTION throw
settlement commit failure              → SETTLEMENT infrastructure failure, invocation stays RUNNING
unknown settlement extension            → rollback; database state unchanged
failing effects decoder                 → rollback
absent effects decoder                  → rollback
duplicate durable event                 → rollback
absent AgentState snapshot              → rollback
storage revision conflict               → ToolExecutionConflictError, unchanged
abort before the durable boundary       → no commit at all
same-process concurrent duplicate        → ToolCallBusyError, one execution
```

Every storage case asserts the **database's final state**, not merely that the promise rejected.

---

## 16. Divergences and corrections

Recorded in full in
[PHASE_4C_DURABLE_TOOL_ORCHESTRATION_ACCEPTANCE_MAP.md](PHASE_4C_DURABLE_TOOL_ORCHESTRATION_ACCEPTANCE_MAP.md)
§M. The two that changed the round's own work:

```text
M(f)  the admission adapter synthesized the gate's invocation with riskLevel "LOW" while passing the
      registered definition's real riskLevel. CaelushToolExecutionGate refuses that mismatch, so
      apply_patch, exec_command and write_stdin failed closed at admission instead of being
      policy-evaluated. Fixed in 4C by binding the real durable invocation through
      createDurableInvocationGatePort in both production compositions, and asserted.

M(h)  the AgentState revision assertion inside writeStateSnapshot compares against the revision it just
      read in the same transaction. It is a self-consistency guard, not a cross-writer one, and it is
      not reachable from outside on a single SQLite connection. Recorded honestly rather than presented
      as a concurrency guard; ToolExecutionCommit.expectedRevision is the settlement's real
      optimistic-concurrency check, and it is asserted separately.
```

The documentation-availability divergence is recorded at the map's §L.1: the two frozen Tool documents
are absent from this repository, so their frozen contracts were taken from the authorising prompt's
verbatim statements and no section number was invented.

---

## 17. Verification gates

See §18 of the delivered round note; every command below was run to completion on the delivered tree and
its real result is recorded.

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm check:architecture:ci
pnpm test
git diff --check
prettier --check <changed files>
```

`pnpm format:check` over the whole repository fails on the pre-existing CRLF condition recorded since
Phase 4A; no unrelated file was reformatted.

---

## 18. Remaining legacy responsibilities

| Responsibility                                  | Owner                                     | Exit round |
| ----------------------------------------------- | ----------------------------------------- | ---------- |
| `ToolPreflight` facade                          | `packages/tools/src/preflight.ts`         | 4D / 4F    |
| the historical argument-failure durable row     | `ToolDispatcher.persistArgumentFailure`   | 4D         |
| `ToolBatchCoordinator`                          | `packages/tools/src/batch-coordinator.ts` | 4D         |
| batch outcomes and model feedback               | `packages/tools/src/batch-types.ts`, Core | 4D         |
| production `ToolTurn` compatibility             | Core `run-tool-turn-coordinator.ts`       | 4D         |
| the nine Coding builtins                        | `packages/tools/src/builtins/**`          | 4E         |
| Coding facts and effects final ownership        | `packages/tools` compatibility adapters   | 4E         |
| Operations ports and Runtime adapters           | `packages/tools` + `packages/runtime`     | 4E         |
| `packages/tools` facade                         | the whole legacy package                  | 4F         |
| `protocol.ToolDefinition` retirement evaluation | `packages/protocol`                       | 4F         |

---

Phase 4C COMPLETE.
Phase 4D has not started.
