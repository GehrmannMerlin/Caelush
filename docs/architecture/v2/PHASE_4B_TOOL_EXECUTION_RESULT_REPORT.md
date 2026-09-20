# Caelush Architecture V2 — Phase 4B Tool Execution & Result Report

```text
PHASE 4B — Tool Invocation Executor, Result Pipeline & Safe Transient Updates
branch    deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline
base      Phase 4A tip  d74156f5e93d0e509b7e079d924fc56049edefe7
```

Phase 4B is the second of the six frozen Phase 4 rounds. It moved **the execution of an already
durably-started Tool invocation** and **the processing of its result** out of the legacy
`ToolDispatcher` into `@caelush/agent`, and established the safe transient update path those two
components need.

It did **not** build admission, approval, budget coordination, settlement, the durable coordinator,
the batch layer, model feedback, the nine Coding builtins, their Operations, or the production
cleanup. Those are 4C, 4D, 4E and 4F.

---

## 1. Phase identity and the fixed six rounds

```text
4A  Tool contracts, general Registry, schema, call preparation, Coding catalog foundation, legacy entry adaptation
4B  Invocation Executor, Result Pipeline, Safe Transient Updates
4C  Admission, Approval/Budget, Settlement, Durable Coordinator, Storage atomic-commit adaptation
4D  Batch, Model Feedback, Result Normalizer, production ToolTurn wiring
4E  All nine Coding builtins, Operations, Runtime adapters, Coding metadata/effects/presentation/prompt
4F  Final production assembly, legacy production dependency removal, compatibility retirement, whole-phase acceptance
```

Frozen in [PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md](PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md), which now also
carries the 4A and 4B completion references. No `4B-1`, no `4B-2`, no `4G`, no cleanup round, and no
part of 4C–4F implemented early.

---

## 2. Baseline, branch, SHAs

|                                           | Value                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Repository                                | `D:/Develop/Caelush`                                                        |
| Ancestry base                             | `d74156f5e93d0e509b7e079d924fc56049edefe7` (the Phase 4A remote branch tip) |
| Ancestry verified                         | `git merge-base --is-ancestor <base> HEAD` exit 0                           |
| Starting branch                           | `deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation`      |
| Starting working tree                     | clean                                                                       |
| 4B branch on the remote before this round | absent (`git ls-remote --heads` returned nothing)                           |
| Working branch                            | `deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline`          |
| Code head                                 | `246bb7ff2eddffda0d639c7dda852ce679e028a2`                                  |
| Remote                                    | `https://github.com/GehrmannMerlin/Caelush.git`                             |

The base is the Phase 4A **tip**, not the Phase 4A verified code head
(`f5850101e3ebb352df24f8419a9f015dbbe91482`): the three commits after the code head are the Phase 4A
documentation-only delivery revisions, and they are preserved rather than discarded.

---

## 3. Specifications actually read

Read in full from their saved paths, not from excerpts:

```text
Caelush_Tool_System_V2_Refactor_Spec.md                        4015 lines
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md   6196 lines
```

Read from the repository at the 4B baseline:

```text
AGENTS.md
docs/architecture/v2/MIGRATION_EXECUTION_CONTRACT.md
docs/architecture/v2/PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md
docs/architecture/v2/PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md
docs/architecture/v2/PHASE_4A_TOOL_FOUNDATION_REPORT.md
docs/architecture/v2/PHASE_3F_AGENT_LOOP_CLOSURE_REPORT.md
docs/architecture/v2/PHASE_3_AGENT_LOOP_MIGRATION_SUMMARY.md
docs/architecture/v2/PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md
docs/architecture/v2/PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md
scripts/architecture/v2-rules.mjs
scripts/architecture/legacy-import-baseline.json
```

No required document was missing, so no frozen clause was guessed.

---

## 4. Source areas actually scanned

```text
packages/agent/src/tools/** and packages/agent/src/index.ts
packages/tools/src/dispatcher.ts, dispatcher-types.ts, dispatcher-errors.ts, dispatcher-ports.ts,
  handler.ts, execution-result.ts, result-validation.ts, result-sanitizer.ts, output-policy.ts,
  errors.ts, execution-disposition.ts, tool-adapters.ts, tool-system-bridge.ts, registration.ts,
  registry.ts, registry-builder.ts, preflight.ts, tool-effects.ts, event-factory.ts,
  invocation-lifecycle.ts, observation.ts, index.ts
packages/security/src/tool-result-sanitizer.ts, default-composition.ts, secret-redaction.ts,
  sensitive-path.ts, index.ts
packages/events/src/event-bus.ts, event-stream.ts
packages/storage/src/tool-execution-store.ts and its committed migrations
apps/daemon/src/daemon-composition.ts, daemon.ts
every test under packages/tools/test, packages/security/test, packages/storage/test,
  packages/core/test and apps/daemon/test that constructs a dispatcher or asserts a result
```

The scan answered each question the round asked of it:

