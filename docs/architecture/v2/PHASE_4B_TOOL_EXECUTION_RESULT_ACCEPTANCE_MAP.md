# Caelush Architecture V2 — Phase 4B Tool Execution & Result Acceptance Map

```text
PHASE 4B — Tool Invocation Executor, Result Pipeline & Safe Transient Updates
base      Phase 4A tip  d74156f5e93d0e509b7e079d924fc56049edefe7
branch    deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline
```

This map is the per-clause record of what 4B implemented, where the authority now lives, what stays
legacy and which round takes the rest. It is written against the frozen Tool System V2 contracts and
the current Phase 4A source, and every clause names its test evidence.

---

## A. Frozen scope of 4B

```text
1  ToolInvocationExecutor            invoke an already-durably-started ToolInvocation
2  ToolResultPipeline                validate -> sanitize -> revalidate -> bound -> project
3  Safe transient update path        ToolExecutionUpdate lifetime, sanitization, ordering, drain
```

Plus the delegation that makes the legacy shell stop owning an execution or a result algorithm, and
the composition wiring that binds the canonical pair in production.

---

## B. Explicit non-goals

```text
4C   ToolAdmissionCoordinator, ToolAdmissionPort cutover, approval coordinator, budget coordinator,
     ToolSettlementCoordinator, DurableToolExecutionCoordinator, ToolExecutionStorePort migration,
     storage import ownership, atomic settlement redesign, WAITING_APPROVAL lifecycle, RUNNING recovery
4D   batch coordinator rewrite, ToolResultBatchNormalizer, ModelToolFeedbackProjector, production
     ToolTurn rewiring, the pre-invocation rejection no-row cutover, batch result ordering
4E   the nine Coding builtins, Operations ports, Runtime adapters, Coding effects/presentation/prompt
4F   deleting packages/tools or protocol.ToolDefinition, final daemon cleanup, declaring Tool V2 done
```

Also out of scope: parallel Tool execution, `terminate: true`, MCP, Skills, Browser, Web Search,
Computer Use, Multi-Agent, remote Runtime, an OS sandbox redesign, any new DB table or migration, any
new Protocol version, Run status or ToolInvocation status.

**The Phase 4A transition difference is deliberately NOT fixed here.** The canonical Preparer rejects
an invalid or unavailable pre-invocation call without creating a ToolInvocation; the legacy production
shell still persists its historical argument failure. Switching that is a 4D acceptance item.

---

## C. Current execution call graph (before 4B)

```text
ToolDispatcher.dispatch / recoverOrDispatch
  └─ ToolPreflight (legacy facade)                        resolve + normalize + validate
       └─ ToolDispatcher.dispatchLocked
            ├─ createRequestedToolInvocation + commit      REQUESTED, tool.requested
            ├─ applyGate                                   Security facts + Gate
            │    ├─ REQUIRE_APPROVAL → WAITING_APPROVAL / run grant
            │    └─ DENY → persistFailure
            └─ startAndExecute
                 ├─ budget.admit → BUDGET_EXCEEDED
                 ├─ startToolInvocation + commit            RUNNING, tool.started, budget start
                 └─ executeHandler
                      └─ resolvedTool.handler.execute(...)   ← the execution authority, legacy
```

## D. Current result-processing call graph (before 4B)

```text
executeHandler
  ├─ validateToolExecutionResult(raw, resolvedTool, outputPolicy)      shape + budget + schema
  ├─ rawOutputStore.createOrGet(raw content)                          raw artifact
  ├─ resultSanitizer.sanitize(...) → validateToolExecutionResult(...)  sanitize + revalidate
  ├─ resolvedTool.effectProjector(...) → ToolEffect[]                  Coding effects
  └─ terminal invocation + observation + events + effects + commit     atomic settlement
```

Both algorithms lived inside one `executeHandler` method: shape reading, the details budget, the
schema call, the sanitize-then-revalidate sequence, the generic content bound, and the effect
projection.

## E. Current update capability

```text
none.  AgentToolExecutionInput.updates existed as a frozen 4A contract, and no production path ever
       constructed a sink.  A Tool could not publish progress, and there was no sanitizer, no
       ordering, no orphan rule and no drain.
```

