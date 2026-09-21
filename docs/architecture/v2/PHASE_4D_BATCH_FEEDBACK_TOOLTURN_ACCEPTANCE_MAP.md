# Caelush Architecture V2 — Phase 4D Batch Coordination, Model Feedback Projection & ToolTurn Production Cutover — Acceptance Map

> Round: **Phase 4D** — the fourth and only fourth round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
> This round is **4D only**. There is no `4D-1`, no `4D-2`, no cleanup round, and no follow-up round.
>
> Base commit: `d340f909b052920804addccfc4726615cf837238` (Phase 4C tip)
> Branch: `deepseek/architecture-v2-phase-4d-batch-feedback-toolturn-cutover`
> Status while this map was written: `4A COMPLETE`, `4B COMPLETE`, `4C COMPLETE`, `4D IN PROGRESS`,
> `4E NOT STARTED`, `4F NOT STARTED`.

---

## A. Frozen scope of 4D

Phase 4D has exactly **four** core deliverables:

```text
1  canonical ToolBatchCoordinator        packages/agent/src/tools/batch/
2  canonical ToolResultBatchNormalizer   packages/agent/src/tools/observation/
3  canonical ModelToolFeedbackProjector  packages/agent/src/tools/observation/
4  production ToolTurn cutover           packages/core/src/run-tool-turn-coordinator.ts
```

It additionally completes the transition Phase 4A explicitly deferred to 4D:

```text
pre-invocation REJECTED
    -> no ToolInvocation row
```

The round is finished when a production Tool request travels from the model's `ToolCalls` all the way
to the next `AgentLoop` `TOOL_RESULTS` boundary entirely through Tool System V2.

### A.1 One-line task definition

> Establish `@caelush/agent` as the canonical authority for Tool batch scheduling, Tool result batch
> integrity and model Tool feedback, and cut the production `ToolTurn` over to them — completing the
> pre-invocation rejection semantic in which a rejected call creates no durable Tool row — while
> preserving sequential execution, the uncertain barrier, approval/recovery, the observation budget and
> every Phase 3 `ToolTurn` contract and RunController lifecycle authority.

---

## B. Explicit non-goals

This round must **not**:

```text
migrate any of the nine builtins
create ReadFileOperations / ListDirectoryOperations / FindFilesOperations / SearchTextOperations
create PatchOperations / ExecOperations / ProcessOperations / GitOperations
migrate builtin execution implementation
migrate Coding Security Facts / Coding Effects / Coding Presentation final ownership
migrate prompt snippets
migrate Runtime Operations adapters
delete packages/tools
delete protocol.ToolDefinition
delete all legacy Tool exports
complete final daemon cleanup
declare the entire Tool System V2 finished
```

It must also not introduce:

```text
parallel Tool execution              Promise.all Tool execution              terminate:true
new DB table                         new DB migration                        new Protocol persisted field
new ToolInvocation status            new Run status                          new first-class agent_turns table
MCP   Skills   Browser Agent   Web Search   Multi-Agent   Sub-Agent   remote Runtime
Security V2   Context V2   Memory V2   Message V2
```

Those belong to **4E** (the nine builtins, Operations, Runtime adapters, Coding metadata/effects/
presentation/prompt integration) and **4F** (final assembly, legacy retirement, `packages/tools`
deletion decision, `protocol.ToolDefinition` retirement, whole-phase acceptance).

---

## C. Frozen contracts this round implements

### C.1 Documentation availability

The two authorising specification documents

```text
Caelush_Tool_System_V2_Refactor_Spec.md
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md
```

are **not** in the repository tree; Phase 4C already recorded this and this round re-confirmed it
(`git ls-files` finds neither). They were read in full from their authorising copies outside the
repository for this round. **No clause number is fabricated and no repository file is claimed to have
been read that does not exist.** Where this map cites clause numbers (`§138`, `§141`, `§144`, `§146`,
`§107`, `§98`, `§189`, `§183`), the citation is to the _Interface Freeze_ document as supplied to this
round; the exact contract text is reproduced verbatim in C.2 below so the map is self-contained even
if that document is unavailable to a later reader.

### C.2 The frozen 4D contracts, verbatim

**`ToolBatchItemOutcome` (Interface Freeze §138) — EXACT FREEZE, no added arms.**

```ts
export type ToolBatchItemOutcome =
  | {
      readonly kind: "OBSERVATION";
      readonly call: ToolCallRequest;
      readonly invocationId: ToolInvocationId;
      readonly finalStatus: "COMPLETED" | "FAILED" | "CANCELLED";
      readonly observation: ToolObservation;
    }
  | {
      readonly kind: "REJECTED";
      readonly call: ToolCallRequest;
      readonly feedback: ToolFailureFeedback;
    }
  | {
      readonly kind: "SKIPPED";
      readonly call: ToolCallRequest;
      readonly feedback: ToolFailureFeedback;
    };
```

Forbidden additions: `rawResult`, `rawArtifact`, `exception`, `ToolEffect[]`, `ApprovalRequest`,
`Runtime`.

**`ToolBatchRequest` (Interface Freeze §139) — EXACT FREEZE.**

```ts
export interface ToolBatchRequest {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceStepId: StepId;
  readonly calls: readonly ToolCallRequest[];
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  readonly signal: AbortSignal;
}
```