| Question                                     | Answer at the baseline                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| who calls `handler.execute()`                | `ToolDispatcher.executeHandler`, and only there in production      |
| who calls `AgentTool.execute()`              | nobody                                                             |
| who calls `validateToolExecutionResult()`    | `ToolDispatcher.executeHandler`, plus its own test                 |
| who calls `resultSanitizer.sanitize()`       | `ToolDispatcher.executeHandler`                                    |
| who bounds content                           | `tools/output-policy.ts`, reached from the legacy validator        |
| who projects `ToolEffect`                    | `ToolDispatcher.executeHandler` via `resolvedTool.effectProjector` |
| who recognizes `ToolExecutionUncertainError` | `ToolDispatcher.executeHandler`                                    |
| who holds `UNCERTAIN_SIDE_EFFECT`            | `packages/tools/errors.ts` + `execution-disposition.ts`            |
| who writes terminal tool events              | `executeHandler` + `event-factory.ts`                              |
| who commits durably                          | `ToolDispatcher.commitAndNotify` → `ToolExecutionStorePort.commit` |

## 5. Document/source divergence

Recorded per clause in the acceptance map §1 and §F. Nothing required a guess; the three findings
that shaped the work were:

```text
1  the frozen ToolInvocationExecutor input carries ToolExecutionIdentity, not a ToolInvocation, while
   the update sanitizer port needs the invocation — resolved with an invocation-bound factory rather
   than by widening either frozen contract
2  the effect projection has to keep settling atomically, and the Agent layer must not learn Coding
   effects — resolved with the frozen opaque ToolSettlementExtension seam
3  the legacy shell writes its own bounded failure observations on paths that never reach a Tool, so
   the durable result bound stays reachable from the shell even though the pipeline owns bounding
```

---

## 6. Before/after responsibility inventory

| Responsibility                                         | Before 4B                                                  | After 4B                                           | Legacy reason                                         | Exit    |
| ------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- | ------- |
| `AgentTool.execute` invocation                         | `ToolDispatcher.executeHandler` called `handler.execute()` | `ToolInvocationExecutor` calls `AgentTool.execute` | the nine builtins are still legacy handlers           | 4E / 4F |
| execution input construction                           | inline in the shell                                        | canonical executor                                 | —                                                     | —       |
| execution exception classification                     | shell `catch`                                              | executor; shell maps to the durable code           | failure codes must not change                         | 4C      |
| `UNCERTAIN_SIDE_EFFECT`                                | owned by `packages/tools`                                  | owned by `@caelush/agent`, re-exported             | builtins import the legacy name                       | 4F      |
| safe transient update sink                             | did not exist                                              | executor-built per invocation                      | —                                                     | —       |
| update sanitizer                                       | did not exist                                              | Agent port + Security implementation               | reuses existing redaction                             | 4E      |
| late update suppression                                | did not exist                                              | `acceptingUpdates` closes on settle                | —                                                     | —       |
| pending update drain                                   | did not exist                                              | drained before return or throw                     | terminal lifecycle ordering                           | —       |
| result shape validation                                | `tools/result-validation.ts`                               | `agent/tools/result/result-validator.ts`           | legacy entry still exported                           | 4F      |
| result details schema validation                       | legacy `outputValidator`                                   | canonical `resultValidator`                        | the validator is the legacy-bound one                 | 4E      |
| result sanitizer port                                  | declared in `tools`                                        | declared in `agent`                                | one declaration, one implementation                   | 4F      |
| sanitize → revalidate                                  | inside `executeHandler`                                    | inside the canonical pipeline                      | settlement gate must not weaken                       | —       |
| content bounding                                       | `tools/output-policy.ts`                                   | `agent/tools/result/result-policy.ts`              | legacy helper delegates                               | 4F      |
| details byte bounding                                  | legacy validator                                           | canonical validator                                | same value and semantics                              | —       |
| effect projection                                      | `effectProjector` called inline                            | opaque extension, decoded by the shell             | atomic settlement must not degrade                    | 4E      |
| raw output artifact                                    | shell                                                      | shell (unchanged)                                  | storage-owned, and the pipeline must not know storage | 4C      |
| terminal lifecycle, observation, events, atomic commit | shell                                                      | shell (unchanged)                                  | RUNNING-before-execute and atomicity are invariants   | 4C      |
| admission, approval, budget                            | shell                                                      | shell (unchanged)                                  | —                                                     | 4C      |
| batch and model feedback                               | `ToolBatchCoordinator` + Core                              | unchanged                                          | —                                                     | 4D      |
| the nine builtins and their Operations                 | `packages/tools`                                           | unchanged                                          | —                                                     | 4E      |

---

## 7. `ToolInvocationExecutor`: the exact implementation

```text
packages/agent/src/tools/execution/invocation-executor.ts
```

Public contract, frozen and asserted field by field:

```ts
export interface ToolInvocationExecutor {
  execute(input: {
    readonly call: PreparedToolCall;
    readonly identity: ToolExecutionIdentity;
    readonly environment: ToolExecutionEnvironment;
    readonly signal: AbortSignal;
  }): Promise<AgentToolResult>;
}
```

Nothing else is in the shape: no `ToolInvocation`, no storage, no security context, no approval, no
budget, no event bus, no Run or Session object, no `RuntimeWorkspaceScope`.

What `execute` does, in order:

```text
1  assert identity.invocationId === bound invocation.id
        identity.runId        === invocation.runId
        identity.sourceStepId === invocation.stepId
        identity.externalCallId === invocation.externalCallId
   → mismatch: ToolExecutionInfrastructureError("EXECUTION"), before any Tool code
2  build the update pipeline (accepting, sanitizing, ordered, dropping)
3  call call.resolved.tool.execute({ identity, args: call.args, environment, signal, updates })
4  on settle: close update acceptance, drain everything already accepted
5  return the raw AgentToolResult, or throw a classified failure
```

The binding to a durable invocation is an **implementation seam**, not part of the public shape:
`createToolInvocationExecutor({ invocation, updateSanitizer, transientUpdates, diagnostics })`
returns an object satisfying the frozen interface. The sanitizer port needs `invocation` because
redaction depends on the Tool's identity and arguments; the frozen executor input deliberately does
not carry it; so the layer that owns the durable row binds it. `@caelush/agent` never loads a
`ToolInvocation` from storage.

---

## 8. How the production path reaches it

```text
ToolDispatcher.startAndExecute()
  ├─ budget.admit
  ├─ startToolInvocation + commit          ← durable RUNNING, tool.started  (unchanged)
  └─ ToolDispatcher.executeHandler()
       ├─ build ToolExecutionIdentity from the durable invocation and the caller's session
       ├─ this.options.execution.invocationExecutorFactory({ invocation, updateSanitizer })
       ├─ executor.execute({ call, identity, environment, signal })
       │     └─ AgentTool.execute(...)
       ├─ raw artifact compatibility (raw execution content, unchanged)
       ├─ this.options.execution.resultPipelineFactory({ invocation, environment }).process(...)
       │     └─ validate → sanitize → revalidate → bound → project the extension
       ├─ decode the opaque settlement extension into ToolEffect[]
       └─ terminal lifecycle + observation + events + effects + ONE atomic commit  (unchanged)
```

The `execution` option group is **required**, not optional, and its three parts — the executor
factory, the update sanitizer and the result pipeline factory — arrive together. There is therefore no
legacy execution branch in the shell at all, and a composition cannot half-migrate it.

`packages/security/src/default-composition.ts` is the only production construction of a
`ToolDispatcher` (guard-asserted), and it binds:

```text
invocationExecutorFactory   createToolInvocationExecutor, invocation-bound
updateSanitizer             the caller's sanitizer (the daemon passes CaelushToolExecutionUpdateSanitizer)
resultPipelineFactory       createToolResultPipeline with CaelushToolResultSanitizer, the mapped limits
                            and createLegacyToolSettlementExtensionProjector
outputPolicy                the durable result bound, also used by the shell's own failure observations
```

## 9. How legacy `ToolHandler` compatibility works

```text
ToolRegistryBuilder.register({ definition, handler })
  └─ resolveAgentToolRegistration
       └─ no adapters.agent ? createLegacyExecute(handler) : the supplied AgentTool
            └─ AgentTool.execute(input) → handler.execute({
                 runId, stepId, invocationId, externalCallId, args, environment, signal
               })
```

The handler receives exactly the semantics it always did — the same normalized, frozen arguments, the
same environment locator, the same identity fields and the caller's signal. `updates` is a canonical
addition a legacy handler cannot publish through, so the adapter neither forwards it nor fabricates
anything in its place. The ordering is `ToolInvocationExecutor → canonical AgentTool.execute → legacy
adapter → legacy ToolHandler`, never `ToolDispatcher → ToolHandler`.

---

## 10. Update sanitizer

```ts
export interface ToolExecutionUpdateSanitizerPort {
  sanitize(input: {
    readonly toolName: ToolName;
    readonly invocation: ToolInvocation;
    readonly update: ToolExecutionUpdate;
  }): ToolExecutionUpdate | null;
}
```

`null` means drop. The production implementation is
`packages/security/src/tool-update-sanitizer.ts` (`CaelushToolExecutionUpdateSanitizer`), a
compatibility port implementation, **not** Security V2 and not the Security Gate:

```text
shape check          a malformed or unknown update kind is dropped
absolute-path guard  a Windows drive, UNC or POSIX host path is dropped, before and after redaction
secret redaction     the same redactText primitives the final result sanitizer uses
byte bound           8 KiB, far below the durable result bound
```

File-content policy (`search_text` matches, `git_diff` bodies) is deliberately absent: it needs the
Tool's arguments and its structured match list, which an update does not carry. A stronger update
policy would need information this layer does not have, and inventing it would be the permissive
fallback the port forbids.

