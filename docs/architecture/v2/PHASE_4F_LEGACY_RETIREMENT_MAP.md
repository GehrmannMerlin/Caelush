# Caelush Architecture V2 — Phase 4F Legacy Retirement Map

> Round: **Phase 4F** — the sixth and final round of Phase 4.
> Phase 4 is permanently frozen at exactly six rounds: `4A`, `4B`, `4C`, `4D`, `4E`, `4F`.
> No `4F-1`, `4F-2`, `4F-A`, `4F-B`, `4F-Fix`, `4F-Cleanup`, `4G`, or post-Phase-4 cleanup round was
> created. Every piece of work in this round is an internal milestone of 4F.

```text
4A  COMPLETE
4B  COMPLETE
4C  COMPLETE
4D  COMPLETE
4E  COMPLETE
4F  COMPLETE          ← this round
```

> **Historical document — Milestone A of Phase 4F.**
>
> This file was written **before** anything was deleted, from a source scan at the Phase 4E tip
> `7d0700ae2849378324398770df533fae45f39b3e`. It is the plan the round executed against, kept as
> evidence of what the inventory found and how each surface was classified.
>
> Every surface it maps was subsequently retired. Where the executed round departed from the plan, the
> departure is recorded in §9 of this file rather than edited into the earlier sections, so a reader can
> still see what was known before the work and what was learned during it.
>
> **Outcome:** [PHASE_4F_TOOL_SYSTEM_FINAL_REPORT.md](PHASE_4F_TOOL_SYSTEM_FINAL_REPORT.md) and
> [PHASE_4F_TOOL_SYSTEM_FINAL_ACCEPTANCE_MAP.md](PHASE_4F_TOOL_SYSTEM_FINAL_ACCEPTANCE_MAP.md).

> This document is **Milestone A** of Phase 4F. It was written by scanning the real source _before_
> anything was deleted, and it is the map every later milestone in this round executes against.
> A classification is a claim about the evidence at the Phase 4E tip
> `7d0700ae2849378324398770df533fae45f39b3e`; where the migration departed from the map, the
> departure is recorded in §9 rather than silently edited here.

---

## 1. The rule this map exists to enforce

Phase 4F is **not** a new Tool architecture, a second Tool System implementation, a builtin
optimisation, or a Runtime refactor. It is:

> Retire the compatibility surfaces Phase 4A–4E kept alive so the migration could proceed incrementally,
> and prove that Tool System V2 no longer depends on any of them.

```text
allowed      DELETE · MOVE TO EXISTING TARGET OWNER · REPLACE WITH EXISTING TARGET API
             TEST-ONLY MIGRATION · DOC-ONLY HISTORICAL REFERENCE · BLOCKER
forbidden    renaming a compatibility layer and calling it retirement
             moving a legacy file into another package so the import path changes
             keeping a deprecated alias "for safety"
             adding an architecture-baseline exception so a legacy surface may stay
             deleting a package before its callers are migrated and its authority is zero
```

The last one is why this map precedes every deletion. The order is fixed:

```text
inventory
  ↓
move callers
  ↓
prove zero authority
  ↓
prove zero live dependency
  ↓
delete the package
```

---

## 2. Baseline at the Phase 4E tip

```text
branch                deepseek/architecture-v2-phase-4e-coding-tools-operations-runtime
tip                   7d0700ae2849378324398770df533fae45f39b3e
working tree          clean
architecture baseline 27 entries · 0 new · 0 stale · READY
tests                 486 files · 3095 passed · 5 skipped · 0 failed
```

`packages/tools` at that tip was declared by Phase 4E's own report to be **compatibility only**:
"Everything below is compatibility only. Nothing here owns a Coding Tool algorithm, and every item is
reserved for Phase 4F retirement."

This map verifies that claim surface by surface instead of accepting it.

---

## 3. Production import inventory — who still imported the legacy package

Every `@caelush/tools` import in non-test source at the 4E tip, and what it was actually needed for.