Forbidden additions: `mode`, `registry`, `store`, Runtime object, `workspace`, budget manager, `Run`,
`AgentState`, `ToolTurnRequest`. Implementation dependencies arrive by constructor/factory injection.

**`ToolBatchOutcome` (Interface Freeze §140) — EXACT FREEZE, four arms.**

```ts
export type ToolBatchOutcome =
  | { readonly kind: "COMPLETED"; readonly items: readonly ToolBatchItemOutcome[] }
  | {
      readonly kind: "WAITING_APPROVAL";
      readonly items: readonly ToolBatchItemOutcome[];
      readonly pendingCall: ToolCallRequest;
      readonly approval: ApprovalRequest;
    }
  | {
      readonly kind: "BUDGET_EXCEEDED";
      readonly items: readonly ToolBatchItemOutcome[];
      readonly block: AgentBudgetBlock;
    }
  | { readonly kind: "CANCELLED"; readonly items: readonly ToolBatchItemOutcome[] };
```

Forbidden additions: `INFRASTRUCTURE_FAILURE`, `RESOURCE_WAIT`, `REPLAN`, `RUN_FAILED`.
Infrastructure failure **throws**.

**`ToolBatchCoordinator` (Interface Freeze §141) — EXACT FREEZE.**

```ts
export interface ToolBatchCoordinator {
  execute(request: ToolBatchRequest): Promise<ToolBatchOutcome>;
}
```

There is no `recover()`, no `modelDefinitions()` and no `dispatch()`. Those are legacy surface.

**`ToolResultBatchNormalizer` (Interface Freeze §144) — EXACT FREEZE.**

```ts
export interface ToolResultBatchNormalizer {
  normalize(input: {
    readonly requests: readonly ToolCallRequest[];
    readonly results: readonly AIToolResultMessage[];
  }): readonly AIToolResultMessage[];
}
```

**`ToolObservationPolicySnapshot` (Interface Freeze §145) — reused, never redeclared.** It stays
declared once, in `packages/agent/src/loop/types.ts`, as the Phase 3 Agent Loop froze it.

**`ModelToolFeedbackProjector` (Interface Freeze §146) — EXACT FREEZE.**

```ts
export interface ModelToolFeedbackProjector {
  project(input: {
    readonly calls: readonly ToolCallRequest[];
    readonly items: readonly ToolBatchItemOutcome[];
    readonly policy: ToolObservationPolicySnapshot;
  }): readonly AIToolResultMessage[];
}
```

**`AIToolResultMessage` (Phase 2A, already frozen) — the only canonical model Tool result.**

```ts
{
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}
```

There is deliberately no `rawArtifactRef`, no `details` and no `invocationId`.

### C.3 The frozen batch algorithm (Interface Freeze §141 "首轮算法")

```text
validate batch
    ↓
check cancellation
    ↓
budget preflight
    ↓
for calls in original order:
    if skipRemaining:            append SKIPPED; continue
    if signal aborted:           return CANCELLED
    prepare(call)
    if REJECTED:                 append REJECTED; continue
    DurableToolExecutionCoordinator.execute(...)
    switch outcome:
        SETTLED:                 append OBSERVATION
                                 if UNCERTAIN_SIDE_EFFECT: skipRemaining = true
        WAITING_APPROVAL:        return WAITING_APPROVAL
        BUDGET_EXCEEDED:         return BUDGET_EXCEEDED
        CANCELLED:               return CANCELLED
return COMPLETED
```

### C.4 The frozen reasons for the two shapes that changed versus legacy

**Why no `Batch.recover()` (Interface Freeze §131, §134–§137).** Phase 4C froze
`DurableToolExecutionCoordinator.execute()` to perform a durable lookup by
`(runId, sourceStepId, externalCallId)` on **every** call. A fresh `ToolTurn` and a recovered
`ToolTurn` therefore both call `ToolBatchCoordinator.execute()`; whether each individual call is
fresh or recovered is decided by the durable coordinator against durable truth. The Batch owns no
second recovery algorithm.

**Why the budget preflight takes raw `ToolCallRequest[]` (Interface Freeze §107).** The frozen
`ToolBudgetAdmissionPort.preflight(runId, requests: readonly ToolCallRequest[])` receives the raw
requests. The frozen algorithm orders `budget preflight` **before** the per-call `prepare` loop. The
legacy `dispatcher.preflightBudget()` computed its segment after filtering through preparation. This
is a deliberate cutover: see §M.2.

---

## D. Production call graph before 4D

```text
RunExecutionCoordinator
        ↓
RunController.toolTurnDriver(snapshot, mode)
        ↓
createRunToolTurnDriverFactory({ batches: ToolBatchCoordinatorPort })     packages/core
        ↓
   ┌────────────────────────────────────────┐
   │ context.effectiveMode === "RECOVER"    │
   │   ? batches.recover(batchRequest)      │   ← legacy recover() branch
   │   : batches.execute(batchRequest)      │
   └────────────────────────────────────────┘
        ↓
legacy ToolBatchCoordinator                        packages/tools
        ↓
dispatcher.preflightBudget(...)                    legacy budget helper (prepare+filter inside)
        ↓
legacy ToolDispatcher facade
        ↓
DurableToolExecutionCoordinator (4C)               packages/agent
        ↓
ToolAdmissionCoordinator / ToolInvocationExecutor / ToolResultPipeline / ToolSettlementCoordinator
        ↓
legacy ToolBatchItemResult[]                       raw content + invocationId + observationId + rawArtifactRef
        ↓
Core agent-tool-batch.ts
        ├─ projectToolObservationBatch()           @caelush/context truncation algorithm
        ├─ toAgentToolResults()                    Core-owned model feedback algorithm
        └─ toLLMToolResultMessages()               @caelush/llm message construction
        ↓
Core agent-tool-results.ts normalizeToolResultBatch()   Core-owned batch integrity algorithm
        ↓
frozen ToolTurnResult
        ↓
RunController → AgentLoop TOOL_RESULTS
```

