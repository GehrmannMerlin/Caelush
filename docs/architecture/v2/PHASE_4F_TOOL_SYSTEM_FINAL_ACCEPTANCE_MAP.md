# Caelush Architecture V2 — Phase 4F Whole-Phase Tool System Acceptance Map

> Round: **Phase 4F**, the sixth and final round of Phase 4.
> This map covers the **whole of Phase 4**, not only the files 4F changed.

```text
4A  COMPLETE     general Tool contract · schema runtime · registry · ToolCallPreparer
4B  COMPLETE     invocation execution · transient updates · result pipeline
4C  COMPLETE     admission · approval · budget · durable lifecycle · settlement
4D  COMPLETE     batch · result normalization · model feedback · production ToolTurn
4E  COMPLETE     nine Coding builtins · Operations · Runtime adapters · effects · prompt
4F  COMPLETE     compatibility retirement · whole-phase acceptance

PHASE 4 COMPLETE
```

---

## A. Current → Owner map

One owner per row. A row with two owners would be either a cross-layer port/implementation pair, which
is stated as such, or a defect.

### A.1 General Tool Kernel — `@caelush/agent`

| Current responsibility                 | Owner                   | Symbol                                                                         |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Executable Tool contract               | `@caelush/agent`        | `AgentTool` (extends `AIToolSpec`)                                             |
| Tool execution identity                | `@caelush/agent`        | `ToolExecutionIdentity`                                                        |
| Tool execution environment (data only) | `@caelush/agent`        | `ToolExecutionEnvironment`                                                     |
| Execution mode declaration             | `@caelush/agent`        | `ToolExecutionMode`, `DEFAULT_TOOL_EXECUTION_MODE`                             |
| Tool result shape                      | `@caelush/agent`        | `AgentToolResult`                                                              |
| Schema compiler                        | `@caelush/agent`        | `ToolSchemaRuntime` (the only `ajv` importer)                                  |
| Generic schema policy                  | `@caelush/agent`        | `validateToolSchemaSemantics`, `DEFAULT_TOOL_REGISTRY_OPTIONS`                 |
| JSON helpers                           | `@caelush/agent`        | `canonicalJsonString`, `cloneJsonValue`, `deepFreezeJson`                      |
| Immutable registry                     | `@caelush/agent`        | `ImmutableAgentToolRegistry`, `AgentToolRegistry`                              |
| Registry builder                       | `@caelush/agent`        | `DefaultAgentToolRegistryBuilder`                                              |
| Model-facing catalog                   | `@caelush/agent`        | `AgentToolRegistry.modelSpecs(): readonly AIToolSpec[]`                        |
| Tool call preparation                  | `@caelush/agent`        | `createToolCallPreparer`, `PreparedToolCall`                                   |
| Argument compatibility normalization   | `@caelush/coding-agent` | `createLegacyNumericArgumentNormalization`                                     |
| Tool invocation execution              | `@caelush/agent`        | `createToolInvocationExecutor`                                                 |
| Transient update lifecycle             | `@caelush/agent`        | `ToolExecutionUpdateSink`, `ToolExecutionUpdateSanitizerPort`                  |
| Result validation                      | `@caelush/agent`        | `validateToolResult`                                                           |
| Result bounding                        | `@caelush/agent`        | `boundToolResultContent`, `DEFAULT_TOOL_RESULT_LIMITS`                         |
| Result pipeline                        | `@caelush/agent`        | `createToolResultPipeline`, `ToolResultPipeline`                               |
| Settlement extension carrier (opaque)  | `@caelush/agent`        | `ToolSettlementExtension`, `ToolSettlementExtensionProjector`                  |
| Security context                       | `@caelush/agent`        | `ToolSecurityContext`, `assertToolSecurityContext`                             |
| Gate contract                          | `@caelush/agent`        | `ToolExecutionGatePort`, `ToolExecutionGateInput`, `ToolExecutionGateDecision` |
| Admission contract                     | `@caelush/agent`        | `ToolAdmissionPort`, `ToolAdmissionRequest`, `ToolPolicyDecision`              |
| Admission coordinator                  | `@caelush/agent`        | `createToolAdmissionCoordinator`                                               |
| Budget admission port                  | `@caelush/agent`        | `ToolBudgetAdmissionPort`                                                      |
| Approval lookup port                   | `@caelush/agent`        | `ToolApprovalLookupPort`                                                       |
| Durable metadata port                  | `@caelush/agent`        | `ToolDurableMetadataPort`                                                      |
| Invocation lifecycle                   | `@caelush/agent`        | `createRequestedToolInvocation`, `startToolInvocation`, …                      |
| Observation lifecycle                  | `@caelush/agent`        | `createToolObservation`, `assertToolObservationInvariant`                      |
| Durable store contract                 | `@caelush/agent`        | `ToolExecutionStorePort`, `ToolExecutionSnapshot`, `ToolExecutionCommit`       |
| Durable Tool events                    | `@caelush/agent`        | `createToolRequestedEvent` … `createApprovalResolvedEvent`                     |
| Settlement coordinator                 | `@caelush/agent`        | `createToolSettlementCoordinator`                                              |
| Durable execution coordinator          | `@caelush/agent`        | `createDurableToolExecutionCoordinator`                                        |
| Failure settlement                     | `@caelush/agent`        | `createToolFailureSettlement`                                                  |
| Batch scheduling                       | `@caelush/agent`        | `createToolBatchCoordinator`, `ToolBatchRequest`, `ToolBatchOutcome`           |
| Result batch normalization             | `@caelush/agent`        | `createToolResultBatchNormalizer`                                              |
| Model feedback projection              | `@caelush/agent`        | `createModelToolFeedbackProjector`                                             |
| Presentation contract                  | `@caelush/agent`        | `ToolPresentationPort`, `ToolInvocationPresentation`                           |