---

## F. Current file → target owner

| Current file                                     | Current responsibility           | 4B owner                  | Migration action          |
| ------------------------------------------------ | -------------------------------- | ------------------------- | ------------------------- |
| `agent/tools/execution/invocation-executor.ts`   | _(new)_                          | `@caelush/agent`          | ADD                       |
| `agent/tools/execution/update-sanitizer-port.ts` | _(new)_                          | `@caelush/agent`          | ADD                       |
| `agent/tools/execution/execution-disposition.ts` | _(new)_                          | `@caelush/agent`          | MOVE + OWN                |
| `agent/tools/result/result-policy.ts`            | _(new)_                          | `@caelush/agent`          | ADD                       |
| `agent/tools/result/result-sanitizer-port.ts`    | _(new)_                          | `@caelush/agent`          | ADD                       |
| `agent/tools/result/result-validator.ts`         | _(new)_                          | `@caelush/agent`          | MOVE + SHRINK             |
| `agent/tools/result/result-pipeline.ts`          | _(new)_                          | `@caelush/agent`          | ADD                       |
| `tools/src/result-validation.ts`                 | shape + budget + schema + bound  | facade                    | DELEGATE                  |
| `tools/src/output-policy.ts`                     | UTF-8 content bound              | facade                    | DELEGATE                  |
| `tools/src/result-sanitizer.ts`                  | sanitizer port declaration       | facade                    | RE-EXPORT                 |
| `tools/src/execution-disposition.ts`             | uncertainty constant + predicate | facade                    | RE-EXPORT                 |
| `tools/src/errors.ts`                            | `ToolExecutionUncertainError`    | facade                    | RE-EXPORT                 |
| `tools/src/dispatcher.ts`                        | execution + result algorithm     | durable shell             | DELEGATE                  |
| `tools/src/settlement-extension-bridge.ts`       | _(new)_                          | legacy Coding composition | ADD (bridge)              |
| `security/src/tool-update-sanitizer.ts`          | _(new)_                          | `@caelush/security`       | ADD (port implementation) |
| `security/src/default-composition.ts`            | dispatcher composition           | host composition          | REWIRE                    |
| `apps/daemon/src/daemon-composition.ts`          | daemon composition               | host                      | REWIRE                    |

## G. Compatibility bridge and H. exit round

| Responsibility                     | Before 4B                                                  | After 4B                                                                           | Compatibility reason                                                    | Exit round                                    |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `AgentTool.execute` invocation     | `ToolDispatcher.executeHandler` called `handler.execute()` | canonical `ToolInvocationExecutor` calls `AgentTool.execute`                       | legacy `ToolHandler` still exists for the nine builtins                 | 4E moves the builtins; 4F removes the adapter |
| execution exception classification | dispatcher `catch` around `handler.execute`                | executor classifies; shell maps to durable failure                                 | durable failure codes must not change                                   | 4C                                            |
| `UNCERTAIN_SIDE_EFFECT`            | `packages/tools` owned the error class                     | `@caelush/agent` owns it; legacy re-exports                                        | existing builtins import the legacy name; identity must not split       | 4F                                            |
| safe update sink                   | did not exist                                              | executor constructs it per invocation                                              | —                                                                       | 4E wires real builtin progress                |
| update sanitizer                   | did not exist                                              | `ToolExecutionUpdateSanitizerPort` + a Security implementation                     | reuse existing redaction primitives, no Security V2                     | 4E                                            |
| late/orphan update suppression     | did not exist                                              | `acceptingUpdates` closes on settle                                                | —                                                                       | —                                             |
| pending update drain               | did not exist                                              | drain after settle, before return or throw                                         | terminal lifecycle must follow accepted updates                         | —                                             |
| result shape validation            | `tools/result-validation.ts`                               | `agent/tools/result/result-validator.ts`                                           | legacy entry still exported                                             | 4F                                            |
| result details schema validation   | legacy `outputValidator` call                              | canonical `resultValidator` from the registry                                      | the validator is still the legacy-bound one until 4E/4F                 | 4E                                            |
| result sanitizer port              | declared in `tools`                                        | declared in `agent`; `security` implements it                                      | one declaration, one implementation                                     | 4F                                            |
| sanitize → revalidate              | inside `executeHandler`                                    | inside the canonical pipeline                                                      | settlement gate must not weaken                                         | —                                             |
| content bounding                   | `tools/output-policy.ts`                                   | `agent/tools/result/result-policy.ts`                                              | legacy helper delegates                                                 | 4F                                            |
| details byte bounding              | legacy validator                                           | canonical validator                                                                | same value, same semantics                                              | —                                             |
| effect projection bridge           | `resolvedTool.effectProjector` called inline               | opaque `ToolSettlementExtension` produced after sanitization, decoded by the shell | atomic settlement must not degrade; Agent must not learn Coding effects | 4E owns Coding effects                        |
| `PreparedToolSettlement`           | did not exist                                              | canonical settlement DTO                                                           | —                                                                       | 4C consumes it                                |
| durable terminal lifecycle         | `executeHandler`                                           | unchanged                                                                          | RUNNING-before-execute and atomic commit are invariants                 | 4C                                            |