Two transition authorities exist in this graph and 4D removes both:

```text
Core model-feedback algorithm      agent-tool-batch.ts
Core batch-normalization algorithm agent-tool-results.ts
```

---

## E. Production call graph after 4D

```text
RunExecutionCoordinator
        ↓
RunController.toolTurnDriver(snapshot, mode)
        ↓
createRunToolTurnDriverFactory({ batches: ToolBatchCoordinator })         packages/core
        ↓
Run Resource Governance (REPLAN / RESOURCE_WAIT / HARD_STOP stay in Core)
        ↓
canonical ToolBatchCoordinator.execute(request)                           @caelush/agent
        │
        ├─ request validation            (no durable side effect)
        ├─ duplicate externalCallId      (before any budget/prepare/durable write)
        ├─ ToolBudgetAdmissionPort.preflight(runId, rawCalls)
        │
        └─ for each call in original order (strictly sequential):
               ├─ ToolCallPreparer.prepare(call)
               │      ├─ REJECTED → ToolBatchItemOutcome.REJECTED        (no durable row)
               │      └─ READY
               ├─ DurableToolExecutionCoordinator.execute(...)           4C
               │      ├─ SETTLED           → OBSERVATION
               │      ├─ WAITING_APPROVAL  → stop, return WAITING_APPROVAL
               │      ├─ BUDGET_EXCEEDED   → stop, return BUDGET_EXCEEDED
               │      └─ CANCELLED         → stop, return CANCELLED
               └─ UNCERTAIN_SIDE_EFFECT → skipRemaining = true
        ↓
ToolBatchOutcome
        ↓
ModelToolFeedbackProjector.project({ calls, items, policy })              @caelush/agent
        │      ├─ Durable ToolObservation   (OBSERVATION)
        │      └─ safe ToolFailureFeedback  (REJECTED / SKIPPED)
        ↓
AIToolResultMessage[]                                                     @caelush/ai
        ↓
ToolResultBatchNormalizer.normalize({ requests, results })                @caelush/agent
        ↓
normalized, ordered AIToolResultMessage[]
        ↓
Core compatibility conversion (one narrow field rename)
        ↓
frozen ToolTurnResult
        ↓
RunController
        ↓
AgentLoop TOOL_RESULTS
```

---

## F. Responsibility map: before 4D → after 4D

| Responsibility                         | Before 4D owner                                                              | After 4D owner                                                          | Compatibility bridge                                 | Exit round |
| -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ---------- |
| batch input validation                 | `@caelush/tools` `assertToolBatchRequest`                                    | `@caelush/agent` `assertToolBatchRequest`                               | legacy re-exports canonical error classes            | 4F         |
| duplicate `externalCallId` validation  | `@caelush/tools` (before dispatch)                                           | `@caelush/agent` (before budget/prepare)                                | —                                                    | 4F         |
| batch budget preflight                 | `@caelush/tools` `dispatcher.preflightBudget()` (prepare-then-filter)        | `@caelush/agent` → `ToolBudgetAdmissionPort.preflight(runId, rawCalls)` | legacy helper retained for direct clients            | 4F         |
| sequential scheduling                  | `@caelush/tools` `ToolBatchCoordinator`                                      | `@caelush/agent` `ToolBatchCoordinator`                                 | —                                                    | 4F         |
| `ToolCallPreparer` invocation          | legacy Dispatcher internals                                                  | `@caelush/agent` Batch step                                             | —                                                    | —          |
| pre-invocation rejection               | legacy Dispatcher → **FAILED ToolInvocation row**                            | `@caelush/agent` Preparer `REJECTED` → **no row**                       | legacy direct API keeps historical behaviour         | 4F         |
| durable invocation dispatch            | legacy Dispatcher `dispatch`/`recoverOrDispatch`                             | `@caelush/agent` `DurableToolExecutionCoordinator.execute`              | —                                                    | 4F         |
| uncertain batch barrier                | `@caelush/tools` Batch                                                       | `@caelush/agent` Batch                                                  | legacy `SKIPPED_AFTER_UNCERTAIN_EXECUTION` code kept | 4F         |
| waiting-approval stop                  | `@caelush/tools` Batch                                                       | `@caelush/agent` Batch                                                  | —                                                    | 4F         |
| budget-exceeded stop                   | `@caelush/tools` Batch                                                       | `@caelush/agent` Batch                                                  | —                                                    | 4F         |
| cancellation stop                      | `@caelush/tools` Batch → `COMPLETED`                                         | `@caelush/agent` Batch → `CANCELLED`                                    | Core maps to Run cancellation authority              | —          |
| `ToolBatchItem` representation         | `@caelush/tools` `ToolBatchItem`                                             | `@caelush/agent` `ToolCallRequest`                                      | legacy type retained                                 | 4F         |
| Tool Batch outcome representation      | `@caelush/tools` `ToolBatchOutcome` (`results`/`completedResults`/`blocked`) | `@caelush/agent` `ToolBatchOutcome` (`items`/`pendingCall`/`block`)     | legacy type retained                                 | 4F         |
| durable Observation → model content    | `@caelush/core` `agent-tool-batch.ts`                                        | `@caelush/agent` `ModelToolFeedbackProjector`                           | Context projection injected as a private seam        | 4F         |
| observation token budget               | `@caelush/context` `projectToolObservationBatch`                             | `@caelush/context` **unchanged** — injected into the projector          | Core wires the Context implementation                | —          |
| Tool Result message construction       | `@caelush/core` `agent-tool-batch.ts` (`@caelush/llm`)                       | `@caelush/agent` `ModelToolFeedbackProjector` (`@caelush/ai`)           | Core does a one-field conversion                     | 4F         |
| Tool Result batch normalization        | `@caelush/core` `agent-tool-results.ts`                                      | `@caelush/agent` `ToolResultBatchNormalizer`                            | Core delegates                                       | 4F         |
| result identity/order validation       | `@caelush/core` `normalizeToolResultBatch`                                   | `@caelush/agent` `ToolResultBatchNormalizer`                            | —                                                    | 4F         |
| production `ToolTurn` mapping          | Core adapter over legacy Batch                                               | Core adapter over canonical Batch                                       | —                                                    | —          |
| `EXECUTE` / `RECOVER` entry            | `execute()` / `recover()`                                                    | both → `execute()`                                                      | `mode` retained, validated, recorded                 | —          |
| legacy `ToolBatchCoordinator`          | production authority                                                         | **0 production authority**                                              | legacy facade, unreferenced by production            | 4F         |
| legacy `ToolDispatcher` production use | production batch execution boundary                                          | **0 production batch authority**                                        | legacy facade for direct clients                     | 4F         |

