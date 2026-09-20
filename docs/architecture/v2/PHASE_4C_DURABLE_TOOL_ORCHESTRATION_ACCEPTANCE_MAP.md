# Caelush Architecture V2 — Phase 4C Durable Tool Orchestration Acceptance Map

```text
PHASE 4C — Admission, Approval & Budget Coordination, Durable Tool Orchestration and Storage Adaptation
base      53717d1e44afe3376e4a6a61b6ed3467cfc370e1   (Phase 4B tip)
branch    deepseek/architecture-v2-phase-4c-durable-tool-orchestration
```

This map is the per-clause record of what 4C implemented, where the authority now lives, what stays
legacy and which round takes the rest. It is written against the frozen Tool System V2 contracts as
they were frozen for this round and against the current Phase 4C source, and every clause names its
implementation.

It also records one **documentation-availability divergence** (§L): the two external specification
documents the 4A and 4B maps cite (`Caelush_Tool_System_V2_Refactor_Spec.md` and
`Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md`) are not present in this repository.
They were supplied as attachments in earlier rounds only. This map therefore never invents a
specification section number; it cites the in-repository authority for each frozen contract instead.

Nothing in this document asserts a completion-gate result. §Q is the gate list, and it is unclaimed.

---

## A. Frozen scope of 4C

```text
1   Admission            ToolSecurityContext, ToolDurableMetadataPort, ToolAdmissionPort,
                         ToolAdmissionPreCheck, ToolPolicyDecision, ToolAdmissionCoordinator
2   Approval             ToolApprovalLookupPort, ToolApprovalRequestFactory, the WAITING_APPROVAL
                         transition, and the durable ApprovalRequest created in that same commit
3   Tool budget          ToolBudgetAdmissionPort over one durable ledger, coordinated with the
                         RUNNING and terminal commits
4   ToolInvocation       the transition table, the lifecycle invariant, and the canonical
    lifecycle            create / start / wait / complete / fail factories
5   ToolObservation      the canonical observation factory and its invariant
    lifecycle
6   durable recovery     REQUESTED, WAITING_APPROVAL, RUNNING, terminal, CANCELLED
7   ToolExecutionStorePort   the canonical snapshot / idempotency lookup / atomic commit contract
8   ToolSettlementCoordinator   terminal invocation + observation + durable events + opaque effects
                                extension, through one atomic commit
9   DurableToolExecutionCoordinator   the Tool Invocation Lifecycle Authority
10  storage adaptation   @caelush/storage implements the canonical store port directly; the budget
                         start move and the terminal budget settlement happen inside the Tool commit
11  Coding effects       the projector into an opaque ToolSettlementExtension and the injected
    compatibility bridge decoder back into the existing ToolEffect[] projection
```

Plus the composition work that makes the canonical coordinator the object production actually drives,
and the delegation that removes every one of those responsibilities from the legacy shell.

The round result, stated once:

```text
@caelush/agent now owns   admission, approval and budget coordination, the ToolInvocation and
                          ToolObservation lifecycles, the durable store contract, failure settlement,
                          terminal settlement, recovery and the coordinator that drives them.

@caelush/storage now       implements ToolExecutionStorePort directly and performs the budget
                           transitions and the effects projection inside the invocation's own
                           SQLite transaction.

@caelush/tools still owns  request validation, the Phase 4A argument-failure row, the batch
                           coordinator, the nine builtins and the Coding effect vocabulary. Those
                           exit in 4D / 4E / 4F.
```

---

## B. Explicit non-goals

```text
4D   the batch coordinator rewrite, ToolResultBatchNormalizer, ModelToolFeedbackProjector, the
     production ToolTurn rewiring, and the pre-invocation rejection no-row cutover
4E   the nine Coding builtins, Operations ports, Runtime adapters, Coding effects / presentation /
     prompt ownership
4F   deleting packages/tools or protocol.ToolDefinition, final daemon cleanup, declaring Tool V2 done
```

Also out of scope, in the same words the round plan uses:

```text
no new DB table and no new migration
no new Protocol version, Run status or ToolInvocation status
no real parallel Tool execution (PARALLEL_SAFE stays a declaration)
no `terminate: true`; a Tool never ends a Run
no MCP, Skills, Browser, Web Search, Computer Use, Multi-Agent or remote Runtime
no OS sandbox redesign, no secret-redaction redesign, no Run-budget migration
```

The Phase 4A transition difference is still **not** fixed here. The canonical Preparer rejects an
invalid or unavailable pre-invocation call without creating a ToolInvocation; the legacy production
shell still persists its historical argument failure. Switching that is a 4D acceptance item, and §M(b)
records it as a retained divergence.

---

## C. Current Dispatcher durable responsibilities before 4C

Read from the base SHA. The 4B round had already made the shell _call_ the canonical executor and the
canonical result pipeline; what remained with the shell was the entire durable lifecycle around them.

```text
ToolDispatcher.dispatch / recoverOrDispatch
  └─ ToolPreflight (legacy facade)                        resolve + normalize + validate
       └─ ToolDispatcher.dispatchLocked
            ├─ failureMemory.has → persistFailureMemoryBlock        FAILED + observation + event
            ├─ createRequestedToolInvocation + commitAndNotify       REQUESTED, tool.requested
            ├─ applyGate                                            security facts + Gate
            │    ├─ computeToolApprovalKey
            │    ├─ findApplicableRunGrant → startAndExecute
            │    ├─ REQUIRE_APPROVAL → createApprovalRequest → WAITING_APPROVAL + approval.requested
            │    └─ DENY → persistFailure
            └─ startAndExecute
                 ├─ budget.admit → persistFailure(BUDGET_EXCEEDED)
                 ├─ startToolInvocation + commitAndNotify            RUNNING, tool.started, budgetStart
                 ├─ budget.start
                 └─ executeHandler
                      ├─ ToolInvocationExecutor.execute               (Phase 4B, delegated)
                      ├─ rawOutputStore.createOrGet                  full pre-projection output
                      ├─ ToolResultPipeline.process                   (Phase 4B, delegated)
                      ├─ legacyEffectsFromSettlement → ToolEffect[]   Coding vocabulary, in the shell
                      ├─ complete|failToolInvocation
                      ├─ createToolObservation
                      ├─ createToolCompleted|FailedEvent (+ tool.output)
                      ├─ budget.settle
                      └─ commitAndNotify(effects, effectTimestamp)    the lifecycle authority, legacy
recover / recoverLocked
  ├─ assertSameCall                                              identity conflict detection
  ├─ WAITING_APPROVAL → recoverWaitingApproval → createApprovalRequest
  ├─ RUNNING          → failInterrupted                          FAILED / UNCERTAIN_SIDE_EFFECT
  └─ COMPLETED|FAILED → return the existing observation
persistArgumentFailure / persistFailureMemoryBlock / persistFailure / persistFatalFailure
  └─ createRequestedToolInvocation → terminal status → observation + tool.failed
       ↑ four separate shell paths, all writing a durable lifecycle by hand
```

The failure writers at the bottom are the reason the migration was load-bearing rather than cosmetic.
In the base-SHA shell, a durable invocation was created in three places and a durable observation in
three places, and only one pair of them belonged to the "real" execution path. Every one of those
paths had to keep its observable behaviour while losing its authority.

## D. Target `@caelush/agent` ownership