---

## I. Frozen clause → implementation → test

| Spec §          | Frozen contract                                   | Implementation                                                      | Test                                                                     |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Freeze §110     | `ToolExecutionUpdateSanitizerPort`                | `agent/tools/execution/update-sanitizer-port.ts`                    | `tool-invocation-executor`, `tool-execution-result-composition`          |
| Freeze §111     | `ToolInvocationExecutor`                          | `agent/tools/execution/invocation-executor.ts`                      | `tool-invocation-executor`                                               |
| Freeze §112     | orphan update rule; drain before terminal         | `createUpdatePipeline`                                              | `tool-invocation-executor`                                               |
| Freeze §113     | `ToolResultLimits`                                | `agent/tools/result/result-policy.ts`                               | `tool-result-pipeline`                                                   |
| Freeze §114     | durable result limit vs model observation limit   | `ToolResultLimits.maxDurableContentBytes`                           | `tool-result-pipeline`, `phase-4b` guard                                 |
| Freeze §115     | `ToolResultSanitizerPort`                         | `agent/tools/result/result-sanitizer-port.ts`                       | `tool-result-pipeline`, `tool-execution-result-composition`              |
| Freeze §116     | `PreparedToolSettlement`                          | `agent/tools/result/result-pipeline.ts`                             | `tool-result-pipeline`                                                   |
| Freeze §117     | `ToolSettlementExtension`                         | `agent/tools/result/result-policy.ts`                               | `tool-result-pipeline`                                                   |
| Freeze §118     | settlement extension seam                         | `tools/settlement-extension-bridge.ts`                              | `tool-execution-delegation`, `tool-execution-result-composition`         |
| Freeze §119     | `ToolResultPipeline` and its fixed order          | `agent/tools/result/result-pipeline.ts`                             | `tool-result-pipeline`                                                   |
| Freeze §120     | sanitizer failure is infrastructure               | `ToolExecutionInfrastructureError` phase `RESULT_PIPELINE`          | `tool-result-pipeline`                                                   |
| Freeze §123     | atomic settlement compatibility exception         | shell commits terminal + observation + effects + events in one call | `storage/tool-dispatcher-integration`, `run-controller-tool-integration` |
| Freeze §127     | `ToolExecutionInfrastructureError.phase`          | `agent/tools/types/errors.ts`                                       | `tool-invocation-executor`, `tool-result-pipeline`                       |
| Freeze §128     | `UNCERTAIN_SIDE_EFFECT`                           | `agent/tools/execution/execution-disposition.ts`                    | `tool-invocation-executor`, `tool-execution-delegation`                  |
| Freeze §173–177 | error philosophy, feedback content                | executor classification; shell content                              | `tool-invocation-executor`                                               |
| Freeze §181     | update sanitization + drop on failure             | executor update pipeline                                            | `tool-invocation-executor`                                               |
| Freeze §182     | update vs final sanitizer failure                 | drop vs `RESULT_PIPELINE` throw                                     | `tool-invocation-executor`, `tool-result-pipeline`                       |
| Freeze §184     | safe durable observation may exceed model summary | `maxDurableContentBytes` naming                                     | `phase-4b` guard                                                         |
| Freeze §218     | architecture tests                                | `tests/architecture/phase-4b-*`                                     | itself                                                                   |
| Freeze §220     | Preparer tests                                    | `packages/agent/test/tools-call-preparation.test.ts` (4A)           | 4A                                                                       |
| Freeze §223     | executor update tests                             | `tool-invocation-executor`                                          | itself                                                                   |
| Freeze §224     | result pipeline tests                             | `tool-result-pipeline`                                              | itself                                                                   |
| Spec §38        | RUNNING durable before execute                    | `startAndExecute` commits before `executeHandler`                   | `tool-execution-delegation`, `phase-4b` guard                            |
| Spec §54        | safe failure vs infrastructure failure            | executor + shell classification                                     | `tool-invocation-executor`                                               |
| Spec §69–70     | sequential first, `PARALLEL_SAFE` reserved        | no scheduler added                                                  | `phase-4b` guard                                                         |