## 11. Update queue semantics

```text
publish(raw)                                   synchronous, returns immediately
  │ acceptingUpdates === false → drop, reason ORPHAN
  ▼
sanitizer.sanitize(...)
  │ null       → drop, reason SANITIZER_REJECTED
  │ throws     → drop, reason SANITIZER_FAILED, cause kept in diagnostics
  ▼
chain = chain.then(() => consumer.publish(sanitized)).catch(report)
```

One promise chain per invocation serializes delivery, so the accepted order is the observed order
without making a Tool's `publish` asynchronous. A consumer failure is caught on the chain, reported to
diagnostics, and cannot change the Tool result or break the ordering of the updates that follow.

## 12. `acceptingUpdates` lifecycle

```text
executor.execute() begins            acceptingUpdates = true
AgentTool promise settles (resolve
or reject)                           acceptingUpdates = false
```

`close()` is called in a `finally`-equivalent position: the same statement runs on both the resolved
and the rejected path, before the drain and before the executor returns or throws.

## 13. Late/orphan update proof

`packages/agent/test/tool-invocation-executor.test.ts`:

```text
"silently ignores an update published after the Tool promise settled"
  the Tool captures its sink, publishes once, returns; the test then publishes through the captured
  sink → the consumer received exactly one update and diagnostics recorded exactly one ORPHAN
"silently ignores an update published after a rejected Tool promise"
  the Tool captures its sink and throws; after the rejection the test publishes → the consumer
  received nothing
```

An orphan never reaches the consumer, never changes the result, never changes the invocation and never
produces a durable event — there is no code path from `publish` to any of those.

## 14. Drain-before-return proof

`packages/agent/test/tool-invocation-executor.test.ts`:

```text
"drains accepted updates before resolving the execution result"
  a consumer that takes 10 ms; the Tool publishes then returns; the test asserts the observed order is
  ["update-delivered", "executor-returned"]
"drains accepted updates before throwing an execution failure"
  the Tool publishes then throws; the failure is classified; the update was still delivered first
"does not make the Tool wait for a slow consumer"
  a 50 ms consumer; the Tool's `publish` returns synchronously before the delivery finishes
```

The shell writes `tool.completed` / `tool.failed` only after `executeHandler` returns, so an accepted
update can never appear after a terminal lifecycle event.

## 15. Does production UI consume updates yet?

**No.** The daemon composes `CaelushToolExecutionUpdateSanitizer` with
`DISCARDING_TOOL_UPDATE_CONSUMER`:

```text
4B establishes update execution semantics, the sanitizer port, the safe queue, the late suppression,
   the drain and an injectable transient consumer.
4E wires actual Coding builtin progress into that channel.
Later UI/product integration owns presentation transport (SSE, timeline, CLI).
```

Nothing in this round claims that `exec_command` streams to a UI, and no Protocol, SSE, HTTP, Client or
Web surface was touched.

---

## 16. `ToolResultPipeline`: the exact implementation

```text
packages/agent/src/tools/result/{result-policy,result-sanitizer-port,result-validator,result-pipeline}.ts
```

```ts
export interface ToolResultPipeline {
  process(input: {
    readonly call: PreparedToolCall;
    readonly invocation: ToolInvocation;
    readonly rawResult: AgentToolResult;
    readonly now: TimestampMs;
  }): PreparedToolSettlement;
}
```

The frozen internal order, implemented literally:

```text
① exact result shape validation
② details is a JSON object
③ details byte budget
④ resultDetailsSchema validation
⑤ defensive copy / freeze
⑥ sanitize
⑦ exact result shape re-validation
⑧ sanitized details byte budget
⑨ resultDetailsSchema re-validation
⑩ bound content to maxDurableContentBytes
⑪ project the optional settlement extension
⑫ return an immutable PreparedToolSettlement
```

`process` is synchronous and total over its declared input. Its options are a sanitizer, limits and an
extension projector — there is no storage, event bus, model, context engine, approval store or budget
ledger to reach.

## 17. Result validation ownership

```text
shape reader      agent/tools/result/result-validator.ts  (one declaration, guard-asserted)
details budget    the same module, measured with the canonical serialized UTF-8 byte length
schema check      input.resolved.resultValidator.validate(...)  — the validator compiled at registry
                  build in Phase 4A; no compiler is created and no schema is recompiled here
copy and freeze   cloneJsonValue + deepFreezeJson, so the durable value is the pipeline's own
```

The runtime check is not redundant with the TypeScript type: `execute()` is a declaration and a Tool
is an untrusted execution boundary. A missing field, an extra field, a wrong type, an array or null
`details`, a thenable, or a class instance carrying the right fields are all refused.

## 18. Sanitizer ownership

```text
agent/tools/result/result-sanitizer-port.ts   declares ToolResultSanitizerPort
security/src/tool-result-sanitizer.ts         implements it (CaelushToolResultSanitizer)
tools/src/result-sanitizer.ts                 re-exports the declaration, one interface only
```