```text
packages/agent/src/tools/admission/
  security-context.ts          ToolSecurityContext + its exact-shape assertion
  durable-metadata-port.ts     ToolDurableMetadata + ToolDurableMetadataPort (§M(d))
  admission-decision.ts        ToolAdmissionRequest, ToolApprovalRequirement, ToolPolicyDecision
  admission-port.ts            ToolAdmissionPort + ToolAdmissionPreCheck
  approval-port.ts             ToolApprovalLookupPort + ToolApprovalRequestFactory
  budget-port.ts               ToolBudgetAdmissionPort + UNBOUNDED_TOOL_BUDGET_ADMISSION
  admission-coordinator.ts     ToolAdmissionCoordinator + ToolAdmissionOutcome

packages/agent/src/tools/durable/
  invocation-lifecycle.ts      the one transition table, the invariant, the five factories
  observation.ts               createToolObservation + assertToolObservationInvariant
  durable-events.ts            the six durable Tool event factories + approval.resolved
  durable-errors.ts            ToolExecutionConflictError + ToolExecutionInvariantError
  execution-store-port.ts      ToolExecutionSnapshot / Commit / CommitResult / StorePort
  failure-settlement.ts        the bounded durable failure settlement + the durable code list
  settlement-coordinator.ts    ToolSettlementCoordinator
  durable-execution-coordinator.ts   DurableToolExecutionCoordinator (+ ToolCallBusyError,
                                     ToolExecutionAbortedError)
```

What the Agent layer still does not own, and must not learn:

```text
the policy algorithm            Security / Coding: CaelushToolExecutionGate
the approval card's presentation  Security / Coding: ToolApprovalRequestFactory implementation
the approval key algorithm      packages/tools: computeToolApprovalKey
the budget ledger               @caelush/storage: SqliteRunBudgetPort over run_budget_entries
SQLite, Drizzle, transactions   @caelush/storage
AgentState and ToolEffect[]     the host: the injected projection and decoder
risk levels, capabilities       the Coding overlay, reached through ToolDurableMetadataPort
```

---

## E. Durable responsibility inventory: before 4C → after 4C

Legend: **exit round** is the round that removes the compatibility bridge, not the round that removes
the responsibility. A `—` in that column means the row is a permanent boundary rather than a bridge.

| #   | Responsibility                     | Before 4C owner                                                                                        | After 4C owner                                                                                | Compatibility bridge                                                        | Bridge exit round |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------- |
| 1   | create `REQUESTED`                 | `ToolDispatcher.dispatchLocked` via the legacy `invocation-lifecycle.ts`                               | `DurableToolExecutionCoordinator.execute` via `durable/invocation-lifecycle.ts`               | legacy module re-exports the canonical factories                            | 4F                |
| 2   | commit `REQUESTED`                 | `ToolDispatcher.commitAndNotify` → legacy store contract                                               | coordinator `commitAndNotify` → canonical `ToolExecutionStorePort`                            | `toLegacyToolExecutionStore` for a pre-4C store                             | 4F                |
| 3   | policy admission (`applyGate`)     | `ToolDispatcher.applyGate` + `projectSecurityFacts`                                                    | `ToolAdmissionCoordinator.admit` → `ToolAdmissionPort`                                        | `createCodingToolAdmissionPort` over the real gate                          | 4E / 4F           |
| 4   | approval grant check               | inside `applyGate`: `findApplicableRunGrant`                                                           | `ToolAdmissionCoordinator.admit`, step ③                                                      | `toCanonicalApprovalLookup`                                                 | 4F                |
| 5   | approval key computation           | `applyGate` called `computeToolApprovalKey`                                                            | the Security/Coding admission adapter computes it; the Agent layer sees an opaque key         | `computeToolApprovalKey` remains in `packages/tools/src/approval-key.ts`    | 4E                |
| 6   | `ApprovalRequest` creation         | `ToolDispatcher.createApprovalRequest`                                                                 | `ToolApprovalRequestFactory` injected into the admission coordinator                          | facade `genericApprovalRequests()` fallback; production uses the V1 factory | 4E                |
| 7   | Tool budget reserve / `admit`      | `ToolDispatcher.startAndExecute` → legacy `admit` (`ALLOWED`/`EXCEEDED`)                               | `ToolAdmissionCoordinator` → `ToolBudgetAdmissionPort.admit`                                  | `toCanonicalToolBudgetPort` + `createSqliteToolBudgetAdmission`             | 4D / 4F           |
| 8   | budget `IN_FLIGHT` mark            | `budgetStart` on the RUNNING commit, then `budget.start()`                                             | the same atomic store move, driven by the coordinator                                         | `ToolBudgetAdmissionPort.start`, an idempotent restatement                  | 4F                |
| 9   | budget settle                      | `executeHandler` called `budget.settle` after the terminal commit                                      | `SqliteToolExecutionStore.settleBudgetInTransaction` inside that commit; coordinator restates | `ToolBudgetAdmissionPort.settle`, an idempotent restatement                 | 4F                |
| 10  | `RUNNING` transition               | `ToolDispatcher.startAndExecute`                                                                       | coordinator `startAndExecute`                                                                 | legacy factory re-export                                                    | 4F                |
| 11  | invoking `ToolInvocationExecutor`  | `ToolDispatcher.executeHandler`                                                                        | coordinator `executeAndSettle`                                                                | `createToolExecutionDependencies` still binds the 4B pair                   | 4E / 4F           |
| 12  | invoking `ToolResultPipeline`      | `ToolDispatcher.executeHandler`                                                                        | coordinator `executeAndSettle`                                                                | as row 11                                                                   | 4E / 4F           |
| 13  | terminal `ToolInvocation` creation | `executeHandler`, `persistArgumentFailure`, `persistFailure`, `persistFatalFailure`, `failInterrupted` | `ToolSettlementCoordinator.settle` + `ToolFailureSettlement.settleFailure`                    | one legacy caller remains: `ToolDispatcher.persistArgumentFailure`          | 4D                |
| 14  | `ToolObservation` creation         | the same five shell sites                                                                              | `ToolSettlementCoordinator` + `createToolFailureSettlement`                                   | as row 13                                                                   | 4D                |
| 15  | `ToolSettlementExtension` decode   | `ToolDispatcher.legacyEffectsFromSettlement` in the shell                                              | `SqliteToolExecutionStore.decodeExtension` + the injected host decoder                        | `createLegacyToolSettlementExtensionDecoder` in `apps/daemon/src/daemon.ts` | 4E                |
| 16  | applying `ToolEffect[]`            | the shell decoded, then passed `effects`/`effectTimestamp` to `commit`                                 | storage decodes the opaque `extension` and projects it in the same transaction                | `toCanonicalCommit` for a legacy-shaped commit                              | 4E                |
| 17  | `AgentState` mutation              | `SqliteToolExecutionStore` through `writeStateSnapshot`                                                | **unchanged** — the same store and the same snapshot writer                                   | the host injects `applyToolEffectsToAgentState`                             | 4E                |
| 18  | `RUNNING` recovery                 | `ToolDispatcher.recoverLocked` → `failInterrupted`                                                     | coordinator `recoverSnapshot` → `settleDurableFailure` (`UNCERTAIN_SIDE_EFFECT`)              | —                                                                           | —                 |
| 19  | `WAITING_APPROVAL` recovery        | `ToolDispatcher.recoverWaitingApproval` + `createApprovalRequest`                                      | coordinator `recoverWaitingApproval`, with the stored key read through the port               | `toCanonicalApprovalLookup`; storage keeps both spellings                   | 4F                |
| 20  | terminal recovery                  | `recoverLocked` returned the existing observation                                                      | coordinator `recoverSnapshot` returns it and adds no second event                             | the facade translates the canonical outcome                                 | 4F                |
| 21  | durable event creation             | `packages/tools/src/event-factory.ts`                                                                  | `agent/tools/durable/durable-events.ts`                                                       | re-export facade                                                            | 4F                |
| 22  | durable event notification         | `ToolDispatcher.commitAndNotify`                                                                       | coordinator, failure settlement and settlement coordinator, always after the commit           | the facade passes the host `notifier` through                               | 4F                |

