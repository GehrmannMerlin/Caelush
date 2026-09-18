# Caelush Architecture V2 — Phase 4A Tool Contract Acceptance Map

```text
PHASE 4A — Tool contracts, canonical registry, schema, call preparation, Coding catalog foundation
baseline  Phase 3F  b96e25ed90b289b36123de8f048506318bc28e5d
branch    deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
```

This map is the per-clause record of what 4A implemented, where it lives, what is still legacy, and
which later round takes the rest. Every clause names the specification section it comes from and the
test that carries the evidence.

---

## 1. Spec baseline versus implementation baseline

The two Tool documents were scanned at `master @ c5489f75a243193c9832a9f15875d9e41d8b6810`. The
implementation baseline is Phase 3F, `b96e25ed90b289b36123de8f048506318bc28e5d`. The differences
below were read from source, not inferred from either report.

| Spec statement                                                   | Source reality at Phase 3F                                                                                               | 4A disposition                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `packages/tools/src/index.ts` exports the whole Tool System      | true; the file exports 202 lines of contract                                                                             | kept as the compatibility surface; content re-pointed at the target implementations                                  |
| `AgentToolResult` is the raw execution result                    | Phase 3 already froze a _different_ `AgentToolResult` in `packages/agent/src/run/ports/tool-turn.ts` and root-exports it | both names kept; the Tool System declaration is published under the explicit `AgentToolExecutionResult` alias (§3)   |
| `ToolCallPreparer` is a new component                            | no Preparer existed; `ToolPreflight` and `validateToolArguments` did the work                                            | Preparer implemented; legacy entries delegate to it (§4)                                                             |
| `AgentToolRegistry` replaces `ToolRegistry`                      | `ToolRegistry`/`ToolRegistryBuilder` were the only registry                                                              | canonical registry implemented; legacy is a facade over it (§5)                                                      |
| `schema-runtime.ts` / `schema-policy.ts` are Tool System modules | they live in `packages/tools` and compile with one AJV policy                                                            | moved into `@caelush/agent`; the legacy modules re-export (§6)                                                       |
| `CodingToolDefinition.tool`                                      | no such contract existed; `ToolRegistration.definition` carried Coding metadata _inside_ the definition                  | implemented in `@caelush/coding-agent`; legacy registration metadata classified beside the AgentTool (§7)            |
| Registry options are `maxResultSchemaBytes`                      | the legacy option is `maxOutputSchemaBytes`, same value 16384                                                            | two facets of one budget: the legacy name stays valid, the canonical name is what the canonical validator reads (§8) |
| Tool System V2 is a target architecture                          | Phase 3D already froze a `ToolTurnCoordinator` whose production implementation is a Phase 3D Core adapter                | untouched; 4A changes no Phase 3 interface (§12)                                                                     |
| a full durable Tool pipeline exists                              | it does not; the legacy `ToolDispatcher` still owns it                                                                   | explicitly **not** claimed; 4B–4D own it (§11)                                                                       |

Two further divergences are worth recording because they are easy to get wrong:

```text
1  `packages/tools` is inside the workspace's legacy set. A legacy package may depend on a target
   one (legacy → target), so the facade imports `@caelush/agent` statically and reaches
   `@caelush/coding-agent` through a cached dynamic import. The reverse edge stays forbidden and is
   guard-enforced.

2  The legacy package's `maxOutputSchemaBytes` is the only place the old name survives. The frozen
   default values are unchanged: 64 / 8192 / 5000 / 16384 / 262144.
```

---

## 2. Contract acceptance map

Legend: **4A** = implemented this round; **compat** = legacy compatibility retained this round;
**4B–4F** = owned by that round.