| File                                                 | Imported                                                                                                                      | Kind                  | Classification                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------- |
| `packages/core/src/agent-tool-batch.ts`              | `ToolBatchItemResult`                                                                                                         | type only             | REPLACE WITH EXISTING TARGET API |
| `packages/core/src/resource-governor.ts`             | `ToolBatchItemResult`                                                                                                         | type only             | REPLACE WITH EXISTING TARGET API |
| `packages/core/src/resource-fingerprint.ts`          | `canonicalJsonString`                                                                                                         | value                 | REPLACE WITH EXISTING TARGET API |
| `packages/core/src/run-tool-observation-recovery.ts` | `ToolExecutionStorePort`                                                                                                      | type only             | REPLACE WITH EXISTING TARGET API |
| `packages/core/src/tool-security-context.ts`         | `ToolSecurityContext`                                                                                                         | type only             | REPLACE WITH EXISTING TARGET API |
| `packages/security/src/tool-gate.ts`                 | gate port/input/decision types, `assertToolSecurityContext`, metadata type                                                    | types + one assertion | MOVE TO EXISTING TARGET OWNER    |
| `packages/security/src/presentation.ts`              | `ToolExecutionResult`, `ToolPresentationPort`, presentation types                                                             | type only             | REPLACE WITH EXISTING TARGET API |
| `packages/security/src/tool-result-sanitizer.ts`     | `ToolExecutionResult`, `ToolResultSanitizerPort`                                                                              | type only             | REPLACE WITH EXISTING TARGET API |
| `packages/security/src/input-policy.ts`              | `ToolSecurityFacts`                                                                                                           | type only             | MOVE TO EXISTING TARGET OWNER    |
| `packages/security/src/default-composition.ts`       | `ToolDispatcher`, `createToolExecutionDependencies`, registry/registry-builder, `DEFAULT_BUILTIN_TOOL_ORDER`, type aliases    | **value**             | BLOCKER until migrated           |
| `apps/daemon/src/daemon.ts`                          | effect state projection, settlement decoder, debug event type                                                                 | **value**             | MOVE TO EXISTING TARGET OWNER    |
| `apps/daemon/src/daemon-composition.ts`              | registry builder, environment filter, admission/metadata adapters, execution dependencies, output bounder, registration types | **value**             | BLOCKER until migrated           |
| `packages/storage/src/run-budget-port.ts`            | — (comment reference only)                                                                                                    | comment               | DOC-ONLY HISTORICAL REFERENCE    |

**Two files were real blockers**, and both are in the production composition path:

```text
packages/security/src/default-composition.ts     createV1SecureToolDispatcher over the legacy Dispatcher
apps/daemon/src/daemon-composition.ts            the whole legacy composition surface listed in §5
```

Everything else was a type that already existed, unchanged and canonical, in `@caelush/agent`
or `@caelush/coding-agent`. Those are one-line import moves, not migrations.

---

## 4. `packages/tools` surface-by-surface classification

Every module, with the questions §11 of the authorising prompt requires answered.

### 4.1 DELETE — a delegating facade with no responsibility of its own