`@caelush/agent` imports no redaction implementation, and the guard asserts it.

## 19. Revalidation proof

The sanitizer's output is put through the **full** contract again, not a `content` presence check:
shape, JSON-object `details`, the details byte budget, the result schema, the copy and the bound.

```text
"re-validates what the sanitizer returned: an introduced schema error is caught"     DETAILS_SCHEMA
"re-validates the sanitized shape: a dropped field is caught"                        SHAPE
"re-validates the sanitized details budget: a ballooned payload is caught"           DETAILS_BUDGET
```

A sanitizer is not a trusted transform: it can drop a required field, add an extra one, or return
details that no longer satisfy the Tool's own schema.

## 20. UTF-8 bounding ownership

```text
agent/tools/result/result-policy.ts   boundToolResultContent  (one implementation, guard-asserted)
tools/src/output-policy.ts            boundToolModelContent   → delegates, converts the policy
```

The unit is UTF-8 bytes, never `String.length`. The prefix is grown one code point at a time, so the
result can never end in a lone surrogate. The marker is `"\n[output truncated]"`; when the marker
itself cannot fit inside the budget, the longest whole-character prefix is returned without it.

Covered for ASCII, Chinese, emoji, multibyte truncation, the marker fitting, the marker not fitting,
and the exact byte boundary:

```text
"keeps the exact byte boundary, the marker and the no-marker fallback"       ("hello", "中文"→"中", →"")
"bounds content at a whole-character UTF-8 boundary and marks it"            (encodeURIComponent safe)
"truncates at UTF-8 boundaries and states that output was truncated"         (legacy output-policy)
```

## 21. The `ToolSettlementExtension` bridge

```text
canonical ToolResultPipeline
  └─ opaque { kind: "caelush.coding.effects.v1", payload: { effects: [...] } }
       ├─ produced by createLegacyToolSettlementExtensionProjector   (legacy composition)
       └─ decoded by ToolDispatcher.legacyEffectsFromSettlement      (legacy shell)
            └─ existing ToolEffect[] → existing atomic settlement
```

The Agent layer declares its own generic constant, never imports `ToolEffect`, and never compares an
extension kind (guard-asserted). Exactly two production modules outside the Agent layer resolve the
Coding constant: the bridge that produces it and the shell that decodes it.

The projection runs **after** sanitization and revalidation, so it only ever observes a result that is
known safe to commit, and it receives the same `now` the settlement uses. A projector that throws
leaves the invocation `RUNNING` for uncertain recovery rather than producing state that disagrees with
the workspace.

Atomicity is untouched: the decoded effects reach the **same single** `commit` call as the terminal
invocation, the observation and the events. There is no path where the terminal invocation commits and
effects are applied in a second transaction.

---

## 22–26. Error semantics