---

## G. `ToolBatchItemOutcome` implementation

```text
OBSERVATION   call + invocationId + finalStatus + observation
              observation is the DURABLE ToolObservation the 4C coordinator returned
              finalStatus is derived from the durable invocation status
REJECTED      call + safe ToolFailureFeedback, produced by ToolCallPreparer before any durable write
SKIPPED       call + safe ToolFailureFeedback, produced by the batch barrier
```

`OBSERVATION` truth source: **the durable settlement returned by
`DurableToolExecutionCoordinator`**. An observation is never reconstructed from a raw
`AgentToolResult`, and raw `AgentToolResult` never becomes model-facing truth.

`finalStatus` maps from the durable invocation status:

```text
COMPLETED  -> "COMPLETED"
FAILED     -> "FAILED"
CANCELLED  -> "CANCELLED"
```

---

## H. Pre-invocation rejection migration

### H.1 What changes

```text
BEFORE 4D   legacy Dispatcher persisted a FAILED ToolInvocation for invalid arguments
AFTER  4D   ToolCallPreparer.REJECTED -> ToolBatchItemOutcome.REJECTED -> NO durable row
```

### H.2 The zero-side-effect proof obligation

A `REJECTED` item must be produced with:

```text
ToolInvocation rows        +0
ToolObservation rows       +0
ApprovalRequest rows       +0
Budget reservations        +0
durable tool events        +0
AgentTool.execute calls    +0
```

and the model must still receive safe feedback: `ModelToolFeedbackProjector` projects the
`ToolFailureFeedback` into an `AIToolResultMessage` with `isError = true`.

### H.3 Cases that must be covered

```text
unknown tool                  -> TOOL_UNAVAILABLE
invalid schema                -> TOOL_ARGUMENT_ERROR
oversized args                -> TOOL_ARGUMENTS_TOO_LARGE
```

Each must create no invocation, no observation, no approval and no budget reservation.

### H.4 A safe rejection does not stop the batch

A batch of `[invalid call, valid call]` produces `REJECTED` then executes the valid call, and ends
`COMPLETED` with two model Tool results in original order. A `REJECTED` item is a model-correctable
fact, never a Run failure.

---

## I. Batch cancellation mapping

The frozen `ToolBatchOutcome` has a `CANCELLED` arm; the frozen Phase 3 `ToolTurnResult` does **not**
(`COMPLETED`, `WAITING_APPROVAL`, `BUDGET_EXCEEDED`, `RESOURCE_WAIT`, `REPLAN` only). This round may
not add a discriminant to `ToolTurnResult`.