| Legacy module                                | Who imported it                                      | prod / test            | Canonical owner                            | Target implementation exists                                         | Caller migration needed                                              | Import after deletion   | Runtime behaviour | Durable contract | Public Protocol |
| -------------------------------------------- | ---------------------------------------------------- | ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------- | ----------------- | ---------------- | --------------- |
| `src/builtins/*.ts` (9 facades)              | `builtins/family builders`, tests                    | test only              | `@caelush/coding-agent`                    | yes — the nine Coding factories                                      | none in production; test callers dropped/moved                       | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/read-only-filesystem-tools.ts` | `builtins/default-tools.ts`, tests                   | test only              | `@caelush/coding-agent`                    | yes — `createReadFileTool` etc.                                      | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/file-mutation-tools.ts`        | same                                                 | test only              | `@caelush/coding-agent`                    | yes                                                                  | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/shell-tools.ts`                | same                                                 | test only              | `@caelush/coding-agent`                    | yes                                                                  | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/git-tools.ts`                  | same                                                 | test only              | `@caelush/coding-agent`                    | yes                                                                  | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/default-tools.ts`              | tests, `integration/openai-compatible-wire-contract` | test only              | `@caelush/coding-agent`                    | yes — `createDefaultCodingTools` / `DEFAULT_CODING_TOOL_ORDER`       | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/result.ts`                     | tests                                                | test only              | `@caelush/coding-agent`                    | yes — `builtins/result.ts`                                           | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/builtins/security-facts.ts`             | tests                                                | test only              | `@caelush/coding-agent`                    | yes — nine projectors                                                | tests                                                                | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/security-facts.ts` (vocabulary)         | `tool-admission-adapter`, dispatcher, tests          | **prod (legacy path)** | `@caelush/coding-agent`                    | yes — `security/security-facts.ts`                                   | the two legacy adapters, and the tests                               | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/approval-key.ts`                        | dispatcher, its own test                             | prod (legacy path)     | `@caelush/coding-agent`                    | yes — `computeCodingToolApprovalKey`                                 | the legacy adapters, and the tests                                   | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/tool-effects.ts`                        | dispatcher, settlement bridge, tests                 | prod (legacy path)     | `@caelush/coding-agent`                    | yes — effects + three projectors                                     | the legacy settlement bridge (itself deleted)                        | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/model-guidance.ts`                      | registry-builder, tests                              | prod (legacy path)     | `@caelush/coding-agent`                    | yes — `prompt/prompt-snippets.ts`                                    | registry-builder (deleted)                                           | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/presentation.ts`                        | dispatcher, security composition, tests              | prod (legacy path)     | `@caelush/agent`                           | yes — the presentation contract                                      | none: `@caelush/security` imports the contract from `@caelush/agent` | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/json-canonical.ts`                      | dispatcher, registry-builder, tests                  | prod (legacy path)     | `@caelush/agent`                           | yes — `schema/json-canonical.ts`                                     | `packages/core/src/resource-fingerprint.ts`                          | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/legacy-definition.ts`                   | registry-builder, json-canonical                     | legacy only            | — (no target)                              | n/a — deleted with its caller                                        | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/schema-runtime.ts`                      | registry-builder, tests                              | legacy only            | `@caelush/agent`                           | yes — `ToolSchemaRuntime`                                            | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/schema-policy.ts`                       | registry-builder, tests                              | legacy only            | `@caelush/agent`                           | yes — `validateToolSchemaSemantics`                                  | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/legacy-argument-validation.ts`          | dispatcher, tests                                    | legacy only            | `@caelush/agent` + `@caelush/coding-agent` | yes — `ToolCallPreparer`, `createLegacyNumericArgumentNormalization` | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/result-validation.ts`                   | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — result validator                                               | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/result-sanitizer.ts`                    | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — sanitizer port                                                 | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/output-policy.ts`                       | dispatcher, registry-builder, tests                  | legacy only            | `@caelush/agent`                           | yes — `boundToolResultContent`, `DEFAULT_TOOL_RESULT_LIMITS`         | `apps/daemon`, tests                                                 | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/tool-system-bridge.ts`                  | registry-builder, tool-adapters                      | legacy only            | — (no target)                              | n/a — error translation only                                         | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/errors.ts`                              | registry-builder, output-policy, tests               | legacy only            | `@caelush/agent`                           | yes — the Agent error classes                                        | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/dispatcher-errors.ts`                   | dispatcher, execution-environment, batch             | legacy only            | — (no target)                              | n/a — the Dispatcher is deleted                                      | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/execution-environment.ts`               | dispatcher, batch-types                              | legacy only            | `@caelush/agent`                           | yes — `ToolExecutionEnvironment` + `assertToolExecutionEnvironment`  | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/security-context.ts`                    | dispatcher, admission adapter                        | legacy only            | `@caelush/agent`                           | yes — `assertToolSecurityContext`                                    | none (Security already imported it from `@caelush/agent`)            | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/execution-result.ts`                    | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — `AgentToolResult`                                              | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/execution-disposition.ts`               | dispatcher, batch, tests                             | **prod (legacy path)** | `@caelush/agent`                           | yes — `ToolExecutionUncertainError`, `UNCERTAIN_SIDE_EFFECT`         | `packages/security` tests                                            | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/handler.ts`                             | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — `AgentTool.execute`                                            | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/observation.ts`                         | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — `durable/observation.ts`                                       | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/invocation-lifecycle.ts`                | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — `durable/invocation-lifecycle.ts`                              | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/event-factory.ts`                       | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — `durable/durable-events.ts`                                    | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/debug.ts`                               | dispatcher only                                      | legacy only            | — (no target)                              | n/a — the diagnostic belongs to a retired pipeline                   | `apps/daemon` drops the dead option and env flag                     | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/options.ts`                             | registry-builder, tests                              | legacy only            | `@caelush/agent`                           | yes — `DEFAULT_TOOL_REGISTRY_OPTIONS`, `validateToolRegistryOptions` | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/registry.ts`                            | registry-builder, exposure, tests                    | legacy only            | `@caelush/agent`                           | yes — `AgentToolRegistry`                                            | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/registry-builder.ts`                    | production composition, tests                        | **prod**               | `@caelush/agent` + `@caelush/coding-agent` | yes — `DefaultAgentToolRegistryBuilder`, `CodingToolCatalogBuilder`  | `apps/daemon`                                                        | those two               | unchanged         | unchanged        | unchanged       |
| `src/tool-exposure.ts`                       | production composition, tests                        | **prod**               | `@caelush/coding-agent`                    | yes — `withoutGitTools`, `GIT_TOOL_NAMES`                            | `apps/daemon`                                                        | `@caelush/coding-agent` | unchanged         | unchanged        | unchanged       |
| `src/tool-adapters.ts`                       | registry-builder, admission adapter                  | legacy only            | — (no target)                              | n/a — registration classification                                    | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/coding-tool-adapter.ts`                 | registry-builder, tool-exposure                      | legacy only            | — (no target)                              | n/a — legacy shape bridging                                          | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/registration.ts`                        | registry-builder, tool-adapters, exposure            | legacy only            | — (no target)                              | n/a — the legacy registration DTO                                    | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/preflight.ts` (`ToolPreflight`)         | dispatch path + own test                             | legacy only            | `@caelush/agent`                           | yes — `ToolCallPreparer`                                             | none in production                                                   | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/tool-failure-memory.ts`                 | dispatcher, its own test                             | legacy only            | — (no target)                              | n/a — not in the V2 pipeline                                         | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/dispatcher.ts` (`ToolDispatcher`)       | `default-composition` + 6 test suites                | **prod (legacy path)** | `@caelush/agent`                           | yes — the four canonical authorities                                 | `packages/security` composition                                      | see §4.2                | unchanged         | unchanged        | unchanged       |
| `src/dispatcher-types.ts`                    | dispatcher, batch, tests                             | legacy only            | `@caelush/agent`                           | yes — canonical request/commit types                                 | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/dispatcher-ports.ts`                    | dispatcher, batch, security, tests                   | **prod (legacy path)** | `@caelush/agent` + `@caelush/security`     | yes — see §4.2                                                       | `packages/security`                                                  | see §4.2                | unchanged         | unchanged        | unchanged       |
| `src/batch-coordinator.ts`                   | `dispatcher` only, its own test                      | test only              | `@caelush/agent`                           | yes — canonical `ToolBatchCoordinator`                               | none in production                                                   | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/batch-types.ts`                         | batch-coordinator, tests                             | test only              | `@caelush/agent`                           | yes — `batch/batch-types.ts`                                         | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/batch-errors.ts`                        | tests, `packages/core` test                          | test only              | `@caelush/agent`                           | yes — `batch/batch-errors.ts`                                        | one core test                                                        | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/execution-store.ts`                     | dispatcher, tests                                    | legacy only            | `@caelush/agent`                           | yes — `ToolExecutionConflictError`, `ToolExecutionInvariantError`    | tests                                                                | `@caelush/agent`        | unchanged         | unchanged        | unchanged       |
| `src/tool-budget-adapter.ts`                 | dispatcher only                                      | legacy only            | `@caelush/agent`                           | yes — `ToolBudgetAdmissionPort`                                      | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/approval-lookup-adapter.ts`             | dispatcher only                                      | legacy only            | `@caelush/agent`                           | yes — `ToolApprovalLookupPort`                                       | none                                                                 | n/a — removed           | unchanged         | unchanged        | unchanged       |
| `src/tool-execution-store-compatibility.ts`  | dispatcher only, storage test support                | **prod (legacy path)** | `@caelush/agent` + `@caelush/coding-agent` | yes — see §4.2                                                       | `apps/daemon`, one storage test                                      | see §4.2                | unchanged         | unchanged        | unchanged       |
| `src/settlement-extension-bridge.ts`         | dispatcher, store compatibility, tests               | **prod (legacy path)** | `@caelush/coding-agent`                    | yes — see §4.2                                                       | `apps/daemon`                                                        | see §4.2                | unchanged         | unchanged        | unchanged       |
| `src/index.ts`                               | 30+ files (all listed above)                         | mixed                  | —                                          | n/a                                                                  | every caller                                                         | n/a — removed           | unchanged         | unchanged        | unchanged       |

### 4.2 The five surfaces that needed a genuine owner decision

These are the only modules in the package that were not a mechanical re-point. Each is recorded with
the decision the round made, and the reason.

```text
1  the gate contract          ToolExecutionGatePort · Input · Decision · ToolDefinitionMetadata
2  the admission adapters     createCodingToolAdmissionPort · createCodingToolDurableMetadataPort
                              createDurableInvocationGatePort