Two rows deserve an explicit statement because they are easy to misread as "still legacy":

```text
row 17  AgentState is a HOST projection. Moving it into @caelush/agent would put a Coding state model
        into the general kernel, so storage continues to own the write and the host continues to own
        the projection function. What changed in 4C is only WHO decodes the extension, and the answer
        is the transaction that applies it.

row 22  Notification order is an invariant, not an implementation detail: durable commit first,
        subscriber second. It held before 4C and it holds after it, in three call sites instead of one.
```

---

## F. Storage adaptation map

`@caelush/storage` now implements the canonical contract directly. Every import of a Tool lifecycle
type in this list resolves to `@caelush/agent`, not to `@caelush/tools`.

| File                                                        | Responsibility                                                                                                                                                           | Canonical contract it now serves                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/storage/src/tool-execution-store.ts`              | `SqliteToolExecutionStore`: `load`, `findByExternalCall`, one `BEGIN IMMEDIATE` commit; revision guard; Run/Step precondition; invocation, observation, approval, events | implements `ToolExecutionStorePort` from `@caelush/agent`           |
| same                                                        | `startBudgetInTransaction`: `RESERVED → IN_FLIGHT` for `TOOL_INVOCATION`, inside the `RUNNING` commit                                                                    | `ToolExecutionCommit.budgetStart`, an Agent-layer data hint         |
| same                                                        | `settleBudgetInTransaction`: `IN_FLIGHT → SETTLED`/`CONSERVATIVE`, `RESERVED → RELEASED`, inside the terminal commit                                                     | the terminal half of `ToolBudgetAdmissionPort` (§H)                 |
| same                                                        | `decodeExtension`: decode before the transaction opens; absent decoder with a present extension is refused                                                               | `ToolExecutionCommit.extension` (`ToolSettlementExtension`)         |
| same                                                        | `mapStoreError`: conflict, invariant, duplicate-event and settlement-extension failures keep their classes                                                               | `ToolExecutionConflictError`, `ToolExecutionInvariantError`         |
| `packages/storage/src/tool-settlement-extension-adapter.ts` | `ToolSettlementExtensionDecoder`, `HostToolEffectsPort`, `createHostToolEffectsDecoder`, `createCodingToolEffectsDecoder`, `ToolSettlementExtensionError`                | the injected decoder boundary the store consumes                    |
| `packages/storage/src/run-budget-port.ts`                   | `SqliteRunBudgetPort` (legacy Tool budget + the whole Run budget) and `createSqliteToolBudgetAdmission`                                                                  | implements `RunBudgetPort`; exposes `ToolBudgetAdmissionPort`       |
| `packages/storage/src/repositories/approval-repository.ts`  | `SqliteApprovalRepository`: the three admission questions plus resolution, lazy expiry, listing, cancellation; `writeApprovalInTransaction`                              | implements `ToolApprovalLookupPort`; keeps its own workflow surface |
| `packages/storage/src/storage.ts`                           | `openCaelushStorage` composes the store, injects `toolSettlementExtension`, and publishes `toolExecution` as the canonical port                                          | `ToolExecutionStorePort` from `@caelush/agent`                      |

The interface change that makes this real:

```text
before  packages/storage/src/storage.ts   import type { ToolExecutionStorePort } from "@caelush/tools"
after   packages/storage/src/storage.ts   import type { ToolExecutionStorePort } from "@caelush/agent"
```

No table, column, index or migration changed in this round. `packages/storage/drizzle` is untouched:
the newest committed migration remains `20260904130000_context_runtime_telemetry`.

---

## G. Security / Approval compatibility map

```text
Security / Coding vocabulary                                  Agent vocabulary
─────────────────────────────────────────────────────────     ────────────────────────────────
CaelushToolExecutionGate (ToolExecutionGatePort)              ToolAdmissionPort
riskLevel, requiredCapabilities, runtimeRequirements          injected catalog metadata
security facts projection                                     a host-private projector
the SHA-256 approval key algorithm                            an opaque requirement `key`
ToolExecutionGateDecision                                     ToolPolicyDecision
ToolApprovalStorePort (getApprovalKeyByInvocation)             ToolApprovalLookupPort
```

| Item                               | Before 4C                                                  | After 4C                                                                                                  | Bridge                                                             | Exit round      |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------- |
| `ToolSecurityContext` declaration  | `packages/tools/src/security-context.ts`                   | `agent/tools/admission/security-context.ts`                                                               | re-export facade; the throw type is now `ToolSecurityContextError` | 4F              |
| policy evaluation                  | `ToolDispatcher.applyGate` called the gate directly        | `createCodingToolAdmissionPort` implements `ToolAdmissionPort` over the gate                              | `packages/tools/src/tool-admission-adapter.ts`                     | 4E / 4F         |
| security facts projection          | `ToolDispatcher.projectSecurityFacts`                      | the adapter's own projector; a throwing projector yields `opaqueInput: true` and the input policy refuses | same adapter                                                       | 4E              |
| durable `riskLevel` source         | `resolvedTool.definition.riskLevel` at invocation creation | `ToolDurableMetadataPort` (`createCodingToolDurableMetadataPort`)                                         | `durable-metadata-port.ts` is the seam; §M(d)                      | 4F (evaluation) |
| approval key                       | `applyGate` computed it inline                             | the adapter computes it; the Agent layer compares the opaque string only                                  | `computeToolApprovalKey` stays in `packages/tools`                 | 4E              |
| approval card                      | `ToolDispatcher.createApprovalRequest` built the row       | `createV1ToolApprovalRequestFactory` (production) or the facade's generic factory                         | `ToolApprovalRequestFactory` injection point                       | 4E              |
| approval grant lookup              | `approvalStore.findApplicableRunGrant` in the shell        | `ToolAdmissionCoordinator`, step ③, through `ToolApprovalLookupPort`                                      | `toCanonicalApprovalLookup`                                        | 4F              |
| stored approval identity           | `getApprovalKeyByInvocation` (legacy spelling)             | `getStoredApprovalKey` (canonical spelling); one query, both names answer it                              | `SqliteApprovalRepository` implements both                         | 4F              |
| `WAITING_APPROVAL` transition      | `markToolInvocationWaitingApproval` in the shell           | `markToolInvocationWaitingApproval` in the coordinator                                                    | re-export facade                                                   | 4F              |
| approval + invocation atomicity    | one shell commit carrying invocation + approval + key      | one coordinator commit via `ToolExecutionCommit.{approval, approvalKey}`                                  | unchanged: the store refuses an approval without a key             | —               |
| resolution / expiry / cancellation | storage repository                                         | storage repository, unchanged                                                                             | not widened into the admission port                                | —               |

The gate's own contract is untouched: it still receives an invocation, a definition metadata object,
the security context, the runtime kind and optional security facts, and it still returns
`ALLOW` / `DENY` / `REQUIRE_APPROVAL`. What moved is the caller. §M(f) records the one place where the
adapter's synthesized invocation shape does not satisfy that contract.

---

## H. Budget compatibility map

```text
one ledger, two vocabularies