| Situation                                   | Mapping                                                                                                                                                                                                 | Why Run authority stays intact                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CANCELLED` with `signal.aborted === true`  | Core adapter does not produce a `ToolTurnResult`; it lets the run-scoped abort propagate so `executeToolBatchDirective` reaches its existing `executionSignal.aborted -> finalizeAbortedExecution` path | `RunController` remains the only cancellation authority; the Tool System never writes a Run status                                                            |
| `CANCELLED` with `signal.aborted === false` | fail closed as a Core invariant / infrastructure failure                                                                                                                                                | the frozen `ToolTurn` has no safe arm to express it, and inventing `COMPLETED`, an error Tool result, or an automatic Run cancel would all forge an authority |
| pre-aborted `request.signal`                | Batch returns `{ kind: "CANCELLED", items: [] }` before any real Tool side effect                                                                                                                       | no invocation, no reservation, no prepare hook, no execution                                                                                                  |

### I.1 Batch resource progress compatibility

Core keeps its `RunToolTurnObservation` and resource-progress fingerprinting. The new `OBSERVATION`
item carries the real durable `ToolObservation`, so Core-private observation reads canonical Batch
output rather than re-querying raw Tool results.

`rawArtifactRef` continues to live inside the durable `ToolObservation`; model feedback does not carry
it back into `AIToolResultMessage`, but Core/private context-recovery logic may still read
`ToolBatchItemOutcome.OBSERVATION.observation.rawArtifactRef`.

---

## J. Observation projection boundary

### J.1 The dependency problem

```text
Architecture V2 dependency rules:   agent -X-> context
current Core:                       projectToolObservationBatch + Utf8HeuristicTokenEstimator live in @caelush/context
```

So `packages/agent` may not import `@caelush/context`, and it must not copy the truncation algorithm
either — that would create two observation-budget algorithms, and would silently drop the
head + omission-marker + tail behaviour the Context projector applies to `read_file` and
`exec_command`-shaped output.

### J.2 The seam

The public `ModelToolFeedbackProjector.project(...)` signature is unchanged. The **factory** accepts a
narrow model-observation projection callback:

```ts
createModelToolFeedbackProjector({
  projectBatch(input) {
    /* Context-owned token projection */
  },
});
```

Ownership is therefore:

```text
Agent   owns model feedback semantics
Context owns the token projection algorithm
Core    adapts the two at the composition boundary
```

No reverse dependency is introduced: `@caelush/context` still does not depend on `@caelush/agent`.

Candidates handed to the injected projection come only from durable observation content and safe
feedback content — never a raw `AgentToolResult`, raw Runtime output or a raw exception.

### J.3 Bounds

`maxSingleObservationTokens` and `maxObservationBatchTokens` behaviour is preserved, including stable
order and a minimum representation per Tool Result. `REJECTED` and `SKIPPED` safe feedback is bounded
by the same batch budget as `OBSERVATION` items.

---

## K. `ToolTurn` compatibility boundary

`packages/agent/src/run/ports/tool-turn.ts` is **not modified**.

```text
ToolTurnRequest      mode, sourceStepId, pendingDecision, observationPolicy?, signal   UNCHANGED
ToolTurnResult       COMPLETED | WAITING_APPROVAL | BUDGET_EXCEEDED | RESOURCE_WAIT | REPLAN   UNCHANGED
```

`ToolTurnRequest.mode` remains a Run Layer entry fact: it is still validated, still recorded in the
Core-private `RunToolTurnObservation` as `effectiveMode`, and still never deleted. What changes is
that `mode` no longer selects `execute()` versus `recover()` — both now call the canonical
`batch.execute()`, and per-call recovery belongs to the 4C durable coordinator.

Core compatibility conversions remain one field wide:

```text
AIToolResultMessage.toolCallId  -> AgentToolResult.externalCallId
AIToolResultMessage.toolName    -> AgentToolResult.toolName
AIToolResultMessage.content     -> AgentToolResult.content
AIToolResultMessage.isError     -> AgentToolResult.isError
```

This conversion must not truncate, sanitize, read an observation or change order — the safe
projection already happened inside the projector.

### K.1 Result-status mappings

| Canonical Batch outcome   | Frozen `ToolTurnResult`                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPLETED`               | `{ kind: "COMPLETED", results: <projected + normalized> }`                                                                                                                                                      |
| `WAITING_APPROVAL`        | `{ kind: "WAITING_APPROVAL", completedResults: [], waiting: { invocationId: approval.toolInvocationId, approvalId: approval.id, externalCallId: pendingCall.externalCallId, toolName: pendingCall.toolName } }` |
| `BUDGET_EXCEEDED`         | `{ kind: "BUDGET_EXCEEDED", completedResults: [], block }`                                                                                                                                                      |
| `CANCELLED` + aborted     | no `ToolTurnResult`; Run cancellation authority                                                                                                                                                                 |
| `CANCELLED` + not aborted | fail closed (Core invariant / infrastructure failure)                                                                                                                                                           |

### K.2 Why `completedResults` stays empty

The Phase 3 Run invariant does not accept a partial Tool result batch at the `WAITING_APPROVAL` or
`BUDGET_EXCEEDED` boundary. Even when earlier Tools are already durably complete, Run continuation
writes no partial model results. After approval resolution the batch re-runs, the durable coordinator
recovers the already-complete calls without re-executing them, and the complete batch is projected
once, in original order. This round preserves that behaviour exactly.

### K.3 Model feedback is produced only for a COMPLETE batch

For `WAITING_APPROVAL`, `BUDGET_EXCEEDED` and `CANCELLED`, no partial `AIToolResultMessage[]` is
written to Run continuation. The projector's "one result per original call" obligation is therefore
only discharged on `COMPLETED`.

---

## L. Legacy exits