3  the settlement extension   createLegacyToolSettlementExtensionProjector
                              createLegacyToolSettlementExtensionDecoder
4  the execution pair         createToolExecutionDependencies
5  the security composition   createV1SecureToolDispatcher · assertDefaultBuiltinSecurityCoverage
```

**1 — the gate contract → `MOVE TO EXISTING TARGET OWNER`, to `@caelush/agent`.**

The gate sits between two layers that must not import each other: a Security implementation evaluates
policy over Coding security facts, and a Coding admission adapter translates the answer into the
Agent's `ToolPolicyDecision`. Declaring it in the layer that _consumes_ it — the Agent Tool framework,
which already owns the canonical admission ports — is what keeps that translation acyclic.

```text
first attempt   declare it in @caelush/security
result          packages/security → packages/coding-agent (facts vocabulary)
                packages/coding-agent → packages/security (the gate it implements)
                pnpm: "There are cyclic workspace dependencies"
                tsc:  TS5055 — each package's dist/*.d.ts became the other's build input
verdict         a cross-package *declaration* cycle is a build-order defect, not a style question
final owner     @caelush/agent declares it; @caelush/security re-exports the names
```

`@caelush/security` re-exports every name, so no caller's import path changed. The facts vocabulary
stays in `@caelush/coding-agent`; the Agent layer sees a structural four-field subset and never learns
what a capability means.

**2 — the admission adapters → `MOVE TO EXISTING TARGET OWNER`, to `@caelush/coding-agent`.**

Every input is Coding product metadata: the Tool's risk level, its capabilities, its runtime
requirements, its own security-facts projector and the approval-identity algorithm. The translation is
_Coding vocabulary → Agent contract_, so the package that owns the vocabulary owns the translation.
Nothing changed behaviourally; the risk level is still read from the Coding catalog first.

**3 — the settlement extension → `MOVE TO EXISTING TARGET OWNER`, to `@caelush/coding-agent`.**

```text
encoder   createLegacyToolSettlementExtensionProjector
          production-dead: Phase 4E made the canonical result pipeline project
          CodingToolDefinition.effectProjector instead. It read the projector back out of a
          compatibility registry view. → replaced by the catalog-driven
          createCodingToolSettlementExtensionProjector.