| Spec §          | Frozen contract                                                  | Target file                                                                    | Public export                         | Compatibility entry                                  | 4A                    | Later                  | Test evidence                                         |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------- | --------------------- | ---------------------- | ----------------------------------------------------- |
| Freeze §75      | `ToolExecutionMode`                                              | `agent/src/tools/types/execution-mode.ts`                                      | `@caelush/agent` root                 | —                                                    | 4A                    | —                      | `tools-independent-use` (mode declared, no scheduler) |
| Freeze §76      | `ToolExecutionIdentity`                                          | `agent/src/tools/types/execution-identity.ts`                                  | root                                  | legacy flat request fields                           | 4A                    | —                      | `tools-call-preparation`, `tool-system-delegation`    |
| Freeze §77      | `ToolExecutionUpdate`                                            | `agent/src/tools/types/tool-update.ts`                                         | root                                  | —                                                    | 4A (types)            | 4B (sink)              | `tools-independent-use`                               |
| Freeze §78      | `ToolExecutionUpdateSink`                                        | same                                                                           | root                                  | —                                                    | 4A (type)             | 4B (impl)              | —                                                     |
| Freeze §79      | `AgentToolExecutionInput`                                        | `agent/src/tools/types/execution-input.ts`                                     | root                                  | `ToolExecutionRequest`                               | 4A                    | —                      | `tools-independent-use`                               |
| Freeze §80      | required `AbortSignal`                                           | same                                                                           | root                                  | legacy optional `signal`                             | 4A                    | —                      | `tools-independent-use`                               |
| Freeze §81      | `AgentToolResult<TDetails>`                                      | `agent/src/tools/types/tool-result.ts`                                         | root alias `AgentToolExecutionResult` | `ToolExecutionResult` alias                          | 4A                    | —                      | `tools-call-preparation` (§3)                         |
| Freeze §82      | `AgentTool` (extends `AIToolSpec`)                               | `agent/src/tools/types/agent-tool.ts`                                          | root                                  | legacy `ToolDefinition` + handler                    | 4A                    | —                      | `tools-registry`, `phase-4a` guard                    |
| Freeze §83      | fields `AgentTool` must not carry                                | same                                                                           | —                                     | —                                                    | 4A                    | —                      | `phase-4a` guard                                      |
| Freeze §84      | `prepareArguments` contract                                      | same                                                                           | root                                  | legacy numeric normalization                         | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §85      | `ToolArgumentPreparationError`                                   | `agent/src/tools/types/errors.ts`                                              | root                                  | legacy `ToolValidationError`                         | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §86      | `ToolFailureDisposition`                                         | `agent/src/tools/types/tool-feedback.ts`                                       | root                                  | —                                                    | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §87      | `ToolFailureFeedback`                                            | same                                                                           | root                                  | legacy error message text                            | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §88      | `CodingToolSecurityMetadata`                                     | `coding-agent/src/tools/security-metadata.ts`                                  | `@caelush/coding-agent` root          | `ToolDefinition` metadata fields                     | 4A                    | 4E (facts)             | `coding-tool-catalog`                                 |
| Freeze §89      | `CodingToolDefinition`                                           | `coding-agent/src/tools/coding-tool-definition.ts`                             | root                                  | `ToolRegistration`                                   | 4A                    | —                      | `coding-tool-catalog`, `phase-4a` guard               |
| Freeze §90      | `ResolvedAgentTool`                                              | `agent/src/tools/registry/registry.ts`                                         | root                                  | `ResolvedTool`                                       | 4A                    | —                      | `tools-registry`                                      |
| Freeze §91      | `AgentToolRegistry`                                              | same                                                                           | root                                  | `ToolRegistry`                                       | 4A                    | —                      | `tools-registry`                                      |
| Freeze §92      | model-spec projection                                            | `agent/src/tools/registry/registry-builder.ts`                                 | root                                  | `modelDefinitions()`                                 | 4A                    | —                      | `tools-registry`, `phase-4a` guard                    |
| Freeze §93      | `AgentToolRegistryBuilder`                                       | same                                                                           | root                                  | `ToolRegistryBuilder`                                | 4A                    | —                      | `tools-registry`                                      |
| Freeze §94      | `CodingToolCatalog`                                              | `coding-agent/src/tools/coding-tool-catalog.ts`                                | root                                  | legacy catalog metadata                              | 4A                    | 4E (builtins)          | `coding-tool-catalog`                                 |
| Freeze §95      | `ToolCallRequest`                                                | `agent/src/tools/call/tool-call-preparer.ts`                                   | root                                  | `ToolDispatchRequest`                                | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §96      | `PreparedToolCall`                                               | same                                                                           | root                                  | `ToolPreflightResult`                                | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §97      | `ToolCallPreparationOutcome` (READY/REJECTED)                    | same                                                                           | root                                  | legacy `UNAVAILABLE_TOOL`/`INVALID_ARGUMENTS` arms   | 4A                    | —                      | `tools-call-preparation`                              |
| Freeze §98      | pre-invocation rejection creates **no** Invocation               | `agent/src/tools/call/tool-call-preparer-impl.ts`                              | —                                     | legacy dispatcher still persists an argument failure | 4A (target semantics) | 4D (production switch) | `phase-4a` guard, `tool-composition-delegation`       |
| Freeze §99      | `ToolCallPreparer`                                               | same                                                                           | root                                  | `ToolPreflight`                                      | 4A                    | —                      | `tools-call-preparation`, `tool-system-delegation`    |
| Freeze §100–101 | `ToolDurableMetadata` / port                                     | —                                                                              | —                                     | —                                                    | —                     | 4C                     | —                                                     |
| Freeze §102–109 | admission, approval, budget, coordinator                         | —                                                                              | —                                     | legacy dispatcher                                    | —                     | 4C                     | —                                                     |
| Freeze §110–112 | executor, sanitizer port, orphan rule                            | —                                                                              | —                                     | —                                                    | —                     | 4B                     | —                                                     |
| Freeze §113–120 | result limits, sanitizer, pipeline                               | —                                                                              | —                                     | legacy `result-validation`                           | —                     | 4B                     | —                                                     |
| Freeze §121–128 | store snapshot, commit, settlement, infrastructure error         | `ToolExecutionInfrastructureError` + `ToolPreparationInfrastructureError` only | root                                  | —                                                    | 4A (error base)       | 4C                     | `tools-call-preparation`                              |
| Freeze §129–137 | durable request/outcome/coordinator/recovery                     | —                                                                              | —                                     | legacy dispatcher                                    | —                     | 4C                     | —                                                     |
| Freeze §138–144 | batch item/request/outcome/coordinator, parallel freeze          | —                                                                              | —                                     | legacy `ToolBatchCoordinator`                        | —                     | 4D                     | —                                                     |
| Freeze §145–149 | observation policy, feedback projector, update exclusion         | —                                                                              | —                                     | legacy Core projection                               | —                     | 4D                     | —                                                     |
| Freeze §150–152 | durable and transient event freeze                               | —                                                                              | —                                     | legacy event factory                                 | —                     | 4B/4D                  | —                                                     |
| Freeze §153–156 | Coding effect contract and projector                             | `CodingToolEffectProjector` (contract only)                                    | `@caelush/coding-agent` root          | `ToolEffectProjector`                                | 4A (contract)         | 4E                     | `coding-tool-catalog`                                 |
| Freeze §157     | `ToolPresentation`                                               | `agent/src/tools/types/tool-presentation.ts`                                   | root                                  | `@caelush/tools` re-export                           | 4A                    | 4E                     | `presentation-boundary` (legacy)                      |
| Freeze §158–159 | prompt snippet, prompt context provider                          | `CodingToolDefinition.promptSnippet` only                                      | root                                  | model guidance                                       | 4A (field)            | 4E                     | `coding-tool-catalog`                                 |
| Freeze §160–172 | Operations ports and Runtime adapters                            | —                                                                              | —                                     | builtins call Runtime directly                       | —                     | 4E                     | —                                                     |
| Freeze §173–178 | Tool error philosophy, feedback content                          | `ToolFailureFeedback` producers                                                | root                                  | legacy error text                                    | 4A                    | 4B/4E                  | `tools-call-preparation`                              |
| Freeze §179–180 | approval key determinism, raw args                               | —                                                                              | —                                     | legacy `approval-key`                                | —                     | 4C                     | `approval-key` (legacy, unchanged)                    |
| Freeze §181–184 | update sanitization, observation projection                      | —                                                                              | —                                     | —                                                    | —                     | 4B/4D                  | —                                                     |
| Freeze §185–189 | storage atomic/revision invariants                               | —                                                                              | —                                     | legacy storage commit                                | —                     | 4C                     | —                                                     |
| Freeze §190     | first migration keeps sequential                                 | `ToolExecutionMode` declaration only                                           | root                                  | batch stays sequential                               | 4A                    | —                      | `phase-4a` guard                                      |
| Freeze §199–200 | `protocol.ToolDefinition` / `packages/tools` deletion conditions | not deleted                                                                    | —                                     | both retained                                        | —                     | 4F                     | `phase-4a` guard                                      |
| Refactor §19    | AJV policy `allErrors/strict/no-coerce/no-defaults/no-remove`    | `agent/src/tools/schema/schema-runtime.ts`                                     | root                                  | re-export                                            | 4A                    | —                      | `tools-registry`, `phase-4a` guard                    |
| Refactor §21–22 | preparation is normalization, not repair                         | `tool-call-preparer-impl.ts`                                                   | root                                  | legacy validator unchanged in behaviour              | 4A                    | —                      | `tools-call-preparation`                              |
| Refactor §69–70 | sequential first, `PARALLEL_SAFE` reserved                       | `execution-mode.ts`                                                            | root                                  | —                                                    | 4A                    | —                      | `tools-independent-use`                               |