legacy    SqliteRunBudgetPort.admit({ runId, requested, invocationId })   → ALLOWED | EXCEEDED
          SqliteRunBudgetPort.admitBatch({ runId, requested })            → ALLOWED | EXCEEDED
          SqliteRunBudgetPort.start({ runId, invocationId })              → void, idempotent
          SqliteRunBudgetPort.settle({ runId, invocationId })             → void, idempotent
canonical createSqliteToolBudgetAdmission(budget) → ToolBudgetAdmissionPort
          preflight(runId, requests)   → AgentBudgetBlock | null          no write
          admit({ runId, invocationId, toolName }) → AgentBudgetBlock | null
          start({ runId, invocationId, startedAt })  → idempotent restatement
          settle({ runId, invocationId, status, finishedAt }) → idempotent restatement
```

`SqliteRunBudgetPort` therefore keeps the legacy shapes **and** exposes the canonical view, over one
ledger and one implementation of each transition. The two views are two entry points rather than one
overloaded method because the questions genuinely differ: the legacy one takes a requested count and
answers `ALLOWED`/`EXCEEDED`, the canonical one names the Tool and answers `AgentBudgetBlock | null`.
The canonical view reserves exactly one Tool call — `requested: 1` is a constant, not a parameter.

### H.1 Why `start` and `settle` are restatements

The production store already moves the matching `TOOL_INVOCATION` ledger entry **inside** the durable
Tool commit:

```text
RUNNING commit      tool_invocations → RUNNING
                    + run_budget_entries: RESERVED → IN_FLIGHT          startBudgetInTransaction
                    one SQLite transaction

terminal commit     tool_invocations → COMPLETED | FAILED | CANCELLED
                    + run_budget_entries: IN_FLIGHT → SETTLED | CONSERVATIVE
                                          RESERVED  → RELEASED            settleBudgetInTransaction
                    one SQLite transaction
```

The canonical port's `start` and `settle` remain callable and required, because the frozen
`ToolExecutionCommit` has no settlement field and a host that commits without an atomic budget
transition still has to be able to settle. On the production path each call is a no-op: an entry that
is already `IN_FLIGHT`, `SETTLED`, `CONSERVATIVE` or `RELEASED` is left exactly as it is. The Agent
layer never learns that a ledger exists; it passes `budgetStart` as a data hint and calls the port.

### H.2 Terminal-state mapping

```text
IN_FLIGHT → SETTLED        a Tool that reached a final answer
IN_FLIGHT → CONSERVATIVE   executionDisposition = UNCERTAIN_SIDE_EFFECT on the durable error
RESERVED  → RELEASED       a handler that provably never started — policy denial, approval
                           rejection, budget block, pre-execution abort
absent                     this host enforces no Tool budget: a no-op, not an error
already terminal           idempotent no-op
```

The uncertainty answer is read from **durable data** (`invocation.error.details.executionDisposition`),
never from an in-memory flag, so recovery re-settling the same row reaches the same budget conclusion.
A conservative entry is not a settled one: an execution whose external work cannot be measured is real
consumption, and settling it as a clean completion would understate what the Run used and would
disagree with what Run budget recovery concludes about the same row.

### H.3 The gap this closes

Before 4C the terminal commit and the budget settlement were two calls. A crash between them left a
terminal Tool invocation beside an `IN_FLIGHT` reservation, which budget recovery then had to guess
about. 4C removes the gap rather than narrowing it: the two facts settle together, and the later
`settle` call is a statement of something already durable.

---

## I. Effects atomic compatibility map

```text
ToolResultPipeline.process(...)
  └── PreparedToolSettlement { result, effects?: ToolSettlementExtension }
        kind = "caelush.coding.effects.v1"        opaque to the Agent layer
        └── ToolSettlementCoordinator.settle()
              └── ToolExecutionCommit.extension
                    └── ToolExecutionStorePort.commit()
                          └── SqliteToolExecutionStore.commit()
                                ├── decodeExtension(extension)        BEFORE BEGIN IMMEDIATE
                                │     └── the injected decoder
                                │           └── legacy ToolEffect[]
                                ├── BEGIN IMMEDIATE
                                ├── invocation + observation + approval + events + budget move
                                ├── hostEffects.changeState ? applyToolEffectsToAgentState(state, now)
                                │     └── writeStateSnapshot(...)      same revision guard
                                └── COMMIT
```

The chain is one transaction end to end. What changed in 4C is only where the decode happens:

```text
before  the shell decoded `settlement.effects` into ToolEffect[] and passed `effects` and
        `effectTimestamp` to commit; the store never saw an extension
after   the store receives the opaque extension and decodes it immediately before the transaction,
        so the layer that consumes the effects is the layer that reads them
```

Injected wiring, in the production daemon:

```text
apps/daemon/src/daemon.ts
  openCaelushStorage({
    toolSettlementExtension: createLegacyToolSettlementExtensionDecoder({
      effects: toHostToolEffectsPort({
        changesState: effectsChangeAgentState,
        apply: applyToolEffectsToAgentState,
      }),
    }),
  })
```

`@caelush/storage` takes the decoder as a constructor dependency rather than importing it, because the
Coding effect vocabulary lives in the legacy Tool System and storage may not depend on it. The
projection itself is the pre-4C implementation, unchanged; only the caller moved.

Failure semantics:

```text
absent extension                no host projection: nothing to apply
extension, no decoder           refused — never ignored
unknown extension kind          decoder throws → transaction rolls back → the invocation keeps the
                                state it had