decoder   createLegacyToolSettlementExtensionDecoder
          production-live: apps/daemon wires it into `openCaelushStorage` as the
          `caelush.coding.effects.v1` decoder that applies an effect's AgentState projection inside
          the invocation's own SQLite transaction. The Coding effect vocabulary belongs to the Coding
          layer and Storage may not import it, so the host supplies it. → moved and renamed
          createCodingToolSettlementExtensionDecoder; the extension KIND is byte-identical.
```

The Agent layer still carries `{ kind, payload }` opaquely and branches on nothing. No Coding effect
interpretation entered `@caelush/agent`.

**4 — `createToolExecutionDependencies` → `REPLACE WITH EXISTING TARGET API`.**

It assembled exactly two canonical values, `createToolInvocationExecutor` and
`createToolResultPipeline`, plus an output policy that resolves to the same 64 KiB bound and the same
`[output truncated]` marker as `DEFAULT_TOOL_RESULT_LIMITS`. Its only legacy-specific contribution was
the settlement extension projector in item 3. The composition root therefore calls the two canonical
factories directly.

> This is precisely the case §15 of the authorising prompt forbids treating as a file move: the
> function was **not** copied into `apps/daemon`. It was replaced by the canonical APIs it wrapped.

**5 — the security composition → `REPLACE WITH EXISTING TARGET API` + `DELETE`.**

```text
createV1SecureToolDispatcher        DELETE   a facade over the retired Dispatcher; no production caller
V1SecureToolDispatcherOptions       DELETE   its options type
createDefaultV1ToolExecutionSecurity  KEEP   the real gate, presenter and result sanitizer
createV1ToolApprovalRequestFactory    KEEP   translated from the legacy registry view to the
                                             canonical AgentToolRegistry + CodingToolCatalog
assertDefaultBuiltinSecurityCoverage  KEEP   translated to (registry, catalog, expectedToolNames);
                                             the expected list is injected so the default order has one
                                             declaration, in @caelush/coding-agent