### A.2 Coding Tool Product — `@caelush/coding-agent`

| Current responsibility          | Owner                   | Symbol                                                                                                                            |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`                     | `@caelush/coding-agent` | `createReadFileTool`                                                                                                              |
| `list_directory`                | `@caelush/coding-agent` | `createListDirectoryTool`                                                                                                         |
| `find_files`                    | `@caelush/coding-agent` | `createFindFilesTool`                                                                                                             |
| `search_text`                   | `@caelush/coding-agent` | `createSearchTextTool`                                                                                                            |
| `apply_patch`                   | `@caelush/coding-agent` | `createApplyPatchTool`                                                                                                            |
| `exec_command`                  | `@caelush/coding-agent` | `createExecCommandTool`                                                                                                           |
| `write_stdin`                   | `@caelush/coding-agent` | `createWriteStdinTool`                                                                                                            |
| `git_status`                    | `@caelush/coding-agent` | `createGitStatusTool`                                                                                                             |
| `git_diff`                      | `@caelush/coding-agent` | `createGitDiffTool`                                                                                                               |
| Default set and frozen order    | `@caelush/coding-agent` | `createDefaultCodingTools`, `DEFAULT_CODING_TOOL_ORDER`                                                                           |
| Git exposure                    | `@caelush/coding-agent` | `withoutGitTools`, `GIT_TOOL_NAMES`, `GitToolAvailability`                                                                        |
| Operations ports (8)            | `@caelush/coding-agent` | `ReadFileOperations` … `GitOperations`                                                                                            |
| Runtime adapters (4)            | `@caelush/coding-agent` | `createRuntimeReadOnlyOperations`, `createRuntimePatchOperations`, `createRuntimeProcessOperations`, `createRuntimeGitOperations` |
| Read/list kind probes           | `@caelush/coding-agent` | `readFileWithKind`, `listDirectoryWithKind`, `CodingToolPathKind`                                                                 |
| Coding overlay contract         | `@caelush/coding-agent` | `CodingToolDefinition`, `CodingToolSecurityMetadata`                                                                              |
| Coding catalog                  | `@caelush/coding-agent` | `CodingToolCatalog`, `CodingToolCatalogBuilder`, `createCodingToolCatalog`                                                        |
| Security facts vocabulary       | `@caelush/coding-agent` | `ToolSecurityFacts` (single declaration)                                                                                          |
| Per-Tool security facts         | `@caelush/coding-agent` | nine `project*SecurityFacts` functions                                                                                            |
| Approval identity               | `@caelush/coding-agent` | `computeCodingToolApprovalKey`                                                                                                    |
| Effect vocabulary               | `@caelush/coding-agent` | `ToolEffect`                                                                                                                      |
| Effect projection               | `@caelush/coding-agent` | `projectReadFileEffect`, `projectPatchEffects`, `projectExecEffects`, `projectStdinEffects`                                       |
| Effect → AgentState             | `@caelush/coding-agent` | `applyToolEffectsToAgentState`, `effectsChangeAgentState`                                                                         |
| Effect → durable events         | `@caelush/coding-agent` | `toolEffectsToEvents`                                                                                                             |
| Settlement extension encoder    | `@caelush/coding-agent` | `createCodingToolSettlementExtensionProjector`                                                                                    |
| Settlement extension decoder    | `@caelush/coding-agent` | `createCodingToolSettlementExtensionDecoder`                                                                                      |
| Output policy                   | `@caelush/coding-agent` | `boundToolModelContent`, `DEFAULT_TOOL_OUTPUT_POLICY`                                                                             |
| Prompt snippets                 | `@caelush/coding-agent` | `CODING_TOOL_PROMPT_SNIPPETS`, `promptSnippetFor`                                                                                 |
| Prompt delivery into Context    | `@caelush/coding-agent` | `createToolPromptContextProvider`                                                                                                 |
| Admission translation           | `@caelush/coding-agent` | `createCodingToolAdmissionPort`                                                                                                   |
| Durable metadata projection     | `@caelush/coding-agent` | `createCodingToolDurableMetadataPort`                                                                                             |
| Durable invocation gate binding | `@caelush/coding-agent` | `createDurableInvocationGatePort`                                                                                                 |

### A.3 Cross-layer ports (the only multi-owner rows, and why)

```text
contract declared in @caelush/agent        implemented in @caelush/security
  ToolExecutionGatePort                      CaelushToolExecutionGate
  ToolApprovalRequestFactory                 createV1ToolApprovalRequestFactory
  ToolPresentationPort                       CaelushToolPresentation
  ToolResultSanitizerPort                    CaelushToolResultSanitizer
  ToolExecutionUpdateSanitizerPort           CaelushToolExecutionUpdateSanitizer

