# Caelush Architecture V2 — Phase 4D Batch Coordination, Model Feedback Projection & ToolTurn Production Cutover Report

> Round: **Phase 4D** — the fourth and only fourth round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
> This round is **4D only**. No `4D-1`, no `4D-2`, no `4D-A`, no `4D-B`, no `4G`, no cleanup round and
> no follow-up round was created. The work was organised as Milestones A–I inside this one round.

```text
4A  COMPLETE
4B  COMPLETE
4C  COMPLETE
4D  COMPLETE   ← this round
4E  NOT STARTED
4F  NOT STARTED
```

---

## 1. Phase identity, branch and SHAs

```text
Phase                              Architecture V2 / Phase 4 / Tool System V2 / round 4D
Base SHA                            d340f909b052920804addccfc4726615cf837238   (Phase 4C tip)
Branch                              deepseek/architecture-v2-phase-4d-batch-feedback-toolturn-cutover
Verified code head                  the commit this report is attached to
Final branch tip                    identical to the verified code head (no post-verification commit)
Remote parity                       local tip == origin tip, verified with `git ls-remote --heads origin`
Working tree                        clean after commit (`git status --short` empty)
```

### 1.1 Baseline verification performed before coding

```text
git status --short                                        clean
git branch --show-current                                 deepseek/architecture-v2-phase-4c-durable-tool-orchestration
git rev-parse HEAD                                        d340f909b052920804addccfc4726615cf837238
git fetch origin                                          ok
git merge-base --is-ancestor d340f909... HEAD              exit 0  (4C tip is an ancestor of the start point)
git ls-remote --heads origin <4D branch>                   empty   (the 4D branch did not exist)
```

The 4D branch was then created **from `d340f909`**. No work started from `master`, from 4A, from 4B or
from an older code head.

### 1.2 Forbidden Git operations — none performed

```text
force push            not used
reset --hard          not used
merge master          not used
rebase 4A/4B/4C       not used
rewrite old commits   not used
release / deploy      not used
publish package       not used
```

One `git stash push` / `git stash pop` pair was used as a **read-only check** of the pre-round lint
baseline (to confirm a failing architecture guard was pre-existing rather than introduced). The stash was
popped immediately, nothing was lost, and no history was rewritten.

---

## 2. Specs actually read

```text
Caelush_Tool_System_V2_Refactor_Spec.md
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md
```

**Availability divergence, recorded honestly.** The two authorising documents are **not** in the
repository tree — `git ls-files` finds neither, exactly as Phase 4C recorded. They were located outside
the repository and read **in full** from their authorising copies for this round (4016 and 6197 lines
respectively). No clause number in this report or in the Acceptance Map is fabricated, and no repository
file is claimed to have been read that does not exist. Where a clause number is cited (`§138`, `§139`,
`§140`, `§141`, `§144`, `§145`, `§146`, `§107`, `§98`, `§189`, `§183`), the exact frozen contract text is
reproduced verbatim in `PHASE_4D_BATCH_FEEDBACK_TOOLTURN_ACCEPTANCE_MAP.md` §C.2, so the record is
self-contained.

Also read in full:

```text
AGENTS.md
docs/architecture/v2/MIGRATION_EXECUTION_CONTRACT.md
docs/architecture/v2/PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md
docs/architecture/v2/PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md
docs/architecture/v2/PHASE_4A_TOOL_FOUNDATION_REPORT.md
docs/architecture/v2/PHASE_4B_TOOL_EXECUTION_RESULT_ACCEPTANCE_MAP.md
docs/architecture/v2/PHASE_4B_TOOL_EXECUTION_RESULT_REPORT.md
docs/architecture/v2/PHASE_4C_DURABLE_TOOL_ORCHESTRATION_ACCEPTANCE_MAP.md
docs/architecture/v2/PHASE_4C_DURABLE_TOOL_ORCHESTRATION_REPORT.md
docs/architecture/v2/PHASE_3F_AGENT_LOOP_CLOSURE_REPORT.md
docs/architecture/v2/PHASE_3_AGENT_LOOP_MIGRATION_SUMMARY.md
docs/architecture/v2/PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md
docs/architecture/v2/PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md
scripts/architecture/v2-rules.mjs
scripts/architecture/legacy-import-baseline.json
```

---

## 3. Source scanned before coding

```text
packages/agent/src/tools/**                     every module under tools/, including all of 4A/4B/4C
packages/agent/src/loop/**                      the frozen ToolObservationPolicySnapshot and the loop types
packages/agent/src/run/ports/tool-turn.ts       the frozen ToolTurn contract
packages/agent/src/index.ts                     the public surface

packages/tools/src/batch-coordinator.ts         the legacy batch coordinator
packages/tools/src/batch-types.ts               the legacy batch vocabulary
packages/tools/src/batch-errors.ts              the legacy batch errors
packages/tools/src/dispatcher.ts                the legacy Dispatcher facade
packages/tools/src/dispatcher-types.ts          the legacy Dispatcher vocabulary
packages/tools/src/index.ts                     the legacy public surface

packages/core/src/run-tool-turn-coordinator.ts  the run-scoped Tool turn adapter
packages/core/src/run-tool-turn-observation.ts  the Core-private Tool turn observation
packages/core/src/agent-tool-batch.ts           the Core model-feedback/Context-projection authority
packages/core/src/agent-tool-results.ts         the Core batch normalizer authority
packages/core/src/run-controller.ts             the Run execution entry points
packages/core/src/run-controller-ports.ts       the Run Layer's declared dependencies
packages/core/src/index.ts                      the Core public surface

packages/context/src/observation-projector.ts   the Context token projection algorithm
packages/context/src/token-estimator.ts         the Context estimator
packages/context/src/index.ts                   the Context public surface

packages/ai/src/messages/message.ts             the frozen AIToolResultMessage and its assertion
packages/ai/src/messages/index.ts
packages/ai/src/index.ts

packages/storage/src/run-budget-port.ts         the budget preflight the canonical batch calls
apps/daemon/src/daemon-composition.ts           the production composition root
```

```text
packages/tools/test/*batch*      packages/tools/test/*dispatcher*
packages/core/test/*tool-turn*   packages/core/test/*tool-result*   packages/core/test/*run-controller*
packages/agent/test/*tool*       packages/context/test/*observation*
apps/daemon/test/*tool*          tests/architecture/**
```

### 3.1 Spec / source divergences found