---

## 3. The two `AgentToolResult` types, and how the collision is resolved

Phase 3 froze a model-visible result and root-exported the name:

```ts
// packages/agent/src/run/ports/tool-turn.ts        the model-visible result of a Tool turn
export interface AgentToolResult {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly content: string;
  readonly isError: boolean;
}
```

Tool System V2 freezes a raw execution result with the same name:

```ts
// packages/agent/src/tools/types/tool-result.ts    the raw result of one Tool execution
export interface AgentToolResult<TDetails extends JsonObject = JsonObject> {
  readonly content: string;
  readonly details: TDetails;
  readonly isError: boolean;
}
```

Resolution, exactly as the round requires:

```text
1  the Phase 3 declaration, its root export name and all four of its fields are unchanged
2  the Tool System declares its own AgentToolResult<TDetails> inside ./tools/**
3  the root publishes it under an explicit alias:
     export type { AgentToolResult as AgentToolExecutionResult } from "./tools/types/tool-result.js";
4  AgentTool.execute() returns the tool-module type
5  this document is the contract record of both semantics and the export mapping
6  the alias is an export mapping, not a third DTO: one declaration, no redeclaration
7  no src deep import, no undeclared subpath, no package-private reach-around
```

Forbidden and not done: adding `details` to the Phase 3 type, adding `externalCallId` to the
execution result, merging them into a union or an intersection, widening a frozen `ToolTurn` contract
to make wiring compile, or renaming either type.