contract declared in @caelush/agent        implemented in @caelush/storage
  ToolExecutionStorePort                     SqliteToolExecutionStore
  ToolBudgetAdmissionPort                    createSqliteToolBudgetAdmission
  ToolSettlementExtensionDecoder (host)      supplied by the daemon composition

contract declared in @caelush/agent        implemented in @caelush/coding-agent
  ToolAdmissionPort                          createCodingToolAdmissionPort
  ToolDurableMetadataPort                    createCodingToolDurableMetadataPort
```

Each pair is one responsibility with a frozen contract and one implementation. None of them is two
authorities over the same decision.

### A.4 Host layer — `@caelush/core` and `apps/daemon`

| Current responsibility         | Owner              | Symbol                                                     |
| ------------------------------ | ------------------ | ---------------------------------------------------------- |
| Run lifecycle                  | `@caelush/core`    | `RunController`                                            |
| Run-bound Tool turn adaptation | `@caelush/core`    | `RunToolTurnCoordinator`                                   |
| Frozen Tool turn contract      | `@caelush/agent`   | `ToolTurnCoordinator`, `ToolTurnRequest`, `ToolTurnResult` |
| Context token projection seam  | `@caelush/core`    | `toContextObservationProjection`                           |
| Completion authority           | `@caelush/core`    | `CompletionGate`, `RunController`                          |
| Production Tool composition    | `apps/daemon`      | `apps/daemon/src/daemon-composition.ts`                    |
| Default Tool derivation        | `apps/daemon`      | `createDefaultCodingTools` → registry → catalog            |
| Settlement decoder wiring      | `apps/daemon`      | `createCodingToolSettlementExtensionDecoder`               |
| Runtime implementation         | `@caelush/runtime` | `LocalRuntime`, `RuntimeWorkspaceScope`                    |

`@caelush/core` owns no Tool algorithm. Its one Tool-adjacent object translates the frozen Tool turn
contract into a canonical `ToolBatchRequest` and maps the outcome back; it names no registry, store,
security context, execution environment or Runtime.

---

## B. Retirement ledger — every removed surface, with its evidence

| Surface                                                      | Class         | Replaced by                                                 | Guarded by                                        |
| ------------------------------------------------------------ | ------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `packages/tools` (whole package)                             | DELETE        | the owners in §A                                            | Phase 4F guard — directory absent                 |
| `ToolDispatcher`                                             | DELETE        | the four canonical authorities                              | Phase 4F guard — no class, no construction        |
| legacy `ToolBatchCoordinator`                                | DELETE        | `createToolBatchCoordinator`                                | Phase 4F guard — single batch authority           |
| `ToolBatchItemResult`                                        | DELETE        | `ToolBatchItemOutcome` + `ToolExecutionSnapshot`            | Phase 4F guard — no interface                     |
| `ToolRegistryBuilder` / `ToolRegistry` / `ResolvedTool`      | DELETE        | `DefaultAgentToolRegistryBuilder`, `AgentToolRegistry`      | Phase 4F guard — no class                         |
| `filterToolRegistryForEnvironment`                           | DELETE        | the definition list, decided before anything is built       | Phase 4E guard — one exposure authority           |
| `ToolPreflight`                                              | DELETE        | `createToolCallPreparer`                                    | Phase 4F guard — no class                         |
| `ToolFailureMemory`                                          | DELETE        | not in the V2 pipeline                                      | Phase 4F guard — no class, no pre-check owner     |
| `ToolRegistration` / `LegacyCodingToolMetadata`              | DELETE        | `AgentTool` + `CodingToolDefinition`                        | Phase 4F guard — no interface                     |
| `createToolExecutionDependencies`                            | DELETE        | `createToolInvocationExecutor` + `createToolResultPipeline` | Phase 4F guard — single declaration each          |
| execution-store, invocation-lifecycle, event-factory facades | DELETE        | the canonical durable modules                               | Phase 4F guard — declared once, in `agent`        |
| `toLegacyToolExecutionStore` / `LegacyToolExecutionCommit`   | DELETE        | `ToolExecutionStorePort` alone                              | Phase 4F guard — no symbol                        |
| `toCanonicalApprovalLookup` / `toCanonicalToolBudgetPort`    | DELETE        | the canonical ports                                         | Phase 4F guard — no symbol                        |
| `createLegacyToolSettlementExtensionProjector`               | DELETE        | `createCodingToolSettlementExtensionProjector`              | Phase 4F guard — Coding owns encode and decode    |
| `createLegacyToolSettlementExtensionDecoder`                 | MOVE + RENAME | `createCodingToolSettlementExtensionDecoder`                | kind byte-identical; guard asserts it             |
| `computeToolApprovalKey`                                     | DELETE        | `computeCodingToolApprovalKey`                              | fidelity suite — 81 keys deterministic            |
| `ToolModelGuidance` and its three functions                  | DELETE        | `CodingToolDefinition.promptSnippet` → Context              | Phase 4E/4F guards — no folding algorithm         |
| `ToolCallingDebugEvent` / `ToolCallingDebugPort`             | DELETE        | dead since Phase 4D; no replacement                         | Phase 4F guard — no symbol                        |
| `SecurityToolDefinition`                                     | DELETE        | `ToolGateMetadata`                                          | Phase 4F guard — single gate metadata contract    |
| nine legacy builtin facades + 4 family builders              | DELETE        | the nine Coding factories                                   | Phase 4E guard — declared exactly once, in Coding |
| `protocol.ToolDefinitionSchema`                              | DELETE        | `AgentTool` / `AIToolSpec` / `CodingToolDefinition`         | Phase 4F guard — not exported                     |
| `protocol.ToolDefinition`                                    | DELETE        | the same three                                              | Phase 4F guard — no production consumer           |
| `toAIToolSpec`                                               | DELETE        | `AgentToolRegistry.modelSpecs()`                            | Phase 4F guard — not exported                     |
| `modelDefinitions()`                                         | REPLACE       | `modelSpecs(): readonly AIToolSpec[]`                       | Phase 4F guard — declared in one place            |
| `ToolGateMetadata`                                           | MOVE          | `@caelush/agent` (security re-exports the names)            | Phase 4F guard — single declaration               |

### B.1 Retained deliberately

```text
protocol.ToolName / ToolNameSchema        a durable identity primitive
protocol.ToolInvocation / its statuses    the persisted row; shape and values unchanged
protocol.ToolObservation                   the persisted observation
protocol.ApprovalRequest                   the persisted approval row
ToolSecurityContext / assertToolSecurityContext   the canonical admission context
ToolDurableMetadataPort                    the Protocol v1 `riskLevel` migration seam
the storage Tool budget legacy answer      the ledger's own `admit`/`admitBatch` still answer in it
```

The last two are recorded as retained **seams**, not oversights. `ToolDurableMetadataPort` exists only
because Protocol v1 persists `riskLevel` on the invocation row, and the budget answer exists because the
ledger's own legacy entry points still speak it. Both are named in their source with their exit
condition: a later round that removes the persisted field, or migrates those calls, deletes them.

---

## C. Legacy test retirement ledger

Every deleted suite, with the canonical test that carries the behaviour forward. Nothing was deleted on
the grounds that "Phase 4E already tested it"; each row names the replacement.

| Deleted suite (in `packages/tools/test`)      | Behaviour it guarded              | Replacement                                                    |
| --------------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `apply-patch.test.ts`                         | the patch Tool contract           | `coding-agent/test/builtins/apply-patch.test.ts`               |
| `approval-key.test.ts`                        | approval identity stability       | `coding-agent/test/authority-fidelity.test.ts` (81 keys)       |
| `argument-validation.test.ts`                 | argument preparation              | canonical Preparer suites in `packages/agent/test`             |
| `batch-coordinator.test.ts`                   | batch semantics                   | canonical batch suite in `packages/agent/test`                 |
| `builtin-security-facts.test.ts`              | per-Tool security facts           | `coding-agent/test/builtins/*` + `security-facts-contracts`    |
| `catalog-consistency.test.ts`                 | registry ↔ catalog alignment      | `coding-agent/test/coding-tool-catalog.test.ts`                |
| `contracts.test.ts`                           | legacy DTO shapes                 | obsolete — the DTOs are retired                                |
| `default-tools.test.ts`                       | the nine defaults and their order | `coding-agent/test/authority-fidelity.test.ts` + daemon E2E    |
| `dispatcher-*.test.ts` (7 suites)             | the retired Dispatcher lifecycle  | canonical coordinator suites in `agent`, then `storage`        |
| `event-factory.test.ts`                       | durable Tool event drafts         | `agent` durable-events assertions                              |
| `exec-command.test.ts`                        | the shell Tool contract           | `coding-agent/test/builtins/exec-command.test.ts`              |
| `execution-environment.test.ts`               | the environment locator           | `packages/agent/test` Tool-type suites                         |
| `git-tools.test.ts`                           | the two Git Tools                 | `coding-agent/test/git-status-runtime.test.ts`                 |
| `invocation-lifecycle.test.ts`                | the transition table              | `packages/agent/test` durable lifecycle suites                 |
| `json-canonical.test.ts`                      | canonical JSON encoding           | canonical `json-canonical` suite in `packages/agent/test`      |
| `model-guidance.test.ts`                      | guidance folding                  | obsolete — the folding algorithm is retired                    |
| `output-policy.test.ts`                       | the durable content bound         | canonical result-policy suite in `packages/agent/test`         |
| `preflight.test.ts`                           | `ToolPreflight`                   | canonical `ToolCallPreparer` suites                            |
| `presentation-boundary.test.ts`               | presentation is non-authoritative | `packages/security/test` presentation assertions               |
| `public-api.test.ts`                          | the legacy public surface         | obsolete — the surface is retired                              |
| `read-only-filesystem-tools.test.ts`          | the four read Tools               | `coding-agent/test/builtins/*` + `runtime-adapters`            |
| `registry*.test.ts` (3 suites)                | the legacy registry               | `packages/agent/test` registry suites                          |
| `schema-*.test.ts` (2 suites)                 | schema policy and compilation     | canonical schema suites in `packages/agent/test`               |
| `security-catalog-characterization.test.ts`   | catalog characterisation          | `coding-agent/test/coding-tool-catalog.test.ts`                |
| `security-context.test.ts`                    | the security context              | canonical `ToolSecurityContext` suite in `packages/agent/test` |
| `security-facts-contracts.test.ts`            | facts contract stability          | `coding-agent/test/builtins/*`                                 |
| `shell-runtime-integration.test.ts`           | shell integration                 | `coding-agent/test/runtime-adapters.test.ts`                   |
| `shell-tools.test.ts` · `write-stdin.test.ts` | the two process Tools             | `coding-agent/test/builtins/*`                                 |
| `stale-process-uncertainty.test.ts`           | uncertain side effects            | `coding-agent/test/builtins/*` + `agent` uncertainty suites    |
| `tool-effects.test.ts`                        | the effect vocabulary             | `coding-agent/test` effects suites                             |
| `tool-execution-delegation.test.ts`           | delegation to the canonical pair  | daemon composition suites                                      |
| `tool-exposure.test.ts`                       | Git exposure                      | daemon E2E + `coding-agent` default-tools suite                |
| `tool-failure-memory.test.ts`                 | `ToolFailureMemory`               | obsolete — not in the V2 pipeline                              |
| `tool-system-delegation.test.ts`              | legacy delegation                 | obsolete — every delegate is deleted                           |

### C.1 Migrated suites outside the deleted package

| Suite                                                        | Disposition                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `apps/daemon/test/tool-execution-result-composition.test.ts` | live assertions re-pointed at the canonical registry and pipeline; retired-internal assertions dropped |
| `apps/daemon/test/tool-composition-delegation.test.ts`       | re-pointed at the canonical production assembly, including the numeric normalization path              |
| `apps/daemon/test/agent-tool-round-trip-wire.test.ts`        | canonical coordinator; the wire round trip is unchanged                                                |
| `apps/daemon/test/tool-batch-production-composition.test.ts` | `modelSpecs()`                                                                                         |
| `apps/daemon/test/daemon-composition.test.ts`                | `modelSpecs()`; the guidance assertion became structural                                               |
| `packages/core/test/run-tool-turn-driver.test.ts`            | canonical batch errors                                                                                 |
| `packages/core/test/architecture.test.ts`                    | dead allowlist entry became a permanent no-dependency rule                                             |
| `packages/core/test/agent-tool-batch.test.ts`                | canonical `ToolExecutionSnapshot` fixtures                                                             |
| `packages/core/test/tool-observation-projection.test.ts`     | same                                                                                                   |
| `packages/core/test/agent-loop-request.test.ts`              | `AIToolSpec` catalog                                                                                   |
| `packages/core/test/agent-loop-integration.test.ts`          | `AIToolSpec` catalog                                                                                   |
| `packages/security/test/secure-composition.test.ts`          | canonical registry + catalog + 3-argument coverage check                                               |
| `packages/security/test/dispatcher-integration.test.ts`      | rewritten against `gate.decide` with four-field metadata                                               |
| `packages/security/test/input-policy.test.ts`                | facts vocabulary from the Coding layer                                                                 |
| `packages/storage/test/*` (8 suites)                         | canonical store port, snapshot, commit and settlement decoder                                          |
| `tests/integration/tool-catalog.test.ts`                     | canonical registry; `modelSpecs()` is the model catalog                                                |
| `tests/integration/openai-compatible-wire-contract.test.ts`  | `DEFAULT_CODING_TOOL_ORDER` + `modelSpecs()`; snapshot unchanged                                       |
| `packages/coding-agent/test/authority-fidelity.test.ts`      | **re-authored** as a self-contained canonical regression fixture                                       |
| `apps/launcher/test/architecture.test.ts`                    | dead entry removed; permanent workspace rule added                                                     |
| `packages/protocol/test/tool.test.ts`                        | durable primitives kept, retirement asserted                                                           |
| `packages/protocol/test/public-api.test.ts`                  | required export list updated; retirement asserted                                                      |

### C.2 Fidelity fixture preservation

```text
kept       the expected behavioural fixtures — real workspace, real Tools, per-scenario expected output
dropped    the legacy implementation as an oracle
replaced   the comparison with direct assertions against those expected values

no fixture, bound, default, error code, effect, security fact or prompt snippet was weakened,
and no legacy implementation was recreated to keep a comparison alive.
```

---

## D. Architecture guards — Phase 4F

```text
tests/architecture/phase-4f-tool-system-final-boundaries.test.ts     38 tests

  legacy package gone        directory absent · no manifest edge · no import · no deep import
  protocol retirement        schema and type gone · durable primitives intact · no production consumer
  one authority each         Agent Kernel · nine Coding builtins · Coding product assets ·
                             security-facts vocabulary · durable security context
  no reverse legacy edge     every package that once depended on it is clean · Coding one-way off Agent
  no legacy declarations     ToolDispatcher · batch · registry · preflight · failure memory ·
                             execution-store facade · durable error classes
  Runtime isolation          broad capability out of the builtins; confined to the adapters
  prompt, effects, cancel    guidance out of descriptions · Agent cannot interpret a Coding effect ·
                             sequential execution · a Tool cannot end a Run
  Phase 3 frozen contracts   every frozen declaration still in its frozen file · single owners
  production composition     the canonical chain, and nothing beside it
  workspace closure          no dangling build-graph reference · every tsconfig reference resolves
```

Every Phase 4A–4E round guard was re-pointed rather than deleted: an assertion whose subject was removed
was restated as the permanent rule it stood for, and a comparison that needed a deleted oracle was
replaced by direct assertions on the expected values. No guard was weakened into a tautology.

---

## E. Verification ledger

| Gate                         | Result                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| `pnpm build`                 | PASS — whole workspace                                            |
| `pnpm typecheck`             | PASS — workspace build + root `tsc` + every package               |
| `pnpm lint`                  | PASS — 0 errors                                                   |
| `pnpm check:architecture:ci` | PASS — 26 entries · 0 new · 0 stale · READY                       |
| `pnpm test`                  | PASS — 443 files · 2985 passed · 5 skipped · 0 failed             |
| `git diff --check`           | PASS                                                              |
| Prettier, changed files      | PASS — every changed file, under the checkout's own line endings  |
| Clean checkout               | PASS — fresh install, build, typecheck, lint, architecture, tests |
| Targeted Phase 4 suites      | PASS — 47 files · 635 tests                                       |

Two environment findings are recorded in the final report §9.1 rather than claimed as bare passes:

```text
pnpm format:check fails in this working copy because it carries CRLF line endings while
.prettierrc.json sets no endOfLine. A detached worktree of the Phase 4E tip fails it identically, so it
is pre-existing; every file this round touched is clean under the same override.

pnpm test is flaky under this host's default 16-way file parallelism: a small, different set of
real-daemon and real-subprocess tests exceeds its 5 s timeout on each parallel run, and every one of
them passes in isolation. Run serially (pnpm exec vitest run --no-file-parallelism) the suite is
deterministic: 443 files · 2985 passed · 5 skipped · 0 failed. That serial run is the measurement of
record.
```

### E.1 Baseline

```text
before 4F   27 entries · 0 new · 0 stale · READY
after 4F    26 entries · 0 new · 0 stale · READY
```

One entry retired: `STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_TOOLS`, the storage manifest's dependency on
the deleted package. It was removed with the checker's own writer, nothing was added, and no other entry
changed. The provenance pin still records the last audited rule-set expansion.

---

## F. Whole-phase gate — the questions, answered

```text
Does production depend on legacy Tool System V1?                NO
Does repository active source require packages/tools?           NO
Is there more than one Tool execution authority?                NO
Is there more than one batch authority?                         NO
Is there more than one Coding builtin authority?                NO
Does Agent interpret Coding-specific facts?                     NO
Can Tool end a Run?                                             NO
Is real Tool execution parallel?                                NO
Did Phase 4 change a Phase 3 frozen contract?                   NO
Did Phase 4 add a database migration?                           NO
Did Phase 4 change a persisted Protocol shape?                  NO
Did any round enable real parallel Tool execution?              NO
```

---

## G. Closing

```text
Phase 4F COMPLETE.

Phase 4 Tool System V2 migration is COMPLETE.

All migration-era Tool compatibility surfaces have been
retired from active source.

The legacy @caelush/tools package has been removed.

The legacy protocol.ToolDefinition contract has been retired.

Production now depends only on the canonical Tool System V2
authorities established by Phases 4A through 4E.

No Phase 5 work has started.
```