payload that is not an array    the same
AgentState snapshot missing     ToolExecutionInvariantError, rollback
AgentState revision moved       ToolExecutionConflictError, rollback
```

The governing rule is stated in the store and repeated here because it is the reason an unknown kind
must not be swallowed: **a Tool is never recorded `COMPLETED` while the effects it had are
unaccounted for.** A decode failure surfaces as `ToolExecutionInvariantError` (not a retryable
conflict), because re-running the same commit would fail the same way.

---

## J. Recovery matrix

`DurableToolExecutionCoordinator.recover(snapshot, { environment, securityContext, signal })` is the
only restart-aware entry point for one Tool call. `ToolDispatcher.recoverOrDispatch` delegates to it,
so the legacy name and the canonical method describe one authority.

| Durable status on entry                                                        | What recovery does                                                                                                                                | Handler invocations | Durable effect                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `REQUESTED`                                                                    | re-enters admission: policy → approval → budget, all against current durable Run policy                                                           | possibly one        | `RUNNING` then settlement, or `FAILED`, or `WAITING_APPROVAL`                          |
| `WAITING_APPROVAL`, approval `PENDING`                                         | returns `WAITING_APPROVAL`; the Run layer owns what happens next                                                                                  | 0                   | none                                                                                   |
| `WAITING_APPROVAL`, approval `APPROVED`, recomputed key matches the stored key | re-enters admission, then requires a granted scope, then starts and executes                                                                      | one                 | `RUNNING` then settlement                                                              |
| `WAITING_APPROVAL`, approval `APPROVED`, recomputed key differs                | fails closed at the RECOVERY boundary, before any budget side effect                                                                              | 0                   | `ToolExecutionInfrastructureError` (RECOVERY); invocation untouched                    |
| `WAITING_APPROVAL`, approval `REJECTED` / `EXPIRED` / `CANCELLED`              | settles a safe, non-retryable `APPROVAL_REJECTED` failure                                                                                         | 0                   | `FAILED` + observation + `tool.failed`                                                 |
| `RUNNING`                                                                      | never re-executes: an interrupted Tool may have partially or fully run, so the only safe statement is an uncertain one, `executor call count = 0` | 0                   | `FAILED` + observation + `tool.failed`, `executionDisposition = UNCERTAIN_SIDE_EFFECT` |
| `COMPLETED` / `FAILED`                                                         | returns the existing observation; the durable answer is never recomputed and no second event is written                                           | 0                   | none                                                                                   |
| `CANCELLED`                                                                    | returns `CANCELLED` with the observation if one exists; never executes and adds no new transition                                                 | 0                   | none                                                                                   |

Boundary conditions that fail closed instead of guessing:

```text
terminal invocation with no observation            RECOVERY infrastructure failure (except CANCELLED)
WAITING_APPROVAL with no ApprovalRequest           RECOVERY infrastructure failure
APPROVED without a granted scope                   RECOVERY infrastructure failure
invocation with no externalCallId                  RECOVERY infrastructure failure
stored approval identity unreadable                RECOVERY infrastructure failure
same call already in flight in this process        ToolCallBusyError, a race guard only
aborted signal on entry                            ToolExecutionAbortedError
```

The same-process `activeCalls` set is explicitly **not** a correctness mechanism: correctness comes from
the durable idempotency lookup on `(runId, sourceStepId, externalCallId)`, the revision check and the
store's conflict on a duplicate external call. The set only stops two concurrent in-process callers
from both reaching the store for the same identity.

---

## K. Error matrix

### K.1 `ToolExecutionInfrastructureError.phase` taxonomy

Six phases, and each one names the conditions that map to it:

| Phase             | Conditions that map here                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PREPARATION`     | empty `externalCallId`; a call that reached execution without a resolved Tool; the Preparer's own `ToolPreparationInfrastructureError` (Phase 4A)                                                                                                                                                                                           |
| `ADMISSION`       | the policy port throws (including a synchronous throw); a gate that cannot answer; missing approval infrastructure; an approval factory that returns `null`; `ToolBudgetAdmissionPort.admit` throws; the budget `start` restatement throws; `ToolDurableMetadataPort` cannot answer; admission was asked about a non-`REQUESTED` invocation |
| `EXECUTION`       | an unclassified `AgentTool.execute` throw, **after** its durable failure settlement                                                                                                                                                                                                                                                         |
| `RESULT_PIPELINE` | `ToolResultValidationError` (after its durable failure settlement); any other pipeline throw, which leaves the invocation `RUNNING` and invents nothing                                                                                                                                                                                     |
| `SETTLEMENT`      | store commit failure; budget `settle` failure; raw output archive failure; failure-settlement commit failure; a raw-artifact resolver that throws                                                                                                                                                                                           |
| `RECOVERY`        | the boundary conditions in §J: missing external call identity, missing approval, approval identity mismatch, missing granted scope, terminal invocation without an observation, unreadable stored approval identity                                                                                                                         |

### K.2 What settles durably as `FAILED`, and what throws

```text
durably FAILED (safe model-recoverable, one observation, one tool.failed)      code / phase
  policy DENY                                                                  PERMISSION_DENIED / SECURITY
  approval REJECTED | EXPIRED | CANCELLED                                      APPROVAL_REJECTED / SECURITY
  budget exceeded                                                              BUDGET_EXCEEDED / INTERNAL
  uncertain side effect                                                        TOOL_EXECUTION_ERROR / TOOL
  uncertain side effect reported by the executor                               TOOL_EXECUTION_ERROR / RUNTIME
  result contract violation                                                    TOOL_OUTPUT_ERROR / TOOL
  unclassified handler throw                                                   RUNTIME_ERROR / RUNTIME
  recovered RUNNING invocation                                                 TOOL_EXECUTION_ERROR / TOOL

durably FAILED first, then the boundary throws (the evidence must exist before the boundary fails)
  unclassified handler throw          → EXECUTION
  result contract violation           → RESULT_PIPELINE

throws without a settlement (no durable state is invented)
  admission evaluation failure        → ADMISSION
  approval identity mismatch          → RECOVERY
  result pipeline infrastructure      → RESULT_PIPELINE, invocation stays RUNNING
  store commit failure                → SETTLEMENT, invocation keeps the state it had
  raw archive or raw-artifact failure → SETTLEMENT, invocation stays RUNNING
  budget settle restatement failure   → SETTLEMENT, after the invocation is already terminal
  ToolExecutionConflictError          → propagates unchanged; only the caller knows if re-reading is safe
  ToolExecutionInvariantError         → propagates unchanged; a broken contract, never model feedback
```

Two rules make the table more than bookkeeping:

```text
1  an infrastructure failure is never disguised as an `isError: true` Tool result, because a model
   told "the tool failed" would retry a call whose durable truth is unknown
2  a feedback code outside DURABLE_FAILURE_CODES keeps its meaning inside the safe content the model
   reads, and the invocation records the generic TOOL_EXECUTION_ERROR; storing an unknown string in
   the Protocol's `code` field would put a value into durable storage that no consumer understands
```

---

## L. Frozen contract → implementation → evidence

### L.1 Documentation-availability divergence

```text
Caelush_Tool_System_V2_Refactor_Spec.md                     not present in this repository
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md not present in this repository
```

Both were supplied as attachments in earlier rounds. The 4A and 4B maps can cite `Freeze §75` … or
`Spec §38` because those attachments were available when they were written; this round had no such
attachment. The consequences, recorded rather than papered over:

```text
1  this document cites the in-repository authority for every contract instead of inventing a
   specification section number
2  the frozen 4C contracts are stated in the Phase 4C authorising prompt, and every interface in
   §A was implemented exactly as that prompt freezes it
3  where a clause number would be useful and no in-repository authority carries one, this map cites
   the implementing file
4  PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md §1.1 is the in-repository statement of what 4C may leave open,
   and §1.2 is the in-repository statement of what no Phase 4 round may do
5  MIGRATION_EXECUTION_CONTRACT.md rules 1–3, 5, 9 and 10 are the binding mechanics this round follows
6  the Phase 4C authorising prompt is not itself visibly numbered per contract, so a row that says
   "authorising prompt" means the frozen scope statement in it, and the implementing file named beside
   it is the citable artefact
```

### L.2 Contract map

Test evidence convention: no test in the tree constructs the canonical 4C modules directly (verified by
search). The canonical coordinator is currently exercised **indirectly** through the legacy dispatcher
suites — `packages/tools/test/dispatcher-{execution,approval,failure,recovery,idempotency,contracts,validation}.test.ts`,
`packages/tools/test/batch-coordinator.test.ts`, `packages/storage/test/tool-dispatcher-integration.test.ts`,
`packages/storage/test/run-controller-tool-integration.test.ts` — because the facade builds it from its
own options when no coordinator is injected. Every entry that needs a dedicated test says so.