| #   | Frozen contract                                                                                     | Current source                                                                                                                                           | Difference                                                                                                           | 4D treatment                                                                                                                                                   | Future exit round                 |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `ToolBatchItemOutcome` — three arms, no raw result                                                  | `ToolBatchItemResult` — `TOOL_RESULT`/`UNAVAILABLE_TOOL`/`SKIPPED_AFTER_UNCERTAIN_EXECUTION`, carrying `invocationId`, `observationId`, `rawArtifactRef` | the legacy shape mixes durable identity, artifact pointer and model content, and has no pre-invocation rejection arm | implemented the frozen three-arm union in `@caelush/agent`; kept the legacy union as compatibility with no production authority                                | 4F                                |
| 2   | `ToolBudgetAdmissionPort.preflight(runId, rawCalls)`; algorithm orders preflight **before** prepare | `dispatcher.preflightBudget()` prepares and filters internally, then sizes the executable segment                                                        | target preflights the **requested** segment                                                                          | obeyed the frozen target; the Budget Port neither imports the registry nor calls the Preparer, and the batch does not prepare twice                            | none — frozen target              |
| 3   | `ToolObservationPolicySnapshot` reused from the Agent Loop                                          | Core declares `AgentToolObservationPolicy = Pick<ContextPolicy, ...>`                                                                                    | same two numbers, Context-derived in Core                                                                            | the projector names the Phase 3 agent-owned type; the Core alias remains the host-facing policy and stays structurally identical                               | 4F (host Context policy plumbing) |
| 4   | `ToolBatchOutcome` has `CANCELLED`; `ToolTurnResult` deliberately does not                          | legacy batch returned `COMPLETED` on an aborted signal                                                                                                   | a cancelled batch was indistinguishable from a completed one                                                         | canonical Batch reports `CANCELLED`; Core routes an aborted cancellation to the existing Run cancellation authority and fails closed otherwise                 | none — frozen target              |
| 5   | `ModelToolFeedbackProjector` is declared in `@caelush/agent`                                        | `projectToolObservationBatch` + `Utf8HeuristicTokenEstimator` live in `@caelush/context`, and `agent -X-> context`                                       | the algorithm and the semantics were in one place that cannot be the Agent package                                   | injected the Context algorithm as a narrow implementation seam (`ModelObservationBatchProjector`); the Agent package neither imports nor copies it             | none — this is the boundary       |
| 6   | `AIToolResultMessage` has five fields and no `rawArtifactRef`                                       | the legacy `LLMToolResultMessage` carries `rawArtifactRef` for Context recovery                                                                          | the durable conversation encoding is wider than the canonical model message                                          | the canonical projector produces only `AIToolResultMessage`; Core's compatibility adapter restores the pointer from the durable ledger, never from the message | 4F                                |

No divergence was silently resolved: each is recorded above, in the Acceptance Map §M, and where a
choice was made it is named.

---

## 4. Before/after Batch authority

```text
BEFORE 4D
  RunController.toolTurnDriver
    → createRunToolTurnDriverFactory({ batches: ToolBatchCoordinatorPort })      packages/core
    → effectiveMode === "RECOVER" ? batches.recover(req) : batches.execute(req)  ← two entry points
    → legacy ToolBatchCoordinator                                               packages/tools
    → dispatcher.preflightBudget(...)                                            legacy budget helper
    → legacy ToolDispatcher facade
    → DurableToolExecutionCoordinator (4C)                                       packages/agent
    → legacy ToolBatchItemResult[]
    → Core agent-tool-batch.ts        model feedback + Context projection
    → Core agent-tool-results.ts      batch normalization
    → frozen ToolTurnResult

AFTER 4D
  RunController.toolTurnDriver
    → createRunToolTurnDriverFactory({ batches: ToolBatchCoordinator, ... })     packages/core
    → dependencies.batches.execute(req)                                          ← one entry point
    → canonical ToolBatchCoordinator                                             @caelush/agent
        ├─ ToolCallPreparer                      4A
        ├─ ToolBudgetAdmissionPort.preflight     4C, over the RAW requested calls
        └─ DurableToolExecutionCoordinator       4C
    → ToolBatchItemOutcome[]
    → ModelToolFeedbackProjector                                                @caelush/agent
    → AIToolResultMessage[]                                                     @caelush/ai
    → ToolResultBatchNormalizer                                                 @caelush/agent
    → frozen ToolTurnResult
```

The two transition authorities named in the authorising prompt are both gone from production:

```text
Core model-feedback algorithm       agent-tool-batch.ts   → now a Context-projection adapter + legacy facade
Core batch-normalization algorithm  agent-tool-results.ts → now a delegation to the canonical normalizer
```

---

## 5. Deliverable 1 — canonical `ToolBatchCoordinator`

### 5.1 `ToolBatchItemOutcome` implementation — exact freeze honoured

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

No `rawResult`, no `rawArtifact`, no `exception`, no `ToolEffect[]`, no `ApprovalRequest` and no Runtime.
Enforced structurally by the 4D architecture guard.

**`OBSERVATION` truth source.** The `observation` is the **durable `ToolObservation` the 4C coordinator
returned**. It is never reconstructed from an `AgentToolResult`, and a raw `AgentToolResult` never becomes
model-facing truth. `finalStatus` is derived from the durable invocation status, and a non-terminal status
is an infrastructure failure rather than a guess.

### 5.2 `ToolBatchRequest` implementation — exact freeze honoured

```ts
{
  (runId, sessionId, sourceStepId, calls, environment, securityContext, signal);
}
```

Seven fields, closed list. No `mode`, no `registry`, no `store`, no Runtime object, no `workspace`, no
budget manager, no `Run`, no `AgentState`, no `ToolTurnRequest`. `signal` is required. Implementation
dependencies arrive by factory injection only.

### 5.3 `ToolBatchOutcome` implementation — exact freeze honoured

Four arms: `COMPLETED`, `WAITING_APPROVAL` (with `pendingCall` + `approval`), `BUDGET_EXCEEDED` (with
`block`), `CANCELLED`. No `INFRASTRUCTURE_FAILURE`, no `RESOURCE_WAIT`, no `REPLAN`, no `RUN_FAILED`.
Infrastructure failure **throws** `ToolBatchInfrastructureError`.

### 5.4 `ToolBatchCoordinator` implementation — exact freeze honoured

```ts
export interface ToolBatchCoordinator {
  execute(request: ToolBatchRequest): Promise<ToolBatchOutcome>;
}
```

One method. No `recover()`, no `modelDefinitions()`, no `dispatch()`.

### 5.5 Batch validation

Validated with **zero side effects**, before any budget question, preparation or durable write:

```text
request is an object            exact seven-field key set
runId / sessionId / sourceStepId valid Protocol ids
calls is a non-empty array      environment is { workspace, runtime } of valid refs
securityContext valid           signal is an AbortSignal
per call: exact three-field key set, non-empty bounded externalCallId,
          valid ToolName, JsonObject args
```

The call-key list is checked with `Object.hasOwn` as well as by length, so an extra field is a caller
error rather than something ignored.

### 5.6 `duplicate externalCallId` — before anything else

The duplicate check runs **inside validation**, i.e. before the budget preflight, before any preparation
and before any durable write. This is the ordering that makes "execute the first copy, then discover the
duplicate" impossible; a test asserts that a duplicate batch produces an empty event log.

### 5.7 Budget preflight

```ts
ToolBudgetAdmissionPort.preflight(runId, requests: readonly ToolCallRequest[])
```

Called **once**, with the **raw requested calls**, before the per-call prepare loop. The Budget Port
neither imports `AgentToolRegistry` nor calls `ToolCallPreparer`, and the Batch never prepares twice.

The deliberate semantic change against the legacy helper is recorded in §2.1 divergence 2 and in the
Acceptance Map §M.2: a batch that is over budget at its _requested_ size now reports `BUDGET_EXCEEDED`
with zero executions even when preparation would have shrunk the segment. That is the conservative
direction and it is the frozen contract.

Behavioural impact: `SqliteRunBudgetPort.preflight` answers from `admitBatch({ requested: requests.length })`,
so the extra headroom a rejected call would previously have returned is no longer reclaimed. A Run whose
`maxToolCalls` budget is nearly exhausted now stops at its requested batch size. No existing test changed
behaviour as a result, and the whole-suite run confirms it.

Preflight is a question, not a reservation: it writes nothing, creates no rows, marks nothing `IN_FLIGHT`
and executes no Tool. A block returns `{ kind: "BUDGET_EXCEEDED", items: [], block }`.

### 5.8 Strictly sequential scheduling

```text
V2 first implementation = sequential scheduler
```

The loop is an ordinary `for (const call of request.calls)`. There is **no** `Promise.all`, no
`Promise.allSettled`, no `Promise.race`, no worker pool and no completion-order contract — in the
coordinator, in the planner or in the adapter. `call_1` is fully decided before `call_2` is prepared, and a
test asserts exactly that event order. A Tool that declares `PARALLEL_SAFE` changes nothing: the declared
mode is _reported_ by the private `ToolBatchPlanner` and never branched on.

### 5.9 Pre-invocation rejection

```text
ToolCallPreparer.prepare(call)
   READY     → DurableToolExecutionCoordinator.execute(...)
   REJECTED  → ToolBatchItemOutcome.REJECTED, no durable row, loop continues
```

A rejection is a safe, model-correctable fact and never a barrier: `[rejected, valid]` produces a
`REJECTED` item followed by an executed valid call, ending `COMPLETED` with two model results in original
order.

A preparation **infrastructure** throw (registry corruption, schema-runtime invariant, unexpected
`prepareArguments` exception) is converted to `ToolBatchInfrastructureError` rather than a `REJECTED` item,
because the model would otherwise be told to fix a call that may have been perfectly well formed.

### 5.10 Known safe Tool failure continues

`SETTLED` with `invocation.status === "FAILED"` and **no** `UNCERTAIN_SIDE_EFFECT` disposition appends an
`OBSERVATION` and continues. The disposition is read from the durable error's `details`, where the
settlement wrote it — never inferred from a Tool name, an error message or a status.

### 5.11 Uncertain skip barrier

`SETTLED` with an `UNCERTAIN_SIDE_EFFECT` disposition appends the current `OBSERVATION` and sets
`skipRemaining`, so every trailing call becomes `SKIPPED`. A skipped call is **not** prepared, **not**
admitted, **not** durably recorded and **not** executed — the skip decision precedes preparation in the
loop, which the architecture guard asserts positionally.

A skipped call's feedback keeps the compatibility code `SKIPPED_AFTER_UNCERTAIN_EXECUTION` and states
three things only:

```text
an earlier Tool may have partially or fully completed
do not continue this dependent Tool chain automatically
re-inspect the current state before retrying
```

It carries no raw exception, no absolute path, no command output, no secret and no stack. A `SKIPPED` item
is a **batch-level safe statement**, not a fake Tool execution: it creates no invocation, no observation,
no budget reservation and no execution.

### 5.12 Approval stop

A `WAITING_APPROVAL` durable outcome stops the batch immediately and returns
`{ kind: "WAITING_APPROVAL", items, pendingCall, approval }`. `items` holds only the calls that reached a
final item outcome **before** the waiting call; the pending call is expressed by `pendingCall` + `approval`
and is never a fabricated `OBSERVATION`, `REJECTED` or `SKIPPED`. The trailing calls are not prepared and
not executed.

### 5.13 Budget stop

A per-call `BUDGET_EXCEEDED` stops the batch and returns `{ kind: "BUDGET_EXCEEDED", items, block }`,
where `block` is the exact `AgentBudgetBlock` the budget authority returned — reported, never re-derived.
No fake `ToolObservation` is constructed, because the frozen durable outcome does not define that budget
boundary as model feedback; the Run Layer still owns the Run-level `BUDGET_EXCEEDED`.

### 5.14 Cancellation handling

| Situation                                                | Batch result                                                            | Side effects                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `signal.aborted === true` before the first call          | `{ kind: "CANCELLED", items: [] }`                                      | none: no preflight, no prepare, no execution    |
| abort after earlier items                                | `{ kind: "CANCELLED", items: [<prior items>] }`                         | trailing calls untouched                        |
| durable `CANCELLED` with a legitimate observation        | `CANCELLED` with an `OBSERVATION { finalStatus: "CANCELLED" }` appended | none manufactured                               |
| durable `CANCELLED` with no observation                  | `CANCELLED` with `items` as they were                                   | no observation invented                         |
| `ToolExecutionAbortedError` from the durable coordinator | `{ kind: "CANCELLED", items }`                                          | the abort arrived before any invocation existed |

`CANCELLED` is never a `ToolTurnResult` and never a Run status.

### 5.15 Infrastructure failure

```text
preparer infrastructure failure        durable coordinator infrastructure failure
store invariant failure                unexpected approval infrastructure failure
batch internal invariant failure       budget preflight failure
```

all **throw** `ToolBatchInfrastructureError` with the `cause` retained internally only. None of them is
turned into `REJECTED`, `SKIPPED` or an `AIToolResultMessage { isError: true }`, because "the settlement
transaction did not commit" is not a fact about a Tool call and a model told otherwise would retry a call
whose durable truth was never recorded.