```

---

## 5. `apps/daemon` — the highest-priority caller migration

The daemon is the production composition root, so every legacy value it held is a blocker until it is
re-pointed. The migration, surface by surface.

| Legacy use in the daemon                                  | Classification                   | Replacement                                                                        |
| --------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `new ToolRegistryBuilder()`                               | REPLACE WITH EXISTING TARGET API | `new DefaultAgentToolRegistryBuilder()`, registering each `definition.tool`        |
| `builder.buildCodingCatalog()`                            | REPLACE WITH EXISTING TARGET API | `new CodingToolCatalogBuilder().forRegistry(registry)` + `register(definition)`    |
| `filterToolRegistryForEnvironment(registry, env)`         | REPLACE WITH EXISTING TARGET API | the definition set is chosen before anything is built — one exposure authority     |
| `createCodingToolAdmissionPort({ …, definitions })`       | MOVE (caller)                    | `@caelush/coding-agent`, with `catalog` instead of `definitions`                   |
| `createCodingToolDurableMetadataPort({ …, definitions })` | MOVE (caller)                    | `@caelush/coding-agent`, with `catalog`                                            |
| `createDurableInvocationGatePort`                         | MOVE (caller)                    | `@caelush/coding-agent`                                                            |
| `createToolExecutionDependencies({ … })`                  | REPLACE WITH EXISTING TARGET API | `createToolInvocationExecutor` + `createToolResultPipeline` from `@caelush/agent`  |
| `boundToolModelContent(content, outputPolicy)`            | REPLACE WITH EXISTING TARGET API | `boundToolResultContent(content)` — identical bound and marker                     |
| `registry.agentRegistry()` / `modelDefinitions()`         | REPLACE WITH EXISTING TARGET API | the canonical `AgentToolRegistry` directly: `resolve()`, `names()`, `modelSpecs()` |
| `createLegacyToolSettlementExtensionDecoder`              | MOVE (caller)                    | `createCodingToolSettlementExtensionDecoder` in `@caelush/coding-agent`            |
| `ToolCallingDebugEvent` + `CAELUSH_DEBUG_TOOL_CALLING`    | DELETE                           | dead since 4D: the option was accepted and never consumed by any live pipeline     |
| `ToolExposureEnvironment`                                 | REPLACE WITH EXISTING TARGET API | `GitToolAvailability`, owned by `@caelush/coding-agent`                            |

**One real defect this migration fixed.** `filterToolRegistryForEnvironment` re-registered a _filtered_
registry while the daemon built its Coding catalog from the _unfiltered_ one, then read the durable
`riskLevel` from the catalog. The replacement builds the registry and the catalog from the same
already-Git-filtered definition list, so the executable Tool set, the Coding overlay, the model-visible
specs and the prompt guidance block are four views of one derivation. The observable behaviour for
`AVAILABLE` / `UNAVAILABLE` / `UNKNOWN` is unchanged; the internal inconsistency is gone.

---

## 6. `protocol.ToolDefinition` — usage audit

The only round authorised to retire it is 4F. Repository-wide usage at the 4E tip.

| Consumer                                                 | Category     | Decision                                                               |
| -------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| `packages/protocol/src/tool.ts` (`ToolDefinitionSchema`) | definition   | DELETE                                                                 |
| `packages/protocol/src/index.ts`                         | API export   | DELETE both the schema and the type export                             |
| `packages/tools/src/registry-builder.ts`                 | legacy tools | deleted with the package                                               |
| `packages/security/src/tool-gate.ts`                     | production   | narrowed — the gate now accepts only the canonical four-field metadata |
| `packages/security/src/default-composition.ts`           | production   | deleted with `createV1SecureToolDispatcher`                            |
| `packages/core/src/agent-loop-input.ts`                  | production   | REPLACE WITH EXISTING TARGET API → `AIToolSpec`                        |
| `packages/core/src/agent-loop.ts`                        | production   | REPLACE WITH EXISTING TARGET API → `AIToolSpec`                        |
| `packages/core/src/agent-loop-request.ts`                | production   | REPLACE WITH EXISTING TARGET API → `AIToolSpec`                        |
| `packages/core/src/run-agent-execution.ts`               | production   | REPLACE WITH EXISTING TARGET API → `AIToolSpec`                        |
| `packages/core/src/run-controller-ports.ts`              | production   | `modelDefinitions()` → `modelSpecs(): readonly AIToolSpec[]`           |
| `packages/core/src/ai-invocation-projection.ts`          | production   | `toAIToolSpec` DELETED — the projection became an identity             |
| `packages/core/src/run-agent-execution.ts` (config)      | production   | already `AIToolSpec` internally; only the config type changed          |
| `packages/protocol/test/tool.test.ts`                    | tests        | test-only migration                                                    |
| `packages/tools/test/**`                                 | tests        | deleted with the package                                               |
| `tests/integration/tool-catalog.test.ts`                 | tests        | test-only migration                                                    |
| `packages/*/test/**` fixtures                            | tests        | test-only migration                                                    |
| `docs/architecture/v2/**`                                | docs         | DOC-ONLY HISTORICAL REFERENCE — not touched                            |

**No live wire, network or persistence requirement exists.** `ToolDefinitionSchema` is never parsed
outside the legacy registry builder and two protocol tests; a `ToolInvocation` row stores a
`toolName`, not a definition. Nothing persists, serialises or transports a `ToolDefinition`.

### The replacement roles

```text
AgentTool            the general executable Tool contract      @caelush/agent
AIToolSpec           the model-facing Tool contract            @caelush/ai
CodingToolDefinition AgentTool + Coding security/effects/UI/prompt   @caelush/coding-agent
CodingToolSecurityMetadata   riskLevel · capabilities · runtimeRequirements   @caelush/coding-agent
```

### What must NOT be retired with it

```text
ToolNameSchema / ToolName        a durable primitive a ToolInvocation stores and an approval key hashes
ToolInvocationSchema / ToolInvocation / ToolInvocationStatus
                                 the persisted shape; 4F has no DB or Protocol migration authority
```

`ToolInvocation` field-for-field, its six statuses, the `ToolObservation` shape, the persisted
`ApprovalRequest` shape and the persisted `AgentRun` shape are all **unchanged** by this round. See §7.

---

## 7. Durable and public-contract boundary — frozen for this round

```text
ToolInvocation persisted shape            unchanged
ToolInvocationStatus values               unchanged
ToolObservation persisted shape           unchanged
ApprovalRequest persisted shape           unchanged
AgentRun / AgentState persisted shape     unchanged
SQLite migrations                         none added, none changed
Protocol persisted value shapes           none changed
Coding settlement extension kind          "caelush.coding.effects.v1" — byte-identical
default Coding Tool order                 read_file · list_directory · find_files · search_text ·
                                          apply_patch · exec_command · write_stdin · git_status · git_diff
Tool runtime behaviour, schemas, defaults, bounds, error codes, effects, security, prompt semantics
                                          unchanged
```

---

## 8. Test-only migration plan

Each legacy suite, with the canonical replacement it maps to. Nothing is deleted merely because its
subject was deleted: a suite that guarded a real behaviour is mapped to the test that guards it now.

| Legacy suite (in `packages/tools/test`)                                      | Verifies                              | Disposition                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apply-patch.test.ts`                                                        | the patch Tool's contract             | covered by `packages/coding-agent/test/builtins/apply-patch.test.ts`                             |
| `approval-key.test.ts`                                                       | approval identity stability           | covered by `coding-agent/test/authority-fidelity.test.ts` (81 keys)                              |
| `argument-validation.test.ts`                                                | argument preparation                  | covered by the canonical Preparer suites in `packages/agent/test`                                |
| `batch-coordinator.test.ts`                                                  | legacy batch semantics                | covered by the canonical batch suite in `packages/agent/test`                                    |
| `builtin-security-facts.test.ts`                                             | per-Tool security facts               | covered by `coding-agent/test/builtins/*` + `security-facts-contracts`                           |
| `catalog-consistency.test.ts`                                                | registry ↔ catalog alignment          | covered by `coding-agent/test/coding-tool-catalog.test.ts`                                       |
| `contracts.test.ts`                                                          | legacy DTO shapes                     | obsolete — DTO deleted                                                                           |
| `default-tools.test.ts`                                                      | the nine defaults and their order     | covered by `coding-agent/test/authority-fidelity.test.ts` + daemon E2E                           |
| `dispatcher-*.test.ts` (7 suites)                                            | the retired Dispatcher lifecycle      | covered by the canonical coordinator suites in `packages/agent/test` and `packages/storage/test` |
| `event-factory.test.ts`                                                      | durable Tool event drafts             | covered by `agent/test/tools/durable-events` assertions                                          |
| `exec-command.test.ts`                                                       | the shell Tool's contract             | covered by `coding-agent/test/builtins/exec-command.test.ts`                                     |
| `execution-environment.test.ts`                                              | the environment locator               | covered by `packages/agent/test` tool-types suites                                               |
| `git-tools.test.ts`                                                          | the two Git Tools                     | covered by `coding-agent/test/git-status-runtime.test.ts` + `git-diff`                           |
| `invocation-lifecycle.test.ts`                                               | the transition table                  | covered by `packages/agent/test` durable lifecycle suites                                        |
| `json-canonical.test.ts`                                                     | canonical JSON encoding               | covered by the canonical `json-canonical` suite in `packages/agent/test`                         |
| `model-guidance.test.ts`                                                     | guidance folding                      | obsolete — the folding algorithm is retired; prompt covers snippets                              |
| `output-policy.test.ts`                                                      | the durable content bound             | covered by the canonical result-policy suite in `packages/agent/test`                            |
| `preflight.test.ts`                                                          | `ToolPreflight`                       | covered by the canonical `ToolCallPreparer` suites                                               |
| `presentation-boundary.test.ts`                                              | presentation is non-authoritative     | covered by `packages/security/test` presentation assertions                                      |
| `public-api.test.ts`                                                         | the legacy public surface             | obsolete — the surface is retired                                                                |
| `read-only-filesystem-tools.test.ts`                                         | the four read Tools                   | covered by `coding-agent/test/builtins/*` + `runtime-adapters.test.ts`                           |
| `registry-builder.test.ts` · `registry.test.ts` · `registry-options.test.ts` | the legacy registry                   | covered by `packages/agent/test` registry suites                                                 |
| `schema-policy.test.ts` · `schema-runtime.test.ts`                           | schema policy and compilation         | covered by the canonical schema suites in `packages/agent/test`                                  |
| `security-catalog-characterization.test.ts`                                  | catalog characterisation              | covered by `coding-agent/test/coding-tool-catalog.test.ts`                                       |
| `security-context.test.ts`                                                   | the security context                  | covered by the canonical `ToolSecurityContext` suite in `packages/agent/test`                    |
| `security-facts-contracts.test.ts`                                           | facts contract stability              | covered by `coding-agent/test/builtins/*`                                                        |
| `shell-runtime-integration.test.ts`                                          | shell integration                     | covered by `coding-agent/test/runtime-adapters.test.ts`                                          |
| `shell-tools.test.ts` · `write-stdin.test.ts`                                | the two process Tools                 | covered by `coding-agent/test/builtins/*`                                                        |
| `stale-process-uncertainty.test.ts`                                          | uncertain side effects                | covered by `coding-agent/test/builtins/*` + `packages/agent/test` uncertainty suites             |
| `tool-effects.test.ts`                                                       | the effect vocabulary and projections | covered by `coding-agent/test` effects suites                                                    |
| `tool-execution-delegation.test.ts`                                          | delegation to the canonical pair      | covered by the daemon composition suites                                                         |
| `tool-exposure.test.ts`                                                      | Git exposure                          | covered by the daemon E2E + `coding-agent/test` default-tools suite                              |
| `tool-failure-memory.test.ts`                                                | `ToolFailureMemory`                   | obsolete — not in the V2 pipeline                                                                |
| `tool-system-delegation.test.ts`                                             | legacy delegation behaviour           | obsolete — every delegate is deleted                                                             |

Suites outside the package:

| Legacy suite                                                 | Disposition                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/daemon/test/tool-execution-result-composition.test.ts` | migrated: the live assertions (real sanitizers, the nine defaults, three-field model specs) now run against the canonical registry and result pipeline |
| `apps/daemon/test/tool-composition-delegation.test.ts`       | migrated: re-pointed at the canonical production assembly                                                                                              |
| `apps/daemon/test/agent-tool-round-trip-wire.test.ts`        | migrated: canonical registry + `modelSpecs()`                                                                                                          |
| `apps/daemon/test/tool-batch-production-composition.test.ts` | migrated: `modelSpecs()`                                                                                                                               |
| `packages/core/test/run-tool-turn-driver.test.ts`            | migrated: canonical batch errors                                                                                                                       |
| `packages/core/test/architecture.test.ts`                    | migrated: the dead allowlist entry became a permanent no-dependency rule                                                                               |
| `packages/security/test/secure-composition.test.ts`          | migrated: canonical registry + catalog + 3-argument coverage check                                                                                     |
| `packages/security/test/dispatcher-integration.test.ts`      | migrated or replaced by the gate policy suite                                                                                                          |
| `packages/security/test/input-policy.test.ts`                | migrated: facts vocabulary from `@caelush/coding-agent`                                                                                                |
| `packages/storage/test/*` (7 files)                          | migrated: canonical store port, snapshot, commit and settlement decoder                                                                                |
| `tests/integration/openai-compatible-wire-contract.test.ts`  | migrated: `DEFAULT_CODING_TOOL_ORDER` + `modelSpecs()`                                                                                                 |
| `packages/coding-agent/test/authority-fidelity.test.ts`      | **re-authored**: the legacy comparison oracle is gone, so the suite now asserts the canonical behaviour as its own regression fixture                  |
| `tests/architecture/phase-4a-…​4e`                           | re-pointed at the canonical owners; every migration-era assertion restated as the permanent rule it stood for                                          |
| `tests/architecture/*` (9 non-Phase-4 guards)                | dead `@caelush/tools` entries removed; the permanent rules added                                                                                       |

### Fixtures are preserved; the legacy implementation is not

Phase 4E's fidelity suite compared the legacy and target implementation across 32 scenarios. Phase 4F
does **not** recreate a legacy implementation to keep that oracle alive:

```text
kept      the expected behavioural fixtures — a real workspace, real Tools, per-scenario expected output
dropped   the legacy implementation as an oracle
replaced  the comparison with assertions that the canonical implementation produces those expected
          results directly, so the suite fails if the *behaviour* changes rather than if the two
          implementations diverge
```

No behavioural fixture, bound, default, error code, effect, security fact or prompt snippet was
weakened to make the retirement pass.

---

## 9. Departures from this map, recorded

A map written before the work is a plan. These are the places the executed round differed, and why.

```text
1  the gate contract's first target was @caelush/security
   → moved to @caelush/agent after the cross-package declaration cycle was proven with a real
     `pnpm install` warning and a real `tsc` TS5055 failure. Recorded in §4.2 item 1.

2  `ToolExecutionGateInput` accepted a union of the canonical metadata and the legacy seven-field
   ToolDefinition
   → narrowed to the canonical metadata alone. The union existed only so a host holding a legacy
     ToolDefinition could hand it over; once that contract is retired the second arm is unreachable,
     and keeping it would have kept a live reference to a retired Protocol type in production.

3  the daemon's Tool exposure was found to be internally inconsistent
   → fixed as part of the caller migration rather than preserved. Recorded in §5.

4  the daemon's `CAELUSH_DEBUG_TOOL_CALLING` flag and `ToolCallingDebugEvent` were found to be dead
   → deleted rather than translated. Recorded in §5.
```

---

## 10. Blockers

**None.** Every surface in §4 had a legitimate existing target owner, and every production caller was
migrated rather than re-implemented.

The five surfaces in §4.2 required an ownership decision, and each decision is recorded with the
evidence that produced it. No surface required a new package, a new architecture decision, a database
migration, a Protocol change, or an architecture-baseline exception.

---

## 11. Milestones this map authorises

```text
A  this document                                                    final legacy inventory and retirement map
B  eliminate the remaining production dependencies                  §3, §5
C  retire the compatibility APIs and remove packages/tools           §4, §8
D  retire protocol.ToolDefinition                                    §6
E  workspace / manifest / build-graph closure                        §5, §6
F  whole Tool System V2 architecture acceptance                      the Phase 4F guard
G  full behavioural / production / clean-checkout verification
H  Phase 4 final acceptance documentation and Git closure
```

These are milestones internal to Phase 4F. They are not rounds, and no further round follows them.