| Frozen contract                                          | In-repository authority                                         | Implementation                                                                                                   | Test evidence                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ToolSecurityContext`                                    | round plan §1.1 "Security facts, admission, approval, budget"   | `agent/tools/admission/security-context.ts`                                                                      | not yet dedicated — see the report                                         |
| `ToolDurableMetadata` / `ToolDurableMetadataPort`        | §M(d); the service table above                                  | `agent/tools/admission/durable-metadata-port.ts`                                                                 | not yet dedicated — see the report                                         |
| `ToolAdmissionRequest` (five fields, closed)             | authorising prompt; §D of this map                              | `agent/tools/admission/admission-decision.ts`                                                                    | not yet dedicated — see the report                                         |
| `ToolPolicyDecision` (three arms, no infrastructure arm) | authorising prompt; §G of this map                              | `agent/tools/admission/admission-decision.ts`                                                                    | not yet dedicated — see the report                                         |
| `ToolAdmissionPort` / `ToolAdmissionPreCheck`            | authorising prompt; §M(c)                                       | `agent/tools/admission/admission-port.ts`                                                                        | not yet dedicated — see the report                                         |
| `ToolApprovalRequirement` (opaque key, safe reason)      | authorising prompt; §G of this map                              | `agent/tools/admission/admission-decision.ts`                                                                    | not yet dedicated — see the report                                         |
| `ToolApprovalLookupPort` (three questions)               | authorising prompt; §G of this map                              | `agent/tools/admission/approval-port.ts`                                                                         | not yet dedicated — see the report                                         |
| `ToolApprovalRequestFactory`                             | authorising prompt; §G of this map                              | `agent/tools/admission/approval-port.ts` + `packages/security/src/default-composition.ts`                        | not yet dedicated — see the report                                         |
| `ToolBudgetAdmissionPort` (preflight/admit/start/settle) | authorising prompt; §H of this map                              | `agent/tools/admission/budget-port.ts`                                                                           | not yet dedicated — see the report                                         |
| `ToolAdmissionCoordinator` / `ToolAdmissionOutcome`      | authorising prompt; ordering ①–④ in the module header           | `agent/tools/admission/admission-coordinator.ts`                                                                 | not yet dedicated — see the report                                         |
| `ToolInvocation` transition table                        | Protocol `ToolInvocationStatusSchema`                           | `agent/tools/durable/invocation-lifecycle.ts`                                                                    | `packages/tools/test/invocation-lifecycle.test.ts` through the facade      |
| `ToolInvocation` lifecycle invariant                     | authorising prompt; §J of this map                              | `agent/tools/durable/invocation-lifecycle.ts`                                                                    | `packages/storage/test/tool-execution-store.test.ts`                       |
| `ToolObservation` factory + invariant                    | authorising prompt; §J of this map                              | `agent/tools/durable/observation.ts`                                                                             | `packages/storage/test/tool-dispatcher-integration.test.ts`                |
| durable Tool event factories                             | authorising prompt; §E rows 21–22                               | `agent/tools/durable/durable-events.ts`                                                                          | `packages/tools/test/event-factory.test.ts` through the facade             |
| `ToolExecutionSnapshot` / `Commit` / `CommitResult`      | authorising prompt; §I of this map                              | `agent/tools/durable/execution-store-port.ts`                                                                    | not yet dedicated — see the report                                         |
| `ToolExecutionStorePort`                                 | authorising prompt; §F of this map                              | `agent/tools/durable/execution-store-port.ts` + `packages/storage/src/tool-execution-store.ts`                   | `packages/storage/test/tool-execution-store.test.ts`                       |
| `ToolExecutionConflictError` / `…InvariantError`         | `MIGRATION_EXECUTION_CONTRACT.md` rule 5 (identity preserved)   | `agent/tools/durable/durable-errors.ts` + re-export facades                                                      | `packages/tools/test/dispatcher-idempotency.test.ts`                       |
| durable failure settlement + `DURABLE_FAILURE_CODES`     | authorising prompt; §K.2 of this map                            | `agent/tools/durable/failure-settlement.ts`                                                                      | `packages/tools/test/dispatcher-failure.test.ts` through the facade        |
| `ToolSettlementCoordinator`                              | authorising prompt; §I of this map                              | `agent/tools/durable/settlement-coordinator.ts`                                                                  | `packages/storage/test/tool-dispatcher-integration.test.ts`                |
| `DurableToolExecutionCoordinator` (execute / recover)    | authorising prompt; §J of this map                              | `agent/tools/durable/durable-execution-coordinator.ts`                                                           | `packages/tools/test/dispatcher-recovery.test.ts`, `…-idempotency.test.ts` |
| `DurableToolExecutionOutcome` (four arms, closed)        | authorising prompt; §J of this map                              | `agent/tools/durable/durable-execution-coordinator.ts`                                                           | through the facade outcome translation only                                |
| `DurableToolExecutionRequest` (seven fields, closed)     | authorising prompt; §D of this map                              | `agent/tools/durable/durable-execution-coordinator.ts`                                                           | `packages/tools/test/tool-execution-delegation.test.ts`                    |
| atomic storage adaptation (budget + effects + events)    | `MIGRATION_EXECUTION_CONTRACT.md` rule 10 (behaviour preserved) | `packages/storage/src/tool-execution-store.ts`                                                                   | `packages/storage/test/tool-execution-store.test.ts`                       |
| effects extension bridge and decoder                     | authorising prompt; §I of this map                              | `packages/tools/src/settlement-extension-bridge.ts`, `packages/storage/src/tool-settlement-extension-adapter.ts` | `apps/daemon/test/tool-execution-result-composition.test.ts`               |
| no new table, column or migration                        | round plan §1.2                                                 | `packages/storage/drizzle` unchanged                                                                             | `packages/storage/test/tool-execution-store.test.ts`                       |
| no new ToolInvocation status; `CANCELLED` unreachable    | Protocol + §M(a)                                                | `agent/tools/durable/invocation-lifecycle.ts`                                                                    | not yet dedicated — see the report                                         |
| Phase 3 contracts unchanged                              | round plan §1.2                                                 | no Phase 3 file touched by 4C                                                                                    | Phase 3 guards; see the report                                             |
| Phase 4A / 4B invariants unchanged                       | §P of this map                                                  | no 4A/4B file re-implemented                                                                                     | Phase 4A and 4B guards; see the report                                     |

---

## M. Divergences between the frozen target and the current source

| #   | Frozen clause / contract                                                                                                                    | Current implementation                                                                                                                                                                                                                                                                                         | Divergence                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 4C treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Exit round                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| a   | Protocol v1 declares a `CANCELLED` ToolInvocation status                                                                                    | `invocation-lifecycle.ts` has no transition into it; recovery returns it as `CANCELLED` without executing                                                                                                                                                                                                      | no production transition enters `CANCELLED`. The status is declared and durable-invariant-legal, but nothing in Phase 4 creates one; the legacy facade cannot even express the outcome for an invocation with no observation (it throws a dispatcher infrastructure error)                                                                                                                                                                                                              | kept exactly as it is: 4C reads a `CANCELLED` invocation and refuses to execute it. It invents no cancellation policy the frozen Run cancellation invariants do not authorise                                                                                                                                                                                                                                                                                                                                                                                                                 | none in Phase 4                                                               |
| b   | the canonical Preparer rejects an invalid or unavailable pre-invocation call **without** creating a ToolInvocation                          | `ToolDispatcher.run` still calls `persistArgumentFailure`, which writes `REQUESTED → FAILED` with `TOOL_ARGUMENT_ERROR`, a bounded observation and one `tool.failed`                                                                                                                                           | the Phase 4A transition difference: the canonical semantics and the production semantics disagree for one call class                                                                                                                                                                                                                                                                                                                                                                    | retained deliberately, documented in the shell, and left as the only lifecycle-shaped code in the legacy facade                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 4D                                                                            |
| c   | a host short-circuit must not own a second durable failure path                                                                             | `createToolFailureMemoryPreCheck` returns `DENY` inside `ToolAdmissionCoordinator.admit`, before the policy port and before any budget side effect                                                                                                                                                             | before 4C the failure memory short-circuited **in front of** the shell's durable path and the shell then built a `FAILED` invocation, its own observation and its own event — a second failure settlement                                                                                                                                                                                                                                                                               | moved: the memory is now an injected `ToolAdmissionPreCheck`, and its refusal settles through the one canonical failure settlement. The shell no longer creates a `FAILED` invocation for anything except the argument row                                                                                                                                                                                                                                                                                                                                                                    | 4D (the shell's remaining path)                                               |
| d   | the general `AgentTool` contract carries no risk level                                                                                      | `ToolDurableMetadataPort` exists solely because Protocol v1 persists `riskLevel` on `ToolInvocation`; `createCodingToolDurableMetadataPort` answers it from the registered definition                                                                                                                          | a migration seam exists where the target model has no such field. It is not a business model: a host with no risk opinion must still state one durably, and a missing answer fails loudly rather than defaulting to `LOW`                                                                                                                                                                                                                                                               | kept narrow and named as a seam, with its removal condition recorded: it exits when the persisted field does, and it is never extended with capabilities, runtime requirements or security facts                                                                                                                                                                                                                                                                                                                                                                                              | 4F (evaluation); not scheduled for removal by the round plan                  |
| e   | one Tool budget ledger                                                                                                                      | `SqliteRunBudgetPort` keeps `admit` / `admitBatch` / `start` / `settle` **and** exposes `createSqliteToolBudgetAdmission`                                                                                                                                                                                      | two Tool budget vocabularies coexist over one ledger                                                                                                                                                                                                                                                                                                                                                                                                                                    | deliberate: two questions, two entry points, one implementation of each transition, no second accounting (§H)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 4D (batch preflight) / 4F                                                     |
| f   | policy admission evaluates one call from the durable invocation and the registered definition, which must agree on Tool name and risk level | **resolved in 4C.** `createCodingToolAdmissionPort.evaluate` now receives a `ToolExecutionGatePort` wrapped by `createDurableInvocationGatePort`, which loads the real durable invocation by invocation id and hands _that_ to the gate. The bare gate is no longer constructed directly by either composition | the checkpoint version of this adapter synthesized the gate's invocation as `riskLevel: "LOW"` while passing the registered definition's real `riskLevel`, and `CaelushToolExecutionGate.decide` refuses a mismatch by throwing `SecurityPolicyInvariantError` — which the adapter converts to `ToolExecutionFailure("ADMISSION")`. `apply_patch` (HIGH), `exec_command` (CRITICAL) and `write_stdin` (CRITICAL) therefore failed closed at admission instead of being policy-evaluated | fixed by binding the real durable invocation: `apps/daemon/src/daemon-composition.ts` and `ToolDispatcher.buildCoordinator` both wrap the gate with `createDurableInvocationGatePort`, whose resolver loads through `ToolExecutionStorePort.load`. The synthesized shape survives only for a composition that supplied no readable invocation, and it is documented as the fallback it is. Normalizing the definition metadata to `LOW` was rejected: `evaluateSecurityPolicy` reads `definition.riskLevel`, so it would silently downgrade `DANGEROUS_ONLY` approval for HIGH/CRITICAL Tools | n/a — closed in 4C                                                            |
| g   | a Tool refusal must settle through the one canonical failure path                                                                           | `ToolFailureFeedback` gained an optional `blockToolFailures` flag; `createToolFailureMemoryPreCheck` sets it, and `ToolDispatcher.delegate` records a model-recoverable failure in the memory                                                                                                                  | the flag is new in 4C: before it, the failure memory was consulted **in front of** the shell's durable path and the shell built its own `FAILED` row. The flag is what lets the memory's refusal be reached from inside admission while the _recording_ stays in the facade that has the observation                                                                                                                                                                                    | declared on the frozen feedback contract, set by the one pre-check that needs it, consumed by the facade's recorder, and asserted by the Phase 4C guard. It is a request, not a mechanism: the layer that decides whether a retry is refused reads it as one input                                                                                                                                                                                                                                                                                                                            | 4D (the recorder moves with the batch)                                        |
| h   | production SQLite truth must not expose a partially committed settlement                                                                    | `SqliteToolExecutionStore.commit` moves the matching `TOOL_INVOCATION` budget entry inside the terminal transaction, and `writeStateSnapshot` asserts the AgentState revision it just read within that same transaction                                                                                        | the AgentState revision check is a **self-consistency** guard, not a cross-writer one: the expected value is the row's revision read inside the same transaction, so on a single SQLite connection no second writer can interleave there and the branch is not reachable from outside. The Tool invocation revision (`ToolExecutionCommit.expectedRevision`) is the optimistic-concurrency guard for a settlement                                                                       | recorded rather than presented as stronger than it is. The atomicity tests assert the database's final state on every injectable failure (unknown extension kind, failing decoder, absent decoder, duplicate event, absent state snapshot) and the Tool revision conflict separately. The projection is covered by the positive test: it either commits with the invocation or rolls back with it                                                                                                                                                                                             | none — this is a documentation correction, and the guard is the Tool revision |

Evidence for (f), from the delivered source. §Q node 22 records it as closed.

```text
packages/tools/src/tool-admission-adapter.ts
  createDurableInvocationGatePort({ gate, invocations })   wraps the legacy gate
  toDefinitionMetadata(definition)                         riskLevel: definition.riskLevel