| Situation                                                  | Result                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AgentTool` returns `isError: false`                       | normal pipeline, `COMPLETED` invocation, `tool.completed`                                                                   |
| `AgentTool` returns `isError: true`                        | safe Tool error result, `FAILED` invocation, `tool.failed`, failure memory recorded                                         |
| `AgentTool` throws the canonical uncertain error           | rethrown by the executor; shell settles `FAILED` with `executionDisposition: "UNCERTAIN_SIDE_EFFECT"`                       |
| a legacy-shaped uncertain error (disposition, not message) | mapped onto the canonical class, same disposition; never guessed from text                                                  |
| `AgentTool` throws anything else                           | `ToolExecutionInfrastructureError` phase `EXECUTION`; shell persists `RUNTIME_ERROR` then throws                            |
| raw result bad shape                                       | `ToolResultValidationError` `SHAPE` → shell persists `TOOL_OUTPUT_ERROR` then throws `RESULT_PIPELINE`                      |
| raw details bad schema                                     | `ToolResultValidationError` `DETAILS_SCHEMA` → same path                                                                    |
| raw details oversized                                      | `ToolResultValidationError` `DETAILS_BUDGET` → same path                                                                    |
| sanitizer throws                                           | `ToolExecutionInfrastructureError` `RESULT_PIPELINE`; **no** fatal persist, **no** unsanitized fallback, no `isError: true` |
| sanitizer returns a broken result                          | revalidation failure, same contract-violation path                                                                          |
| extension projector throws                                 | `ToolExecutionInfrastructureError` `RESULT_PIPELINE`                                                                        |
| update sanitizer throws                                    | that update is dropped; the Tool continues and the result is unaffected                                                     |

The two durable outcomes are deliberately different and were preserved: a result **contract
violation** settles the invocation as a fatal `TOOL_OUTPUT_ERROR` and then throws, while a
**sanitizer/pipeline infrastructure** failure throws without settling, leaving the durable boundary
as it found it. Merging them would have changed what a restart discovers.

---

## 27. Dispatcher responsibilities removed

```text
direct AgentTool / handler execution
the execution input construction
the update lifecycle (it never had one; it has none now)
result exact-shape algorithm
result details-schema algorithm
result sanitizer orchestration
sanitize → revalidate
generic content bounding
the `resultSanitizer` option itself
```

Guard-asserted by scoping `executeHandler`: no `handler.execute`, no `acceptingUpdates`, no
`updateSanitizer.sanitize`, no `resultSanitizer`, no `ToolExecutionResultValidationError`, no
`validateToolExecutionResult(`, no `boundToolResultContent`, no `outputValidator.validate`.

## 28. Dispatcher responsibilities intentionally retained

```text
idempotency and recovery routing          failure memory
REQUESTED invocation creation              Security gate and security facts
approval handling                          budget admission, start and settle
the RUNNING transition and its commit      the raw output artifact
the terminal invocation transition         the observation
durable event creation                     the effect decode and the settlement extension decode
the single atomic commit                   the budget settle and the failure-memory record
```

Not bugs: each has a fixed exit round.

## 29. Exit round for every remaining legacy responsibility

| Responsibility                                                                                            | Exit round |
| --------------------------------------------------------------------------------------------------------- | ---------- |
| admission, gate orchestration, security facts projection                                                  | 4C         |
| approval coordination and `WAITING_APPROVAL` lifecycle                                                    | 4C         |
| budget coordination                                                                                       | 4C         |
| settlement coordinator and the `ToolExecutionStorePort` migration                                         | 4C         |
| durable coordinator, `RUNNING` recovery, atomic settlement redesign                                       | 4C         |
| batch coordinator, result normalizer, model feedback projector                                            | 4D         |
| production `ToolTurn` rewiring and the pre-invocation rejection no-row cutover                            | 4D         |
| the nine builtins, Operations, Runtime adapters, Coding effects/presentation/prompt, real update delivery | 4E         |
| `packages/tools` and `protocol.ToolDefinition` deletion, the last facades                                 | 4F         |

---

## 30. Production behaviour comparison

| Observable                             | Before 4B                              | After 4B                                                        |
| -------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| nine Tool names and order              | unchanged                              | unchanged                                                       |
| provider-visible input schemas         | unchanged                              | unchanged                                                       |
| result-details schemas                 | unchanged                              | unchanged                                                       |
| numeric string compatibility           | unchanged                              | unchanged (canonical Preparer, one implementation)              |
| default limits                         | 64 KiB content, 256 KiB details        | same values, named `maxDurableContentBytes` / `maxDetailsBytes` |
| Security policy and gate               | unchanged                              | unchanged (still 9A–9D)                                         |
| approval flow                          | unchanged                              | unchanged                                                       |
| budget flow                            | unchanged                              | unchanged                                                       |
| durable invocation rows                | unchanged                              | unchanged                                                       |
| observation shape and content          | unchanged                              | unchanged                                                       |
| durable event sequence                 | unchanged                              | unchanged                                                       |
| Tool effects and AgentState projection | unchanged                              | unchanged (through the opaque extension)                        |
| failure memory                         | unchanged                              | unchanged                                                       |
| raw output artifacts                   | raw execution content                  | unchanged                                                       |
| batch sequential semantics             | unchanged                              | unchanged                                                       |
| `UNCERTAIN_SIDE_EFFECT`                | `FAILED` + disposition                 | unchanged                                                       |
| sanitizer failure durability           | throws, no settle                      | unchanged                                                       |
| result contract violation              | fatal `TOOL_OUTPUT_ERROR`, then throws | unchanged                                                       |
| transient updates                      | none possible                          | possible, sanitized, ordered, dropped by default                |

**One deliberate behaviour difference**, and it is not user-observable in the current composition:
`ToolDispatcherOptions.outputPolicy` moved into the required `execution` group, and the pipeline
receives its limits from there. A host that constructed a dispatcher directly must now express the
whole execution dependency group. Every production and test construction site was updated; the effect
is a composition-shape change, not a Tool behaviour change.

**One newly covered behaviour**: the canonical executor refuses an identity that does not match the
bound invocation before any Tool code runs. Nothing could produce such a mismatch before, and nothing
can now; the check exists so a future pipeline cannot execute a Tool under a foreign identity.

---

## 31. Tests added

| Suite                                                                  | Tests | What it establishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/test/tool-invocation-executor.test.ts`                 | 19    | the canonical AgentTool is called with the exact identity, args, environment and signal; `isError` results are results; unknown and synchronous throws become `EXECUTION`; the uncertain error keeps its disposition and is recognized structurally; identity mismatch fails before execution; updates are sanitized, dropped on rejection, dropped on failure, ordered, non-blocking, drained before return and before throw, and orphaned after settle; a consumer failure is observational; the discarding consumer is the default |
| `packages/agent/test/tool-result-pipeline.test.ts`                     | 27    | exact shape (extra, missing, mistyped, array/null details, thenable, class instance); details budget; result schema; the sanitizer receives name + invocation + validated result; revalidation of shape, budget and schema; the sanitizer failure path and the absence of any fallback; the opaque extension seam and its throw; the frozen limits; the standalone helpers; UTF-8 byte boundaries                                                                                                                                     |
| `packages/tools/test/tool-execution-delegation.test.ts`                | 7     | the production shell reaches the canonical AgentTool (and not the handler) when one is registered; a legacy handler is reached only through the adapter with its original semantics; identity and args are the durable ones; the update path is reached with nothing delivered by default; `UNCERTAIN_SIDE_EFFECT` survives; an unknown throw persists `RUNTIME_ERROR`; the legacy result-validation entry point answers identically                                                                                                  |
| `apps/daemon/test/tool-execution-result-composition.test.ts`           | 7     | the production composition binds the canonical pair; the real `CaelushToolResultSanitizer` redacts through the port; the update sanitizer redacts a credential and drops a host path; the nine defaults are unchanged; the `resultSanitizer` option is gone from the dispatcher surface                                                                                                                                                                                                                                               |
| `tests/architecture/phase-4b-tool-execution-result-boundaries.test.ts` | 14    | the structural guards listed in §33                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Totals for the round: **74 new tests**.

## 32. Failure injection

```text
AgentTool synchronous-looking async throw      covered ("synchronous throw" / "unexpected throw")
AgentTool promise reject                       covered
uncertain execution throw                      covered (canonical and legacy-shaped)
update sanitizer throw                         covered
transient consumer reject                      covered
late update callback                           covered (after resolve and after reject)
raw result malformed                           covered (9 shape variants + a class instance)
raw result oversized                           covered (details budget)
sanitizer throw                                covered
sanitizer schema corruption                    covered (dropped field, wrong type, oversized details)
extension projector throw                      covered
identity mismatch                              covered
```

## 33. Architecture guards added

`tests/architecture/phase-4b-tool-execution-result-boundaries.test.ts`:

```text
the executor and result layers import no tools/coding-agent/security/storage/runtime/core/context/
  verification/events/llm, no host app and no node:fs or node:child_process
the executor declares exactly four input fields and mentions no approval, budget, commit, storage,
  Run status, completion, verification, batch or observation vocabulary, and calls
  call.resolved.tool.execute
the result pipeline, policy and validator mention no storage, event bus, publish, notify, Run
  controller, approval, budget, model or context
exactly one module declares each frozen interface; exactly one declares the shape reader; exactly one
  declares the content bound; no result module creates or recompiles a schema
the update path keeps its accepting flag, its three drop reasons, its ordered chain and its drain, and
  has no raw-fallback sink
no durable module consumes or imports a transient update; the update type is reachable only from the
  Agent execution/type layers, the Security port implementation and type barrels
the legacy shell requires the canonical execution group and its executeHandler region contains none of
  the removed algorithms; the legacy result modules delegate rather than reimplement
the uncertainty constant and error are declared once, in the Agent layer, and recognition is
  structural rather than message-based
no result/execution module introduces Promise.all, a worker or a coordinator class; no migration file
  mentions the new contracts
Phases 3 and 4A are structurally unchanged
the Agent layer names the generic extension constant and never branches on a Coding effect kind;
  exactly two legacy modules resolve it
the security composition is the only production dispatcher construction and it binds the pair
```

One existing guard widened by exactly the Phase 4B names, with the reason recorded inline:
`phase-2c-model-authority-boundaries` (the deliberate Agent root export surface).

## 34. Architecture baseline before/after

```text
                                 before   after
rule set version                 2        2
active rules                     276      276
workspace projects               21       21
scanned source files             601      610
parsed module specifiers         3077     3133
workspace source edges           495      509
workspace manifest edges         61       62
legacy violations frozen         31       31
baseline entries                 31       31
new violations                   0        0
stale baseline entries           0        0
private subpath imports          0        0
cross-project relative imports   0        0
readiness                        READY    READY
```

The baseline did not grow and was not regenerated. No entry was removed, because this round resolved
no dependency edge — it moved code and added an allowed edge (`security → agent`).

---

## 35–41. Verification gates

```text
pnpm build                    exit 0
pnpm typecheck                exit 0
pnpm lint                     exit 0
pnpm check:architecture:ci    exit 0   boundaries PASS · verify PASS · readiness READY
pnpm test                     exit 0   458 files · 2733 passed · 5 skipped · 0 failed
git diff --check              exit 0
changed-file format check     all matched files use Prettier code style (LF-normalized comparison)
```

`pnpm format:check` over the whole repository still fails for pre-existing files this round never
touched, for the recorded reason: `core.autocrlf=true` checks files out with CRLF while Prettier
expects LF. No unrelated file was reformatted.

### 41.1 Baseline differences

The Phase 4A report recorded 453 files / 2659 passed / 5 skipped. This round records 458 files / 2733
passed / 5 skipped: five new suites, 74 new tests, and no previously passing test removed or skipped.

---

## 42. Clean-checkout verification

Reproduced in an isolated directory, cloned from the remote at
`246bb7ff2eddffda0d639c7dda852ce679e028a2`:

```text
git clone --branch deepseek/architecture-v2-phase-4b-... --single-branch    exit 0
pnpm install --frozen-lockfile                                              exit 0
pnpm build                                                                  exit 0
pnpm typecheck                                                              exit 0
pnpm check:architecture:ci                                                  exit 0
  boundaries PASS · verify PASS · readiness READY · 31 baseline entries · 0 new · 0 stale
7 key suites (79 tests)                                                     exit 0
```

The clean environment reported no new problem, so the whole suite was not re-run there.

### 42.1 Browser smoke

Not required and not run: this round touches no Web UI, no public SSE contract and no browser control
flow. The daemon composition change is limited to the Tool execution dependency group. Something did
touch those paths incidentally — `apps/daemon/test/agent-tool-round-trip-wire.test.ts` is a wire
contract test, not a browser flow — and it was updated with the same canonical execution binding as
every other dispatcher construction site, then re-run green.

---

## 43. Git delivery

```text
base                    d74156f5e93d0e509b7e079d924fc56049edefe7
branch                  deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline
code head               246bb7ff2eddffda0d639c7dda852ce679e028a2
remote                  https://github.com/GehrmannMerlin/Caelush.git
remote branch           refs/heads/deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline
remote parity           `git ls-remote origin <branch>` equals local HEAD
tracking                origin/deepseek/architecture-v2-phase-4b-tool-execution-result-pipeline
working tree            clean
```

The four commits, in order:

```text
e60f899  feat(agent): own tool invocation execution and result processing
d478207  refactor(tools): delegate execution and result processing to the canonical agent
9ad49fa  test(architecture): guard the Phase 4B execution and result boundaries
246bb7f  docs(architecture): record the Phase 4B execution and result migration
```

No merge, no force push, no rebase, no rewrite of any Phase 1–4A commit, no automatic merge into
`master`/`main`, and nothing deployed, released or published. A documentation-only delivery note
follows the code head and changes no source file.

### 43.1 Environment adaptation

As in earlier rounds, this host reaches GitHub through a local HTTP proxy that git does not read by
default, so the proxy was passed per command rather than written into the repository or the user's git
configuration. No credential appears in any command, log or document. `rg` is installed but is not on
this shell's `PATH`, so suites that shell out to the fixed ripgrep backend were run with its directory
prepended for that command.

---

## 44. Work not started

```text
4C  ToolAdmissionCoordinator, the admission port cutover, approval coordination, budget coordination,
    ToolSettlementCoordinator, DurableToolExecutionCoordinator, the ToolExecutionStorePort migration,
    the atomic-settlement redesign, the WAITING_APPROVAL lifecycle, RUNNING recovery
4D  the new ToolBatchCoordinator, ToolResultBatchNormalizer, ModelToolFeedbackProjector, the
    production ToolTurn rewiring, the pre-invocation rejection no-row cutover, batch result ordering
4E  the nine builtins, ReadFile/ListDirectory/FindFiles/SearchText/Patch/Exec/Process/Git Operations,
    the Runtime adapters, Coding metadata/effects/presentation/prompt, real transient update delivery
4F  final production assembly, legacy production dependency removal, facade retirement, deleting
    packages/tools or protocol.ToolDefinition, whole-phase acceptance
```

Also untouched: parallel Tool execution, `Promise.all` batch execution, `terminate: true`, MCP,
Skills, Browser, Web Search, Computer Use, Multi-Agent, Sub-Agent, remote Runtime, an OS sandbox
redesign, and any new DB table, DB migration, Protocol version, Run status or ToolInvocation status.

---

## 45. Verdict

```text
Phase 4B — Tool Invocation Executor, Result Pipeline & Safe Transient Updates: COMPLETE
Phase 4C has not started.
```

What 4B owns, and what it explicitly does not:

```text
@caelush/agent OWNS   AgentTool, AgentToolRegistry, ToolCallPreparer,
                      ToolInvocationExecutor, the tool execution update lifecycle,
                      ToolResultPipeline, ToolResultSanitizerPort, ToolResultLimits,
                      ToolSettlementExtension, the canonical uncertainty vocabulary

@caelush/agent does NOT own yet
                      admission orchestration, approval, budget, durable settlement, batch,
                      model feedback, the Coding builtins, Operations

@caelush/tools        still owns the durable shell, admission/gate, approval, budget, settlement,
                      batch, the builtins and the Coding effect vocabulary, but no longer owns an
                      execution algorithm, a result-processing algorithm or a generic result bound
```

Not claimed: Tool System V2 complete, a Durable Tool Execution Coordinator, admission or approval
migration, batch migration, builtin migration, real Coding builtin progress in a UI, parallel
execution, or any 4C–4F work.