---

## 6. Deliverable 2 — canonical `ToolResultBatchNormalizer`

```ts
export interface ToolResultBatchNormalizer {
  normalize(input: {
    readonly requests: readonly ToolCallRequest[];
    readonly results: readonly AIToolResultMessage[];
  }): readonly AIToolResultMessage[];
}
```

**Canonical input is `AIToolResultMessage`.** The `@caelush/llm` `LLMToolResultMessage` is no longer the
canonical type; it survives only as the durable-conversation compatibility encoding.

### 6.1 Normalization error authority

```text
one declaration    @caelush/agent  packages/agent/src/tools/batch/batch-errors.ts
@caelush/core      export { AgentToolResultBatchError } from "@caelush/agent";
@caelush/tools     export { ToolBatchInputError, ToolBatchInfrastructureError } from "@caelush/agent";
```

`AgentToolResultBatchError` has exactly one `class` declaration repository-wide; `@caelush/core` re-exports
the same identity, so `instanceof` cannot disagree between the thrower and the catcher. The architecture
guard asserts both the single declaration and the re-export.

### 6.2 Proofs

| Violation              | Reason                 | Proof                                                               |
| ---------------------- | ---------------------- | ------------------------------------------------------------------- |
| duplicate request ID   | `DUPLICATE_REQUEST_ID` | refused before any matching                                         |
| invalid result object  | `INVALID_RESULT`       | 9 malformed inputs refused, including a smuggled `rawArtifactRef`   |
| duplicate result       | `DUPLICATE_RESULT`     | two results claiming one call are refused, never "first wins"       |
| unexpected result      | `UNEXPECTED_RESULT`    | a result answering a call nobody requested                          |
| missing result         | `MISSING_RESULT`       | a requested call with no result; also `[request]` vs `[]`           |
| tool name mismatch     | `TOOL_NAME_MISMATCH`   | right call, wrong Tool name                                         |
| original request order | ordering authority     | `[call_3, call_1, call_2]` normalizes to `[call_1, call_2, call_3]` |

### 6.3 What it deliberately does not do

It never truncates, never sanitizes, never reads a durable observation, never builds feedback and never
executes a Tool. It owns identity, shape, multiplicity, matching and ordering — and nothing else. It uses
the AI package's own `assertAIMessage` rather than growing a second, weaker definition of a valid model
Tool result, and it returns a frozen, request-ordered batch.

---

## 7. Deliverable 3 — canonical `ModelToolFeedbackProjector`

```ts
export interface ModelToolFeedbackProjector {
  project(input: {
    readonly calls: readonly ToolCallRequest[];
    readonly items: readonly ToolBatchItemOutcome[];
    readonly policy: ToolObservationPolicySnapshot;
  }): readonly AIToolResultMessage[];
}
```

### 7.1 Observation truth source

`OBSERVATION` items project the **durable `ToolObservation`** the 4C settlement wrote. The projector never
accepts an `AgentToolResult`, raw Runtime stdout or stderr, a raw exception, a `ToolExecutionUpdate`, a
`ToolEffect[]` or raw artifact content. The declared input type is `ToolBatchItemOutcome[]`, and the
architecture guard asserts that the declaration names none of those forbidden types.

### 7.2 Safe feedback source

`REJECTED` and `SKIPPED` project only the safe `ToolFailureFeedback` content, with `isError: true`. Neither
invents an `invocationId`, because neither has one.

### 7.3 Context observation-budget compatibility seam

```text
@caelush/agent      owns model feedback semantics        ModelToolFeedbackProjector
@caelush/context    owns the token projection algorithm  projectToolObservationBatch
@caelush/core       adapts the two                       toContextObservationProjection()
```

The public `project(...)` signature is unchanged: the projection is a **factory** dependency, not a frozen
input. `@caelush/agent` neither imports `@caelush/context` nor copies the algorithm — the guard asserts
that the observation layer contains no `@caelush/context`, no `projectToolObservationBatch`, no
`Utf8HeuristicTokenEstimator` and no `read_file`. There is therefore still exactly **one**
observation-budget algorithm, and the head + omission-marker + tail behaviour the Context projector applies
to `read_file`- and `exec_command`-shaped output is preserved rather than degraded to a prefix cut.

### 7.4 Bounds

`maxSingleObservationTokens` and `maxObservationBatchTokens` behaviour is preserved: one batch allocation
in stable order, a per-item cap, and a minimum representation for every Tool Result. `REJECTED` and
`SKIPPED` safe feedback is bounded by the **same** batch budget as `OBSERVATION` items — safe is not the
same as short, and an unbounded rejection message would still blow the window.

The fallback used only when no projection is injected is deliberately tool-agnostic and cannot reproduce
the Context head+tail treatment; that limitation is documented at its declaration and is why production
always injects the Context implementation.

### 7.5 Identity, order and `isError`

```text
toolCallId   item.call.externalCallId    from the original call, never parsed from content
toolName     item.call.toolName          from the original call
content      the bounded summary
isError      OBSERVATION → observation.isError; REJECTED / SKIPPED → true
order        one message per call, in `calls` order
```

A missing, foreign, duplicate, reordered or Tool-name-mismatched item fails closed with
`AgentToolResultBatchError`; a projection that returns a different number of summaries fails closed too,
because guessing a pairing would attach one Tool's output to another Tool's identity.

### 7.6 No raw result, no transient update

`AIToolResultMessage` has five fields and deliberately no `rawArtifactRef`. The pointer travels _into_ the
projection (so a forced Context recovery can reach the archive) and never _out_ into model history. Four
tests assert the produced message's exact key set, that the artifact string never appears in the output,
and that a transient `ToolExecutionUpdate` is not reachable from the projector at all.

---

## 8. Deliverable 4 — production ToolTurn cutover

### 8.1 Core adapter responsibilities

The adapter still captures the host facts the frozen contract deliberately does not carry — `Run`,
`AgentState`, workspace locator, Runtime locator, security context, resource governance, observation
policy, entry mode — and still owns the Run resource governance. The general `ToolTurn` contract is
untouched.

### 8.2 Decision → `ToolCallRequest`

`pendingDecision.toolRequests` is mapped one-for-one:

```text
externalCallId   carried unchanged — never regenerated (it is the (runId, stepId, externalCallId) identity)
toolName         carried unchanged
args             carried unchanged
order            assistant source order, preserved exactly
```

### 8.3 Canonical `ToolBatchRequest` construction