| Legacy surface                                                                                                          | 4D status                                                                                          | Exit round |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| `packages/tools/src/batch-coordinator.ts` `ToolBatchCoordinator`                                                        | production authority removed; retained as legacy facade, unreferenced by production                | 4F         |
| `packages/tools/src/batch-types.ts` `ToolBatchItem`/`ToolBatchItemResult`/`ToolBatchOutcome`/`ToolBatchCoordinatorPort` | retained for external tests and direct clients; not used by canonical production                   | 4F         |
| `packages/tools` `ToolBatchInputError` / `ToolBatchInfrastructureError`                                                 | re-export the canonical `@caelush/agent` classes (one declaration, one `instanceof` identity)      | 4F         |
| `ToolDispatcher.persistArgumentFailure`                                                                                 | retained for legacy compatibility tests and direct clients; **0 production `ToolTurn` references** | 4F         |
| `ToolDispatcher.dispatch/publicModel`                                                                                   | retained as legacy direct API; **not** on the production batch path                                | 4F         |
| `packages/core/src/agent-tool-batch.ts`                                                                                 | production model-feedback authority removed; delegates / keeps compatibility conversion only       | 4F         |
| `packages/core/src/agent-tool-results.ts`                                                                               | canonical authority is `@caelush/agent` `ToolResultBatchNormalizer`; Core re-exports/delegates     | 4F         |
| `packages/core/src/agent-errors.ts` `AgentToolResultBatchError`                                                         | canonical declaration moves to `@caelush/agent`; Core re-exports the same class identity           | 4F         |

### L.1 Legacy direct API ≠ production behaviour

`ToolDispatcher.dispatch(...)` remains a non-production legacy public compatibility API. It cannot
express the new `REJECTED` semantics without breaking its own historical return union, so its
historical direct-call behaviour is retained deliberately. This round states explicitly:

```text
legacy direct API behavior  !=  production Tool System V2 behavior
```

The existence of that facade does not mean the 4D production cutover is incomplete.

---

## M. Divergences between the frozen target and the current source

### M.1 `ToolBatchItemOutcome` versus legacy `ToolBatchItemResult`

```text
frozen contract    three arms: OBSERVATION | REJECTED | SKIPPED
current source     discriminated on TOOL_RESULT | UNAVAILABLE_TOOL | SKIPPED_AFTER_UNCERTAIN_EXECUTION
                   and carries invocationId, observationId, rawArtifactRef
difference         the legacy representation mixes durable identity, raw artifact pointer and model
                   content into one model-facing shape, and has no arm for a pre-invocation rejection
4D treatment       implement the frozen three-arm union in @caelush/agent; keep the legacy union as a
                   compatibility type with no production authority
future exit round  4F
```

### M.2 Budget preflight semantics — a deliberate cutover

```text
legacy 4C   dispatcher.preflightBudget() receives requests, prepares/filters them internally, and
            sizes the budget only over the executable segment
frozen 4D   ToolBudgetAdmissionPort.preflight(runId, requests) receives the RAW ToolCallRequest[]
            and the algorithm orders preflight BEFORE the per-call prepare loop
difference  a batch whose segment would shrink after preparation is now preflighted at its full
            requested size
4D treatment   obey the frozen target semantics. The Budget Port must not import AgentToolRegistry
               and must not call ToolCallPreparer, and the Batch must not prepare twice.
future exit round  none - this is the frozen target
```

Behavioural impact: a batch that is over budget at its requested size reports `BUDGET_EXCEEDED` with
zero executions even when some individual calls would have been rejected during preparation. That is
the conservative direction, and it is the frozen contract.

### M.3 Observation policy type location

```text
frozen contract    ToolObservationPolicySnapshot, reused
current source     Core declares AgentToolObservationPolicy as Pick<ContextPolicy, ...>
difference         Core carries a Context-derived alias for the same two numbers
4D treatment       the projector names the Phase 3 agent-owned ToolObservationPolicySnapshot; the
                   Core alias remains as the host-facing policy type and stays structurally identical
future exit round  4F (host Context policy plumbing)
```

### M.4 Cancellation authority

```text
frozen contract    ToolBatchOutcome has CANCELLED; ToolTurnResult deliberately does not
current source     legacy Batch returned COMPLETED on an aborted signal
difference         a cancelled batch was previously indistinguishable from a completed one
4D treatment       canonical Batch reports CANCELLED; the Core adapter routes an aborted cancellation to
                   the existing Run cancellation authority and fails closed otherwise
future exit round  none - this is the frozen target
```

---

## N. Error ownership migration

Canonical declarations move to `@caelush/agent`:

```text
ToolBatchInputError              batch request validation
ToolBatchInfrastructureError     batch infrastructure failure
AgentToolResultBatchError        Tool Result batch integrity (Normalizer) + model feedback identity
```

`@caelush/tools` and `@caelush/core` re-export the **same class identity** so that

```text
one declaration
one instanceof identity
```

holds repository-wide, and no two same-named classes exist.

Infrastructure failures are never modelled as model feedback:

```text
ToolBatchInfrastructureError
ToolResultBatchNormalizer invariant error
ModelToolFeedbackProjector infrastructure error
```

must **not** produce an `AIToolResultMessage { isError: true }`. They propagate to the Run execution
layer and are handled by the existing sanitized Run failure/recovery path.

Core Run failure mapping is preserved:

```text
ToolBatchInputError                  -> MODEL_ERROR,  phase LLM
Tool infrastructure failure          -> RUNTIME_ERROR, phase TOOL
```

Changing the canonical error class's import path must not change that classification.

---

## O. Architecture evidence