Other same-name exports were checked and mapped rather than merged:

| Name                                              | Agent-side declaration                                        | Legacy-side declaration                                       | Mapping                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ToolExecutionResult`                             | `AgentToolResult<TDetails>`                                   | `packages/tools/src/execution-result.ts`                      | legacy file is a type alias to `AgentToolExecutionResult`                                              |
| `ToolPresentationPort`                            | `agent/src/tools/types/tool-presentation.ts`                  | `packages/tools/src/presentation.ts`                          | legacy file re-exports the agent declarations                                                          |
| `ToolSchemaRuntime`                               | `agent/src/tools/schema/schema-runtime.ts`                    | `packages/tools/src/schema-runtime.ts`                        | legacy file re-exports                                                                                 |
| `ToolExecutionEnvironment`                        | `agent/src/tools/types/execution-environment.ts` (port shape) | `packages/tools/src/execution-environment.ts` (durable shape) | structurally identical to `protocol.ToolExecutionEnvironment`; the legacy resolver/assert stays legacy |
| `ToolFailureFeedback`, `ToolExecutionIdentity`, … | agent-only                                                    | —                                                             | no collision                                                                                           |

---

## 4. Required registrations in this map

### 4.1 `CodingToolDefinition.tool`

```ts
export interface CodingToolDefinition {
  readonly tool: AgentTool; // the exact field name: `tool`
  readonly security: CodingToolSecurityMetadata;
  readonly securityFactsProjector?: CodingToolSecurityFactsProjector;
  readonly effectProjector?: CodingToolEffectProjector;
  readonly presentation?: ToolPresentationPort;
  readonly promptSnippet?: string;
}
```

The executable Tool's field is **`tool`**, not `agentTool`. Composition, not inheritance: the type
does not `extends AgentTool`, and Operations are not a definition field — they are injected by the
Tool's own factory closure (4E).

### 4.2 Required `AbortSignal`

`AgentToolExecutionInput.signal` is required. A Tool never handles `undefined`; the coordinator
creates a non-aborted internal signal when the caller has none. `updates` is required for the same
reason.

### 4.3 `ToolCallPreparationOutcome` has two arms

```text
READY     resolve, prepare and validate succeeded
REJECTED  the model can fix this; safe feedback
```

There is no third arm. An infrastructure failure is thrown, never returned.

### 4.4 Pre-invocation rejection creates no Invocation

An unknown Tool has no reliable risk level to persist, and an oversized or invalid payload should not
enter the durable invocation ledger for a call that never ran. The rejection still reaches the model
as safe feedback and through Run conversation history.

### 4.5 Infrastructure failures are not ordinary messages

`ToolPreparationInfrastructureError` (phase `PREPARATION`) is thrown. The Preparer's message carries
the reason category only, with the original error attached as `cause`; it never carries the raw
exception text, a host path, a stack trace or the argument payload.

### 4.6 Legacy Dispatcher behaviour preserved this round

```text
the dispatcher's outer outcome union is unchanged
an argument failure is still persisted the way it historically was
model guidance is still folded into the description before the catalog byte budget is measured
environment filtering still rebuilds registry and model definitions together
```

The target Preparer's own semantics and the legacy shell's compatibility semantics are separate
things, and switching the production rejection path onto the new pipeline is a **4D** acceptance
item.

### 4.7 Numeric-string compatibility normalization

```text
scope        a value whose own JSON Schema declares `number` or `integer`
conversion   JSON number grammar only; an `integer` field additionally requires a safe integer
recursion    through declared `properties` and declared array `items`
excluded     fuzzy strings, undeclared properties, missing fields, defaults, property removal
AJV          `coerceTypes` stays false; the conversion is a declared Tool hook, not a validator mode
implementation  one: packages/coding-agent/src/tools/legacy-argument-normalization.ts
exposure     only to registrations that opt in; a generic AgentTool gets none
```

### 4.8 Later ownership of the remaining responsibilities

| Responsibility                    | Current owner               | Later owner                            | Round |
| --------------------------------- | --------------------------- | -------------------------------------- | ----- |
| model guidance                    | `@caelush/tools` (legacy)   | Coding prompt context provider         | 4E    |
| failure memory                    | `@caelush/tools`            | admission/result layer                 | 4C–4D |
| raw output artifact               | `@caelush/tools` + storage  | settlement/observation layer           | 4C    |
| environment filtering             | `@caelush/tools`            | Coding composition + catalog alignment | 4E–4F |
| Coding security facts             | `@caelush/tools/builtins`   | `@caelush/coding-agent/tools/security` | 4E    |
| tool effects                      | `@caelush/tools`            | `@caelush/coding-agent/tools/effects`  | 4E    |
| presentation implementation       | `@caelush/security`         | Coding presentation                    | 4E    |
| invocation lifecycle + settlement | `@caelush/tools/dispatcher` | durable coordinator + Storage adapter  | 4C    |
| batch + model feedback            | `@caelush/tools` + Core     | Agent Tool batch layer                 | 4D    |
| the nine builtins                 | `@caelush/tools/builtins`   | `@caelush/coding-agent/tools/builtins` | 4E    |

### 4.9 Package root exports versus the documented conceptual directories

The spec's directory listings (`agent/tools/...`, `coding-agent/tools/...`) describe **conceptual**
target homes. `@caelush/agent/package.json` and `@caelush/coding-agent/package.json` each declare a
single root export (`"."`). There is no public `@caelush/agent/tools` or
`@caelush/coding-agent/tools` subpath, and 4A did not add one: every new contract is reachable from
the package root, and a deep `src` import stays forbidden by the architecture checker.

---

## 5. Node-by-node verification

| #   | Gate                                                                     | Status                                    |
| --- | ------------------------------------------------------------------------ | ----------------------------------------- |
| 1   | both Tool specs read end to end                                          | met                                       |
| 2   | six-round plan written into the repository                               | met — `PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md` |
| 3   | Phase 3F baseline verified (`merge-base --is-ancestor` exit 0)           | met                                       |
| 4   | the `AgentToolResult` collision resolved compatibly                      | met — §3                                  |
| 5   | general Tool foundation contracts landed                                 | met                                       |
| 6   | registry and schema have one canonical implementation                    | met                                       |
| 7   | `CodingToolDefinition`/`CodingToolCatalog` really usable                 | met                                       |
| 8   | `ToolCallPreparer` really usable                                         | met                                       |
| 9   | production registration and preflight delegate                           | met                                       |
| 10  | no second authority for a migrated responsibility                        | met — guard-enforced                      |
| 11  | legacy public entries keep their committed behaviour                     | met                                       |
| 12  | numeric normalization and environment filtering did not silently regress | met                                       |
| 13  | Phase 3 frozen interfaces unchanged                                      | met                                       |
| 14  | unmigrated responsibilities and exit rounds registered                   | met — §4.8                                |
| 15  | real behaviour tests and architecture guards                             | met                                       |
| 16  | no new architecture violation, no stale baseline entry                   | met — 31 → 31                             |
| 17  | changes committed; remote state reported honestly                        | see the foundation report §13             |
| 18  | 4B–4F not started early                                                  | met                                       |