packages/security/src/tool-gate.ts
  invocation.riskLevel !== definition.riskLevel → SecurityPolicyInvariantError
apps/daemon/src/daemon-composition.ts
  policy: createCodingToolAdmissionPort({
    gate: createDurableInvocationGatePort({
      gate: toolSecurity.gate,
      invocations: { resolve: (request) => storage.toolExecution.load(request.invocationId) },
    }),
    ...
  })
packages/tools/src/dispatcher.ts
  the same wrapping on the facade's own coordinator path
packages/tools/src/builtins/apply-patch.ts    riskLevel: "HIGH"
packages/tools/src/builtins/exec-command.ts   riskLevel: "CRITICAL"
packages/tools/src/builtins/write-stdin.ts    riskLevel: "CRITICAL"
```

---

## N. Remaining legacy responsibilities and their exit rounds

| Responsibility                                                 | Current owner                             | Exit round      |
| -------------------------------------------------------------- | ----------------------------------------- | --------------- |
| `ToolPreflight` facade (resolution + legacy argument bound)    | `packages/tools/src/preflight.ts`         | 4D / 4F         |
| the historical argument-failure durable row                    | `ToolDispatcher.persistArgumentFailure`   | 4D              |
| `ToolBatchCoordinator`                                         | `packages/tools/src/batch-coordinator.ts` | 4D              |
| batch outcomes (`SKIPPED_AFTER_UNCERTAIN_EXECUTION`, …)        | `packages/tools` + Core                   | 4D              |
| model feedback projection                                      | Core                                      | 4D              |
| the production `ToolTurn` implementation                       | the Phase 3D Core adapter                 | 4D              |
| the nine builtins and their Operations                         | `packages/tools/src/builtins`             | 4E              |
| Coding facts / effects / presentation / prompt final ownership | `packages/tools` + `@caelush/security`    | 4E              |
| Operations ports and Runtime adapters                          | builtins call Runtime directly            | 4E              |
| the `packages/tools` facade itself                             | the whole legacy package                  | 4F              |
| `protocol.ToolDefinition` retirement                           | `@caelush/protocol`                       | 4F (evaluation) |

A round may leave a responsibility with the legacy implementation only if this table names the round
that takes it; the round plan's §1.1 table is the authority behind this one, and no row here invents an
exit round that the plan does not contain.

---

## O. Phase 3 invariants: affected / not affected

| Phase 3 frozen item                                                                     | 4C effect                                                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolTurnCoordinator`, `ToolTurnRequest`, `ToolTurnResult`                              | **not affected** — structurally unchanged; 4C adds no discriminant and no field                                                          |
| `AgentToolResult` (model-visible, four fields)                                          | **not affected** — the Phase 3 declaration keeps its name and its fields                                                                 |
| `AgentLoop`, `AgentLoopAdvanceResult`, `ModelTurnExecutor`                              | **not affected**                                                                                                                         |
| `RunExecutionCoordinator`, `RunExecutionDirective`, `RunExecutionDriver(+Dependencies)` | **not affected**                                                                                                                         |
| `RunExecutionEffectContext`, `RunExecutionEffectResult`, `RunTransitionPlanner`         | **not affected**                                                                                                                         |
| `RunContinuationCheckpoint`                                                             | **not affected** — no new continuation type and no new boundary pointer                                                                  |
| `CompletionGate(+Input/Decision)`                                                       | **not affected** — no Tool touches completion or Run status                                                                              |
| Durable event sequence and shapes                                                       | **not affected** — same event types, same payloads, same atomic commit, same order                                                       |
| ToolInvocation lifecycle and persistence                                                | **not affected in behaviour** — `RUNNING` still precedes execution and still means "the side-effect boundary was crossed"                |
| Run cancellation and deadline authority (Phase 10)                                      | **not affected** — recovery never resumes an intent-marked or expired Run, and 4C adds no Tool-level cancellation                        |
| Approval workflow (Phase 9B)                                                            | **not affected** — resolution, expiry and cancellation stay in storage; only the identity question is now asked through a canonical port |