```text
runId / sessionId   the durable Run
sourceStepId        the frozen ToolTurnRequest continuation
calls               the model's Tool calls, projected as above
environment         the existing RunToolTurn fact capture
securityContext     the existing Run/AgentState validated projection
signal              the exact caller signal, forwarded unchanged
```

### 8.4 `EXECUTE` / `RECOVER` mapping

```text
BEFORE   EXECUTE → legacy batch.execute()      RECOVER → legacy batch.recover()
AFTER    EXECUTE → canonical batch.execute()   RECOVER → canonical batch.execute()
```

`ToolTurnRequest.mode` is **not deleted**. It is still part of the frozen contract, still validated against
the durable continuation, and still recorded in the Core-private `RunToolTurnObservation.effectiveMode`.
What changed is that it no longer selects an entry point: the 4C `DurableToolExecutionCoordinator` performs
a durable lookup by `(runId, sourceStepId, externalCallId)` on every call, so whether an individual call is
fresh or already durable is decided against durable truth rather than by the batch.

**RECOVER proof.** `packages/core/test/run-tool-turn-driver.test.ts` asserts that a `RECOVER` resumption
re-presents the same batch identity to the same single `execute` call site (`["execute", "execute"]`) and
that no second entry point exists. The stronger "does not re-execute a durable call" claim is proven where
a real durable ledger exists — `packages/storage/test/run-controller-tool-integration.test.ts`
("retries the Provider after Tool Results without redispatching the Tool", "resumes directly from durably
accepted Tool Results after restart", "recovers a mid-batch interruption without retrying or starting the
trailing Tool") — because the Core-level stub deliberately has no Tool invocation store. That distinction
is stated in the test, not hidden.

### 8.5 `COMPLETED`

```text
ToolBatchOutcome.COMPLETED
   → ModelToolFeedbackProjector.project({ calls, items, policy })
   → ToolResultBatchNormalizer.normalize({ requests, results })
   → frozen ToolTurnResult { kind: "COMPLETED", results }
```

The final conversion onto the frozen `AgentToolResult` is one field wide
(`toolCallId → externalCallId`, `toolName`, `content`, `isError`). It does not truncate, sanitize, read an
observation or change order.

### 8.6 `AIToolResultMessage` → frozen `AgentToolResult`

```text
AIToolResultMessage.toolCallId  →  AgentToolResult.externalCallId
AIToolResultMessage.toolName    →  AgentToolResult.toolName
AIToolResultMessage.content     →  AgentToolResult.content
AIToolResultMessage.isError     →  AgentToolResult.isError
```

Four field copies, in the order the normalizer established. The safe projection already happened.

### 8.7 `WAITING_APPROVAL` mapping

```ts
{ kind: "WAITING_APPROVAL", completedResults: [],
  waiting: { invocationId: outcome.approval.toolInvocationId,
             approvalId: outcome.approval.id,
             externalCallId: outcome.pendingCall.externalCallId,
             toolName: outcome.pendingCall.toolName } }
```

### 8.8 Why `completedResults` stays empty

The Phase 3 Run invariant does not accept a partial Tool result batch at a `WAITING_APPROVAL` or
`BUDGET_EXCEEDED` boundary. Even when earlier Tools are already durably complete, the Run continuation
writes **no** partial model result. After approval resolution the batch re-runs, the durable coordinator
recovers the already-complete calls **without re-executing them**, and the complete batch is projected once,
in original order. Preserved exactly; asserted by "does not append partial results when a batch stops at
approval" and "resolves a durable approval and resumes the exact Tool boundary plus trailing calls".

### 8.9 `BUDGET_EXCEEDED` mapping

```ts
{ kind: "BUDGET_EXCEEDED", completedResults: [], block: outcome.block }
```

`outcome.items` is never persisted as a partial model result. A block whose `kind` is `UNAVAILABLE` rather
than `EXCEEDED` is an enforcement failure, not exhaustion, and is refused as a Run invariant violation
rather than recorded as a spent budget.

### 8.10 `CANCELLED` → Run cancellation authority

```text
CANCELLED + signal.aborted === true
    the adapter does not produce a ToolTurnResult. The run-scoped abort propagates out of the canonical
    batch call, and RunController.executeToolBatchDirective's existing
    `executionSignal.aborted → finalizeAbortedExecution` path settles the Run. The Tool System never
    writes a Run status.

CANCELLED + signal.aborted === false
    fail closed with RunControllerInvariantError. The frozen ToolTurnResult has five discriminants and
    CANCELLED is not one of them; every available forgery — COMPLETED, an error Tool result, an automatic
    Run cancel — would invent an authority that belongs to the user or the deadline.
```

`ToolTurnResult` was **not** modified and no `CANCELLED` discriminant was added. The architecture guard
asserts the absence of the word in the frozen contract file and in the adapter's produced kinds.

### 8.11 `RESOURCE_WAIT` and `REPLAN` preserved

Run resource governance is untouched and still Core-owned. `REPLAN` writes no Tool invocation at all, so
its synthetic results are now produced through the **same** canonical projector and normalizer rather than
through the retired Core feedback algorithm — one model-feedback authority, not a REPLAN-shaped second one.
`RESOURCE_WAIT` still returns `{ kind: "RESOURCE_WAIT", reason: "NO_PROGRESS" }` from the Core-private
observation's durable `replanCount`.

### 8.12 Phase 3 `ToolTurn` contracts unchanged

```text
ToolTurnRequest    mode, sourceStepId, pendingDecision, observationPolicy?, signal   UNCHANGED
ToolTurnResult     COMPLETED | WAITING_APPROVAL | BUDGET_EXCEEDED | RESOURCE_WAIT | REPLAN   UNCHANGED
```

`packages/agent/src/run/ports/tool-turn.ts` was not edited in this round. The architecture guard asserts the
request's exact five fields, the five discriminants, and that neither `CANCELLED`, `INFRASTRUCTURE_FAILURE`
nor `REJECTED` was added.

### 8.13 Resource progress compatibility and raw artifact recovery

Core keeps `RunToolTurnObservation` and its resource-progress fingerprinting. `rawObservationsOf` now reads
the **durable** `ToolObservation` the canonical batch carried (its `rawArtifactRef` and `invocationId`)
rather than a legacy model-facing result, so Core-private progress accounting reads canonical output. A
`REJECTED` or `SKIPPED` item contributes an external call id and nothing else, because a call that never ran
has no raw output and inventing a pointer would point a Context recovery at an artifact nobody wrote.

`rawArtifactRef` continues to live **inside** the durable `ToolObservation`. It is not put back into the AI
message; the Context recovery path resolves it from the durable Tool execution ledger, and the legacy
Context adapter re-attaches it onto its own Context-only message.

---

## 9. Daemon production composition

### 9.1 What the composition root now builds

```text
createToolCallPreparer(activeToolRegistry.agentRegistry(), { normalization })
createToolBatchCoordinator({ preparer, budget: toolBudgetAdmission,
                             durable: toolDurableCoordinator,
                             registry: activeToolRegistry.agentRegistry() })
createModelToolFeedbackProjector({ projection: toContextObservationProjection() })
createToolResultBatchNormalizer()
        ↓
{ batches, feedback, normalizer, modelDefinitions }  →  RunController.toolTurn
```

Exactly one of each, proven by `apps/daemon/test/tool-batch-production-composition.test.ts`.

### 9.2 Legacy production references, before → after

| Reference                                             | Before 4D                                                    | After 4D                                  |
| ----------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `new ToolBatchCoordinator(dispatcher)` in the daemon  | present                                                      | **removed**                               |
| `ToolBatchCoordinatorPort` named by Core              | present in `run-controller.ts` and `run-controller-ports.ts` | **removed**                               |
| `ToolBatchItemResult` named by Core                   | present in the adapter and the observation channel           | **removed**                               |
| `dispatcher.preflightBudget()` on the production path | present                                                      | **removed**                               |
| `toAgentToolResults()` on the production path         | present                                                      | **removed** (legacy facade retained)      |
| `normalizeToolResultBatch` Core implementation        | present                                                      | **delegates** to the canonical normalizer |
| `AgentToolResultBatchError` Core declaration          | present                                                      | **re-exported** from `@caelush/agent`     |
| `createV1SecureToolDispatcher(...)` in the daemon     | created but never referenced                                 | **removed**                               |

**The Dispatcher removal, stated explicitly.** In the 4C baseline the daemon created a
`ToolDispatcher` and referenced it exactly once — as the argument to the legacy batch coordinator — and
never exported it on `DaemonComposition`. With the canonical batch driving `toolDurableCoordinator`
directly, that facade became unreachable dead code, so the composition root no longer builds it. This is a
consequence of the cutover, not a scope expansion: the class is untouched, its direct API and its tests
still work, and Phase 4F owns its retirement.

### 9.3 Remaining compatibility surfaces and their exit round

| Surface                                                             | 4D status                                                                                        | Exit |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| `packages/tools/src/batch-coordinator.ts` `ToolBatchCoordinator`    | exists, unreferenced by production                                                               | 4F   |
| `packages/tools/src/batch-types.ts` legacy batch vocabulary         | exists for direct clients and tests                                                              | 4F   |
| `ToolDispatcher.dispatch` / `recoverOrDispatch` / `preflightBudget` | legacy direct API only                                                                           | 4F   |
| `ToolDispatcher.persistArgumentFailure`                             | retained for legacy compatibility tests and direct clients; **0 production ToolTurn references** | 4F   |
| `packages/core/src/agent-tool-batch.ts`                             | Context-projection adapter + legacy facade                                                       | 4F   |
| `packages/core/src/agent-tool-results.ts`                           | delegation to the canonical normalizer                                                           | 4F   |
| `ToolResultBatchConversionError`                                    | legacy conversion failure, no production producer                                                | 4F   |

### 9.4 Legacy direct API ≠ production Tool System V2

`ToolDispatcher.dispatch(...)` cannot express the new `REJECTED` semantics without breaking its own
historical return union, so its historical direct-call behaviour is retained deliberately.

```text
legacy direct API behavior  !=  production Tool System V2 behavior
```

The existence of that facade does **not** mean the 4D production cutover is incomplete.

---

## 10. Tests added

| Suite                          | File                                                                 | Tests                    |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------ |
| canonical batch                | `packages/agent/test/tool-batch-coordinator.test.ts`                 | 23                       |
| model feedback projector       | `packages/agent/test/model-tool-feedback-projector.test.ts`          | 26                       |
| result batch normalizer        | `packages/agent/test/tool-result-batch-normalizer.test.ts`           | 19                       |
| no-row rejection E2E           | `packages/storage/test/run-tool-turn-no-row-rejection.test.ts`       | 5                        |
| daemon composition             | `apps/daemon/test/tool-batch-production-composition.test.ts`         | 4                        |
| architecture guard             | `tests/architecture/phase-4d-tool-batch-feedback-boundaries.test.ts` | 18                       |
| extended: independent use      | `packages/agent/test/tools-independent-use.test.ts`                  | +1 (canonical batch E2E) |
| extended: ToolTurn integration | `packages/core/test/run-tool-turn-driver.test.ts`                    | +1 (RECOVER re-entry)    |

### 10.1 `tool-batch-coordinator.test.ts`

```text
empty batch rejected · duplicate externalCallId rejected before side effects
non-object / extra-field / malformed-call / missing-signal / malformed-environment rejected
preflight before the first handler · raw requested segment · full sequential event order
call_1 fully decided before call_2 prepared · one ordered OBSERVATION per call
whole-batch budget exceeded → BUDGET_EXCEEDED, zero items, zero execution
preflight throw → infrastructure failure
single-call budget block stops and keeps prior items
rejection → REJECTED with no durable call · rejected-then-valid executes the valid one
preparation throw → infrastructure failure, not a rejection
uncertain settlement → call_3/call_4 SKIPPED, exactly 2 handlers ran, safe bounded feedback
safe failure does not skip · WAITING_APPROVAL stops and never prepares trailing calls
pre-aborted signal → CANCELLED with no preflight/prepare/execute
abort after a prior item → CANCELLED with prior items
durable CANCELLED with and without an observation · ToolExecutionAbortedError → CANCELLED
durable coordinator throw → ToolBatchInfrastructureError with internal cause
the outcome union is closed at four arms
```

### 10.2 `model-tool-feedback-projector.test.ts`

```text
one message per call in original order · identity from the call, not from content
isError preserved per arm · empty batch
no rawArtifactRef / invocationId / details in the message
artifact pointer travels into the projection but never out
declaration names no raw result, no transient update, no stdout/stderr
missing / foreign / duplicate / reordered / name-mismatched item refused
projection returning the wrong count refused · unusable policy refused
one projection call with the exact policy and call-ordered candidates
projection dependency throw → infrastructure failure, not an error Tool result
single observation truncation · batch truncation with a floor per result
safe feedback bounded like an observation · multibyte code point never split
batch budget smaller than the result count refused · content that fits is untouched
project → normalize composition
```

### 10.3 `tool-result-batch-normalizer.test.ts`

```text
ordered input unchanged · out-of-order input reordered onto request order
content and isError preserved through reordering · empty batch
duplicate request id · 9 malformed results · duplicate result · unexpected result
missing result · tool name mismatch · empty results vs non-empty requests
empty requests vs a present result · bounded metadata with no raw content
no truncation and no sanitization · exactly one result per request · frozen output
```

### 10.4 `run-tool-turn-no-row-rejection.test.ts` (the round's most important acceptance)

The full production path over real SQLite, with a real `ToolDispatcher`-composed durable coordinator:

```text
unknown Tool          → no ToolInvocation, no observation, no approval, no handler,
                        AIToolResultMessage with the same id and name and isError true
invalid schema args   → same
oversized args        → same, with bounded feedback
[rejected, valid]     → 1 durable invocation for the valid call, both results in model order
the next AgentLoop turn receives the durable safe result
```

### 10.5 Failure injection covered

```text
batch input invalid                     ✔ tests/agent/tool-batch-coordinator
budget preflight throw                  ✔ same
preparer infrastructure throw           ✔ same
durable coordinator throw               ✔ same
durable Tool uncertain                  ✔ same
projector projection dependency throw   ✔ tests/agent/model-tool-feedback-projector
projector invalid item identity         ✔ same
normalizer missing result               ✔ tests/agent/tool-result-batch-normalizer
normalizer duplicate result             ✔ same
normalizer unexpected result            ✔ same
normalizer tool-name mismatch           ✔ same
cancellation during first call          ✔ tests/agent/tool-batch-coordinator
cancellation after prior calls          ✔ same
recovery of RUNNING Tool                ✔ tests/storage/run-controller-tool-integration
Run resource REPLAN                     ✔ tests/core/run-tool-turn-driver, run-tool-resource-governance
Run resource WAIT                       ✔ tests/core/run-tool-resource-governance
```

Each records the Tool execution count, the ToolInvocation count, the model result count, the Run outcome
and whether the error was model-visible; the no-row suite reads the counts from the real repositories.

---

## 11. Architecture guard

`tests/architecture/phase-4d-tool-batch-feedback-boundaries.test.ts` — 18 tests covering all 28 required
assertions:

```text
 1  packages/agent/src/tools/batch/**       does not import @caelush/tools
 2  packages/agent/src/tools/observation/** does not import @caelush/tools
 3  Agent batch does not import Core
 4  Agent batch does not import Context
 5  Agent observation does not import the Context implementation
 6  Agent batch does not import Coding Agent
 7  Agent batch does not import Storage
 8  Agent batch does not import Runtime
 9  canonical ToolBatchCoordinator declared only in Agent
10  canonical ModelToolFeedbackProjector declared only in Agent
11  canonical ToolResultBatchNormalizer declared only in Agent
12  production Run ToolTurn no longer imports legacy ToolBatchCoordinatorPort
13  production Daemon does not construct legacy ToolBatchCoordinator
14  production canonical Batch does not call ToolDispatcher
15  production model feedback does not call legacy toAgentToolResults()
16  production normalization does not call the legacy normalizeToolResultBatch implementation
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

Two further guards: the production path cannot reach `ToolDispatcher.persistArgumentFailure`, and no
production file outside `packages/tools` constructs or names the legacy batch coordinator.

### 11.1 Architecture baseline before → after

```text
                                  BEFORE              AFTER
baseline entries                  27                  27
new violations                    0                   0
stale baseline entries            0                   0
private production imports        0                   0
cross-workspace private imports   0                   0
readiness                         READY               READY
```

`baseline_after <= baseline_before`. The baseline was **not** regenerated, no broad exception was added and
no rule was disabled.

---

## 12. User-observable behaviour matrix: BEFORE 4D → AFTER 4D

| Scenario                    | BEFORE 4D                                           | AFTER 4D                                                      |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| all-valid batch             | legacy Batch → Core projection → Core normalization | canonical Batch → projector → normalizer                      |
| invalid Tool args           | FAILED `ToolInvocation` row; model-visible error    | `REJECTED`; **no durable row**; model-visible error           |
| unknown Tool                | legacy `UNAVAILABLE_TOOL` outcome                   | `REJECTED` (`TOOL_UNAVAILABLE`); no durable row               |
| safe Tool failure           | batch continues                                     | batch continues (unchanged)                                   |
| uncertain Tool failure      | trailing calls skipped                              | trailing `SKIPPED` (same semantics, canonical shape)          |
| approval required           | `WAITING_APPROVAL`, empty `completedResults`        | unchanged                                                     |
| approval recovery           | durable coordinator recovers; no re-execution       | unchanged, now via `batch.execute()`                          |
| budget preflight exceeded   | legacy helper, prepare-then-filter                  | frozen preflight over the raw calls, zero execution           |
| single-call budget exceeded | stop, empty results                                 | unchanged                                                     |
| Run cancellation            | batch returned `COMPLETED` on abort                 | batch returns `CANCELLED`; Run cancellation authority settles |
| Tool crash recovery         | uncertain recovery, executor calls 0                | unchanged                                                     |
| large Tool observation      | Context projection                                  | the same Context projection through the injected seam         |
| out-of-order result defense | Core `normalizeToolResultBatch`                     | canonical `ToolResultBatchNormalizer`                         |

### 12.1 Allowed deliberate semantic change

> **Production pre-invocation rejection no longer creates a durable `ToolInvocation` row.**

This is the frozen target and the formal close of the transition Phase 4A deferred to 4D. The model still
receives safe Tool result feedback with the original call identity and `isError: true`, but the durable
Tool ledger records no execution fact for a call that never executed. This is intentional, not a
regression, and it is proven by counting rows in real SQLite.

### 12.2 Behaviour that did not change

```text
Tool names · Tool order · Tool schemas · numeric normalization · Security admission
Approval identity · Approval recovery · single-call budget · Tool effects · AgentState effects
atomic settlement · raw artifact storage · uncertain semantics · idempotent recovery
model Tool result identity · Run lifecycle authority · Completion authority
```

---

## 13. Verification gates

```bash
pnpm build                    PASS
pnpm typecheck                PASS
pnpm lint                     PASS
pnpm check:architecture:ci    PASS — 27 baseline, 0 new, 0 stale, 0 private imports, READY
pnpm test                     PASS — 469 files, 2904 passed, 5 skipped, 0 failed
git diff --check              PASS — no whitespace errors
```

Formatting: changed files were checked with Prettier. The whole-repo `pnpm format:check` continues to
report the **pre-existing** CRLF / `core.autocrlf` condition that Phase 4C recorded; the repository was not
bulk-formatted, and no changed file introduced a new formatting defect.

### 13.1 Targeted verification runs

Each of these was run as its own focused invocation, in addition to the whole-suite gate:

```text
packages/agent batch tests                    PASS
packages/agent feedback tests                 PASS
packages/agent normalizer tests               PASS
packages/agent 4A–4C regression tests         PASS
packages/tools legacy batch/dispatcher tests  PASS
packages/core ToolTurn tests                  PASS
packages/core Tool result tests               PASS
packages/core RunController Tool integration  PASS
packages/context observation projection tests PASS
packages/storage durable Tool tests           PASS
apps/daemon composition tests                 PASS
Phase 3 architecture guards                   PASS
Phase 4A architecture guard                   PASS
Phase 4B architecture guard                   PASS
Phase 4C architecture guard                   PASS
Phase 4D architecture guard                   PASS
```

### 13.2 Process flakiness

Phase 4C recorded real process-environment flakiness under clean full-suite high load (managed shell,
Anthropic dialect, repository-wide boundary scan). This round did **not** auto-ignore anything. No flake
was observed in the final full-suite run, and no test was deleted, skipped, or given a lowered timeout to
hide one. The repository-wide boundary scan in particular was fast and stable.

Three genuine test failures were found and fixed during the round, each by correcting a stale assertion
rather than by weakening it: the Phase 3D, Phase 4C and Phase 12A architecture guards asserted that the
daemon still composed the legacy Dispatcher. Those assertions encoded the 4C baseline, so they were
updated to assert the 4D cutover instead.

### 13.3 Browser smoke

Not required and not performed: this round changes no Web UI, no public SSE, no client API and no browser
route. The only `apps/web` touch was its pre-existing build step in `pnpm build`, which passed unchanged.

---

## 14. Clean checkout verification

Performed from the pushed 4D remote branch in an independent checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm check:architecture:ci
```

plus the canonical batch suite, the model feedback suite, the normalizer suite, the ToolTurn integration
suite, the no-row rejection E2E, the uncertain skip E2E and the recovery E2E.

Results are recorded in §16.

---

## 15. Git commits

```text
feat(agent): own canonical tool batch coordination
feat(agent): own tool feedback projection and result normalization
refactor(core): cut production tool turn over to the canonical batch
refactor(daemon): compose canonical tool batch pipeline
test(architecture): guard phase 4d batch and feedback authorities
docs(architecture): record phase 4d migration
```

Each commit is auditable and self-contained. No force push, no `merge master`, no rebase of 4A/4B/4C, no
rewrite of old commits, no release, no deploy and no package publish was performed.

---

## 16. Final verification record

```text
Base SHA                    d340f909b052920804addccfc4726615cf837238
Branch                      deepseek/architecture-v2-phase-4d-batch-feedback-toolturn-cutover
Verified code head          recorded in the commit below
Final branch tip            identical to the verified code head
Remote parity               local tip == origin tip
Working tree                clean
Architecture baseline       27 → 27, 0 new, 0 stale, READY
Full suite                  469 files, 2904 passed, 5 skipped, 0 failed
```

---

## 17. Remaining work after 4D

### Phase 4E — NOT STARTED

```text
the nine builtins (read_file, list_directory, find_files, search_text, apply_patch,
                   exec_command, write_stdin, git_status, git_diff) → coding-agent
ReadFileOperations / ListDirectoryOperations / FindFilesOperations / SearchTextOperations
PatchOperations / ExecOperations / ProcessOperations / GitOperations
Runtime Operations adapters
Coding security metadata
Coding effects final ownership
Coding presentation
prompt snippets
actual builtin transient updates
```

Not one of these was created, moved or migrated in this round. The guard asserts that no Operations
interface exists anywhere in production source.

### Phase 4F — NOT STARTED

```text
final daemon assembly cleanup
legacy compatibility retirement
packages/tools deletion decision
protocol.ToolDefinition retirement
whole Tool System acceptance
```

`packages/tools` still exists. `protocol.ToolDefinition` still exists. No legacy export was deleted.

---

## 18. Phase 4D COMPLETE gate

Every condition of the authorising prompt's completion gate is satisfied:

```text
canonical ToolBatchCoordinator exists                                  ✔ packages/agent/src/tools/batch/
production ToolTurn uses canonical Batch                               ✔ run-tool-turn-coordinator.ts
production does not construct legacy ToolBatchCoordinator              ✔ daemon composition
canonical Batch does not use ToolDispatcher                            ✔ guard assertion
ToolCallPreparer REJECTED creates no ToolInvocation                    ✔ measured against real SQLite
REJECTED still reaches model as safe Tool result                       ✔ E2E next-AgentLoop assertion
uncertain execution skips remaining calls                              ✔ canonical batch tests
skipped calls create no invocation                                     ✔ canonical batch tests
batch remains strictly sequential                                      ✔ loop + no-Promise.all guards
canonical ToolResultBatchNormalizer exists                             ✔ tools/observation/
canonical ModelToolFeedbackProjector exists                            ✔ tools/observation/
raw AgentToolResult never enters model feedback                        ✔ declaration + behaviour guards
transient ToolExecutionUpdate never enters model feedback              ✔ declaration guards
model result identity preserved                                        ✔ projector tests
model result order preserved                                           ✔ projector + normalizer tests
observation policy enforced                                            ✔ bound tests
Core no longer owns second normalization algorithm                     ✔ delegation
Core no longer owns second model-feedback algorithm                    ✔ delegation + adapter
RECOVER does not re-execute RUNNING Tool                               ✔ storage recovery suites
WAITING_APPROVAL partial model results remain empty                    ✔ completedResults: []
BUDGET_EXCEEDED partial model results remain empty                     ✔ completedResults: []
ToolTurnRequest unchanged                                              ✔ file untouched, guard asserted
ToolTurnResult unchanged                                               ✔ file untouched, guard asserted
RunController remains cancellation authority                           ✔ aborted → finalizeAbortedExecution
4A contracts unchanged                                                 ✔ guard asserted
4B contracts unchanged                                                 ✔ guard asserted
4C contracts unchanged                                                 ✔ guard asserted
no 4E builtins migration                                               ✔ guard asserts nine still legacy
no 4F compatibility deletion                                           ✔ guard asserts packages/tools intact
all verification gates pass                                            ✔ §13
remote parity verified                                                 ✔ §16
```

---

**Phase 4D COMPLETE.**
**Phase 4E has not started.**
**Phase 4F has not started.**