New guard: `tests/architecture/phase-4d-tool-batch-feedback-boundaries.test.ts`, covering at least:

```text
 1  packages/agent/src/tools/batch/**       does not import @caelush/tools
 2  packages/agent/src/tools/observation/** does not import @caelush/tools
 3  Agent batch does not import Core
 4  Agent batch does not import Context
 5  Agent observation does not import Context implementation
 6  Agent batch does not import Coding Agent
 7  Agent batch does not import Storage
 8  Agent batch does not import Runtime
 9  canonical ToolBatchCoordinator declaration exists only in Agent
10  canonical ModelToolFeedbackProjector declaration exists only in Agent
11  canonical ToolResultBatchNormalizer declaration exists only in Agent
12  production Run ToolTurn no longer imports legacy ToolBatchCoordinatorPort
13  production Daemon does not construct legacy ToolBatchCoordinator
14  production canonical Batch does not call ToolDispatcher
15  production model feedback does not call legacy toAgentToolResults()
16  production normalization does not call legacy normalizeToolResultBatch implementation
17  no raw AgentToolResult enters ModelToolFeedbackProjector
18  no ToolExecutionUpdate enters model feedback
19  no Promise.all in canonical Tool batch execution
20  Phase 3 ToolTurnRequest unchanged
21  Phase 3 ToolTurnResult unchanged
22  Phase 4A ToolCallPreparer unchanged
23  Phase 4B executor/result contracts unchanged
24  Phase 4C durable contracts unchanged
25  no new Protocol fields
26  no DB migration
27  nine Coding builtins remain where 4C left them
28  Operations migration not started
```

Production rejection guard: the production path reaches `ToolCallPreparer` through the canonical
Batch, and `REJECTED` cannot reach `ToolDispatcher.persistArgumentFailure`.

Architecture baseline: recorded before this round, then re-verified.

```text
before  new violations 0   stale baseline entries 0   frozen migration debt 27   readiness READY
after   new violations 0   stale entries 0            baseline_after <= baseline_before
```

The baseline is never regenerated to hide a violation, no broad exception is added and no rule is
disabled.

---

## P. Test evidence required by this round

| Suite                            | File                                                                       | Coverage                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| canonical batch                  | `packages/agent/test/tool-batch-coordinator.test.ts`                       | empty batch, duplicate id, sequential order, preflight before execution, whole-batch budget, rejection no-row, rejected-then-valid, safe failure continues, approval stop, budget stop, uncertain skip, skipped creates nothing, pre-aborted, abort after prior item, durable cancellation, infrastructure throw, strict ordering, zero `Promise.all` |
| no-row rejection integration     | `packages/agent/test/tool-batch-no-row-rejection.test.ts`                  | real/in-memory `ToolExecutionStorePort` counts before/after; durable coordinator execute count 0                                                                                                                                                                                                                                                      |
| model feedback                   | `packages/agent/test/model-tool-feedback-projector.test.ts`                | observation success/failure, REJECTED, SKIPPED, identity, order, single + batch truncation, mixed budget, multibyte, no `rawArtifactRef`, foreign/missing/duplicate item refused                                                                                                                                                                      |
| normalizer                       | `packages/agent/test/tool-result-batch-normalizer.test.ts`                 | ordered, out-of-order reordered, duplicate request, invalid message, duplicate result, unexpected result, missing result, name mismatch, one result per request                                                                                                                                                                                       |
| ToolTurn integration             | `packages/core/test/run-tool-turn-driver.test.ts` (extended)               | canonical Batch receives Run facts, identity retained, EXECUTE/RECOVER both `execute`, RECOVER of RUNNING does not re-execute, COMPLETED → projector → normalizer, WAITING_APPROVAL/BUDGET empty, RESOURCE_WAIT/REPLAN unchanged, CANCELLED aborted/not-aborted, discriminants unchanged                                                              |
| end-to-end rejection             | `packages/storage/test/run-controller-tool-integration.test.ts` (extended) | invalid Tool call → REJECTED no-row → safe result → next `AgentLoop` turn receives it; Tool execute 0, ToolInvocation 0, next model call 1                                                                                                                                                                                                            |
| end-to-end success               | daemon composition + run-controller suites                                 | successful Tool call → canonical Batch → durable observation → projector → `ToolTurn` COMPLETED → next `AgentLoop` `TOOL_RESULTS`                                                                                                                                                                                                                     |
| approval restart                 | `packages/storage/test/run-controller-tool-integration.test.ts`            | call_1 completes, call_2 waits, recovery does not re-run call_1, call_3 executes, final result order 1,2,3                                                                                                                                                                                                                                            |
| RUNNING crash recovery           | storage/core recovery suites                                               | RUNNING invocation → uncertain recovery, executor calls 0, remaining SKIPPED, model warned                                                                                                                                                                                                                                                            |
| observation budget compatibility | `packages/context/test/*observation*`                                      | same observations + same policy → same model content; large `read_file`/`exec_command`/generic output; head+omission+tail preserved                                                                                                                                                                                                                   |
| daemon composition               | `apps/daemon/test/tool-batch-production-composition.test.ts`               | exactly one canonical `ToolBatchCoordinator`, one `ModelToolFeedbackProjector`, one `ToolResultBatchNormalizer`; no legacy Batch construction                                                                                                                                                                                                         |
| independent use                  | `packages/agent/test/tools-independent-use.test.ts` (extended)             | `@caelush/agent` + `@caelush/ai` + `@caelush/protocol` alone: register an in-memory echo Tool, prepare, run canonical batch over in-memory durable ports, produce a durable observation, project an `AIToolResultMessage`                                                                                                                             |