---

## P. Phase 4A and 4B invariants that must remain true

Phase 4A:

```text
AgentTool extends AIToolSpec with label / resultDetailsSchema / executionMode / prepareArguments / execute
AgentTool carries no risk level, capability, runtime requirement, projector, presentation or snippet
ResolvedAgentTool has exactly three fields: tool, inputValidator, resultValidator
AgentToolRegistry.modelSpecs() projects exactly name, description, inputSchema
ToolCallPreparationOutcome has exactly READY and REJECTED
an unexpected prepareArguments throw is infrastructure, not REJECTED
packages/tools delegates instead of owning a second implementation
the Coding overlay lives in @caelush/coding-agent and is keyed by the registry's ToolName
```

Phase 4B:

```text
there is exactly one AgentTool.execute() caller: the canonical ToolInvocationExecutor
the result order is validate → sanitize → revalidate → bound → project
PreparedToolSettlement is the only value the settlement boundary consumes
the safe transient update lifetime keeps its orphan rule and drains before the terminal event
UNCERTAIN_SIDE_EFFECT is owned by @caelush/agent; the legacy name is a re-export
a sanitizer failure after the Tool ran stays a RESULT_PIPELINE infrastructure failure
maxDurableContentBytes is not the model observation limit
the settlement extension is produced after sanitization, never from the raw result
```

Why 4C cannot have eroded either list, stated as the property it relied on:

```text
4C changed WHO calls the 4B pair, never what the pair does. The coordinator constructs the executor and
the pipeline through the injected factories it is given, passes the prepared call and the durability
identity through unchanged, and treats the produced extension as an opaque value. No 4C file
re-implements validation, sanitization, bounding, projection or update handling, and no 4C file adds a
second `execute()` caller.
```

---

## Q. Verification nodes

Every status below is unclaimed. The Phase 4C completion report, not this map, carries the evidence.

| #   | Requirement                                                                                                                    | Status         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1   | canonical admission contracts and coordinator exist in `@caelush/agent`                                                        | see the report |
| 2   | canonical approval lookup port and approval request factory contract                                                           | see the report |
| 3   | canonical `ToolBudgetAdmissionPort` with `preflight`/`admit`/`start`/`settle`                                                  | see the report |
| 4   | one ToolInvocation transition table in the repository                                                                          | see the report |
| 5   | one ToolObservation factory and invariant in the repository                                                                    | see the report |
| 6   | one set of durable Tool event factories                                                                                        | see the report |
| 7   | `ToolExecutionStorePort` declared by `@caelush/agent`                                                                          | see the report |
| 8   | `ToolSettlementCoordinator` performs terminal settlement                                                                       | see the report |
| 9   | `DurableToolExecutionCoordinator` is the sole ToolInvocation Lifecycle Authority                                               | see the report |
| 10  | production delegation to it proven, in behaviour and by a static guard                                                         | see the report |
| 11  | `@caelush/storage` implements the canonical store port directly                                                                | see the report |
| 12  | budget `IN_FLIGHT` and terminal budget moves happen inside the Tool commit                                                     | see the report |
| 13  | effects decode inside the same SQLite transaction; unknown kind rolls back                                                     | see the report |
| 14  | the §J recovery matrix holds, including `RUNNING` never re-executing                                                           | see the report |
| 15  | the §K error taxonomy holds, including which failures settle `FAILED`                                                          | see the report |
| 16  | no new DB table, column or migration                                                                                           | see the report |
| 17  | no new ToolInvocation status, and `CANCELLED` stays unreachable                                                                | see the report |
| 18  | no parallel execution, no `terminate: true`                                                                                    | see the report |
| 19  | Phase 3 frozen interfaces unchanged                                                                                            | see the report |
| 20  | Phase 4A and Phase 4B invariants unchanged                                                                                     | see the report |
| 21  | no second implementation of any migrated responsibility                                                                        | see the report |
| 22  | every divergence in §M resolved or explicitly carried into its exit round                                                      | see the report |
| 23  | `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:architecture:ci`, `git diff --check`, `prettier --check` | see the report |
| 24  | remote push verified                                                                                                           | see the report |

Two housekeeping facts the report must handle, recorded here so they are not forgotten:

```text
PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md §4 still lists 4C as "not started" and links no 4C evidence;
recording the round there belongs to the report commit.

§M(f) is a source-verified open item, not a gate result. It is recorded as a divergence because the
round cannot pass node 22 without resolving it.
```