---

## J. Phase 3 invariants: affected / not affected

| Phase 3 frozen item                                                                     | 4B effect                                                                  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ToolTurnCoordinator`, `ToolTurnRequest`, `ToolTurnResult`                              | **not affected** — structurally unchanged, guard-asserted                  |
| `AgentToolResult` (model-visible, four fields)                                          | **not affected** — the root keeps the Phase 3 declaration and the 4A alias |
| `AgentLoop`, `AgentLoopAdvanceResult`, `ModelTurnExecutor`                              | **not affected**                                                           |
| `RunExecutionCoordinator`, `RunExecutionDirective`, `RunExecutionDriver(+Dependencies)` | **not affected**                                                           |
| `RunExecutionEffectContext`, `RunExecutionEffectResult`, `RunTransitionPlanner`         | **not affected**                                                           |
| `RunContinuationCheckpoint`                                                             | **not affected** — no new continuation, no discriminant                    |
| `CompletionGate(+Input/Decision)`                                                       | **not affected** — no Tool touches completion                              |
| Durable event sequence and shapes                                                       | **not affected** — same events, same order, same atomic commit             |
| ToolInvocation lifecycle and persistence                                                | **not affected** — RUNNING still precedes execution                        |

## K. Phase 4A invariants that must remain true

```text
AgentTool extends AIToolSpec with label/resultDetailsSchema/executionMode/prepareArguments/execute
AgentTool carries no risk level, capability, runtime requirement, projector, presentation or snippet
ResolvedAgentTool has exactly three fields: tool, inputValidator, resultValidator
AgentToolRegistry.modelSpecs() projects exactly name, description, inputSchema
ToolCallPreparationOutcome has exactly READY and REJECTED
an unexpected prepareArguments throw is infrastructure, not REJECTED
packages/tools delegates instead of owning a second implementation
the Coding overlay lives in @caelush/coding-agent and is keyed by the registry's ToolName
```

Every one of these is asserted by the Phase 4B guard as well, so 4B cannot erode 4A by accident.

---

## L. Verification nodes

| #   | Requirement                                | Status                         |
| --- | ------------------------------------------ | ------------------------------ |
| 1   | canonical `ToolInvocationExecutor`         | met                            |
| 2   | production delegation to it proven         | met — behaviour + static guard |
| 3   | canonical `ToolResultPipeline`             | met                            |
| 4   | production delegation to it proven         | met — behaviour + static guard |
| 5   | safe transient update semantics proven     | met                            |
| 6   | late update suppressed                     | met                            |
| 7   | no second execution implementation         | met — no legacy branch exists  |
| 8   | no second result-processing implementation | met                            |
| 9   | `UNCERTAIN_SIDE_EFFECT` preserved          | met                            |
| 10  | validate → sanitize → revalidate preserved | met                            |
| 11  | atomic settlement not degraded             | met — one commit, unchanged    |
| 12  | Phase 3 contracts unchanged                | met                            |
| 13  | Phase 4A contracts unchanged               | met                            |
| 14  | all verification gates pass                | see the report                 |
| 15  | remote push verified                       | see the report                 |