### P.1 Failure injection required

```text
batch input invalid                    budget preflight throw            preparer infrastructure throw
durable coordinator throw              durable Tool uncertain            projector projection dependency throw
projector invalid item identity        normalizer missing result         normalizer duplicate result
normalizer unexpected result           normalizer tool-name mismatch     cancellation during first call
cancellation after prior calls         recovery of RUNNING Tool          Run resource REPLAN
Run resource WAIT
```

Each records: Tool execution count, ToolInvocation count, model result count, Run outcome, and whether
the error was model-visible.

---

## Q. User-observable behaviour matrix (before 4D → after 4D)

| Scenario                    | Before 4D                                        | After 4D                                                      |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| all-valid batch             | legacy Batch → Core projection                   | canonical Batch → projector → normalizer                      |
| invalid Tool args           | FAILED `ToolInvocation` row, model-visible error | `REJECTED`, **no** durable row, model-visible error           |
| unknown Tool                | `UNAVAILABLE_TOOL` legacy outcome                | `REJECTED` (`TOOL_UNAVAILABLE`), no durable row               |
| safe Tool failure           | continues                                        | continues (unchanged)                                         |
| uncertain Tool failure      | remaining skipped                                | remaining `SKIPPED` (unchanged semantics, canonical shape)    |
| approval required           | `WAITING_APPROVAL`, empty results                | `WAITING_APPROVAL`, empty results (unchanged)                 |
| approval recovery           | durable coordinator recovers                     | unchanged, now via `batch.execute()`                          |
| budget preflight exceeded   | legacy helper, prepare-then-filter               | frozen preflight over raw calls, zero execution               |
| single-call budget exceeded | stop, empty results                              | stop, empty results (unchanged)                               |
| Run cancellation            | batch returned `COMPLETED` on abort              | batch returns `CANCELLED`; Run cancellation authority settles |
| Tool crash recovery         | uncertain settlement, no re-execution            | unchanged, executor calls 0                                   |
| large Tool observation      | Context projection                               | same Context projection through the injected seam             |
| out-of-order result defense | Core `normalizeToolResultBatch`                  | canonical `ToolResultBatchNormalizer`                         |

### Q.1 Allowed deliberate semantic change

> **Production pre-invocation rejection no longer creates a durable `ToolInvocation` row.**

This is the frozen target. The model still receives safe Tool result feedback, but the durable Tool
ledger records no execution fact for a call that never executed. This is intentional, not a
regression.

### Q.2 Behaviour that must not change

```text
Tool names                       Tool order                    Tool schemas
numeric normalization            Security admission            Approval identity
Approval recovery                single-call budget            Tool effects
AgentState effects               atomic settlement             raw artifact storage
uncertain semantics              idempotent recovery           model Tool result identity
Run lifecycle authority          Completion authority
```

---

## R. Phase 4D COMPLETE gate

This round may output `Phase 4D COMPLETE` only when every one of these holds:

```text
canonical ToolBatchCoordinator exists
production ToolTurn uses canonical Batch
production does not construct legacy ToolBatchCoordinator
canonical Batch does not use ToolDispatcher
ToolCallPreparer REJECTED creates no ToolInvocation
REJECTED still reaches model as safe Tool result
uncertain execution skips remaining calls
skipped calls create no invocation
batch remains strictly sequential
canonical ToolResultBatchNormalizer exists
canonical ModelToolFeedbackProjector exists
raw AgentToolResult never enters model feedback
transient ToolExecutionUpdate never enters model feedback
model result identity preserved
model result order preserved
observation policy enforced
Core no longer owns second normalization algorithm
Core no longer owns second model-feedback algorithm
RECOVER does not re-execute RUNNING Tool
WAITING_APPROVAL partial model results remain empty
BUDGET_EXCEEDED partial model results remain empty
ToolTurnRequest unchanged
ToolTurnResult unchanged
RunController remains cancellation authority
4A contracts unchanged
4B contracts unchanged
4C contracts unchanged
no 4E builtins migration
no 4F compatibility deletion
all verification gates pass
remote parity verified
```

If the task could only be completed by modifying a frozen contract, adding a `ToolTurn` `CANCELLED`
discriminant, adding Workspace/Runtime/Store to `ToolTurnRequest`, changing the
`DurableToolExecutionCoordinator` or `ToolCallPreparer` public contract, changing the DB schema,
enabling parallel execution, moving builtins early or implementing Operations early, this round must
output `BLOCKED` instead and record the exact blocker, the frozen contract involved, the current
source evidence, why it cannot be resolved inside 4D, and which future round owns it.

---

## S. Still not started after 4D

```text
Phase 4E   9 builtins -> coding-agent, Operations interfaces, Runtime adapters,
           Coding security metadata, Coding effects final ownership, Coding presentation,
           prompt snippets, actual builtin transient updates
Phase 4F   final daemon assembly cleanup, legacy compatibility retirement,
           packages/tools deletion decision, protocol.ToolDefinition retirement,
           whole Tool System acceptance
```
