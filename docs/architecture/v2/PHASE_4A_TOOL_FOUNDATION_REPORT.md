# Caelush Architecture V2 — Phase 4A Tool Foundation Report

```text
PHASE 4A — Tool contracts, canonical registry, schema & call-preparation migration
branch    deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
base      Phase 3F  b96e25ed90b289b36123de8f048506318bc28e5d
```

Phase 4A is the first of the six frozen Phase 4 rounds. It moved the **executable Tool contract, the
canonical schema compiler and policy, the immutable Tool registry, call preparation and the Coding
Tool overlay contracts** into their target packages, and turned `@caelush/tools` into a compatibility
facade that delegates to them.

It did **not** build a durable Tool execution pipeline, a batch coordinator, an executor, an admission
coordinator, a settlement coordinator, the nine Coding builtins, or the production cleanup. Those are
4B, 4C, 4D, 4E and 4F.

---

## 1. Phase identity and the fixed six rounds

```text
4A  Tool contracts, general Registry, schema, call preparation, Coding catalog foundation, legacy entry adaptation
4B  Invocation Executor, Result Pipeline, safe transient updates
4C  Admission, Approval/Budget, Settlement, Durable Coordinator, Storage atomic-commit adaptation
4D  Batch, Model Feedback, Result Normalizer, production ToolTurn wiring
4E  All nine Coding builtins, Operations, Runtime adapters, Coding metadata/effects/presentation/prompt
4F  Final production assembly, legacy production dependency removal, compatibility retirement, whole-phase acceptance
```

Frozen in [PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md](PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md). No `4A-1`, no `4G`,
no work moved from 4A into 4B, and no part of 4B–4F implemented early.

---

## 2. Baseline, branch, final SHA

|                       | Value                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| Repository            | `D:/Develop/Caelush`                                                                 |
| Base branch           | `deepseek/architecture-v2-phase-3f-agent-loop-closure`                               |
| Base SHA              | `b96e25ed90b289b36123de8f048506318bc28e5d`                                           |
| Base ancestor of HEAD | yes (`git merge-base --is-ancestor` exit 0)                                          |
| Working branch        | `deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation`               |
| Starting working tree | clean; the branch did not exist locally or on the remote, so nothing was overwritten |
| Remote                | `https://github.com/GehrmannMerlin/Caelush.git`                                      |

---

## 3. Specifications actually read

Read in full, from the attachments that were supplied, not from a report or a code comment:

```text
Caelush_Tool_System_V2_Refactor_Spec.md                     4015 lines, 155 sections
Caelush_Tool_System_V2_Current_to_Target_Interface_Freeze.md 6196 lines, 230+ sections
```

Read from the repository, at the Phase 3F baseline:

```text
AGENTS.md
docs/architecture/v2/MIGRATION_EXECUTION_CONTRACT.md
docs/architecture/v2/PHASE_3F_AGENT_LOOP_CLOSURE_REPORT.md
docs/architecture/v2/PHASE_3_AGENT_LOOP_MIGRATION_SUMMARY.md
docs/architecture/v2/PHASE_3_RESPONSIBILITY_AND_COMPATIBILITY_INVENTORY.md
docs/architecture/v2/PHASE_3_FROZEN_CLAUSE_ACCEPTANCE_MAP.md
scripts/architecture/v2-rules.mjs
scripts/architecture/legacy-import-baseline.json
```

No required document was missing, so no clause was guessed.

---

## 4. Source scan and document divergence

Every path in the authorising scope was located and read; none had moved. The scan covered
`packages/tools/src/**` (41 modules plus 15 builtins), `packages/agent/src/**`,
`packages/core/src/{run-tool-turn-coordinator,agent-tool-results,agent-tool-batch}.ts`,
`packages/security/src/{tool-gate,tool-result-sanitizer,default-composition}.ts`,
`packages/storage/src/tool-execution-store.ts`, `apps/daemon/src/daemon-composition.ts`, the
`@caelush/ai` tool contracts, the package manifests, the tsconfigs, the Vitest discovery and the
architecture checker.

The two Tool documents were written at `master @ c5489f75…`; the implementation baseline is Phase 3F.
The divergence list, with each item's disposition, is
[PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md](PHASE_4A_TOOL_CONTRACT_ACCEPTANCE_MAP.md) §1. The four
findings that changed what 4A had to do:

```text
1  `AgentToolResult` already existed and was already root-exported by Phase 3, with different fields
2  no `ToolCallPreparer` existed; `ToolPreflight` + `validateToolArguments` did its work
3  `packages/tools` is a legacy package, so the facade may import the target but never the reverse
4  a legacy registration carries Coding metadata *inside* `ToolDefinition`, not beside it
```

---

## 5. Before / after responsibility inventory

| Responsibility                                                                    | Before 4A                                                   | After 4A                                                                                   | Exit round for the remainder              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Executable Tool contract                                                          | `packages/tools` `ToolHandler` + `ToolDefinition`           | `@caelush/agent` `AgentTool` (extends AI's `AIToolSpec`)                                   | 4F removes the legacy view                |
| Raw execution result                                                              | `packages/tools/src/execution-result.ts`                    | `@caelush/agent` `AgentToolResult<TDetails>`; legacy name is a type alias                  | 4F                                        |
| Execution identity / mode / updates                                               | flat `ToolExecutionRequest` fields, no mode, no updates     | `ToolExecutionIdentity`, `ToolExecutionMode`, `ToolExecutionUpdate(+Sink)`                 | 4B implements the sink                    |
| Schema compilation                                                                | `packages/tools/src/schema-runtime.ts`, one AJV instance    | `@caelush/agent` `tools/schema/schema-runtime.ts`, one AJV instance                        | —                                         |
| Schema and catalog policy                                                         | `packages/tools/src/schema-policy.ts` over `ToolDefinition` | `@caelush/agent` `tools/schema/schema-policy.ts` over `AIToolSpec` + `resultDetailsSchema` | —                                         |
| JSON canonicalization                                                             | `packages/tools/src/json-canonical.ts`                      | `@caelush/agent` `tools/schema/json-canonical.ts`; legacy re-exports                       | —                                         |
| Tool registration / resolution                                                    | `packages/tools` `ToolRegistry(Builder)`                    | `@caelush/agent` `AgentToolRegistry(Builder)`; legacy facade projects it                   | 4F                                        |
| Model tool catalog                                                                | legacy `modelDefinitions(): ToolDefinition[]`               | canonical `modelSpecs(): AIToolSpec[]`; legacy still returns `ToolDefinition[]`            | 4F                                        |
| Argument preparation                                                              | none (validation only)                                      | `@caelush/agent` `ToolCallPreparer`                                                        | 4D switches the production rejection path |
| Argument validation                                                               | `packages/tools/src/argument-validation.ts`                 | canonical validator + one normalizer in `@caelush/coding-agent`; legacy entry delegates    | 4F                                        |
| Coding overlay metadata                                                           | fields on `ToolRegistration` / `ToolDefinition`             | `@caelush/coding-agent` `CodingToolDefinition` + `CodingToolCatalog`                       | 4E moves the builtins' metadata           |
| Security facts / effects / presentation                                           | `packages/tools` implementations                            | contracts remain; implementations stay legacy                                              | 4E                                        |
| Invocation lifecycle, admission, execution, result pipeline, settlement, recovery | `ToolDispatcher`                                            | unchanged                                                                                  | 4B / 4C                                   |
| Batch and model feedback                                                          | `ToolBatchCoordinator` + Core projection                    | unchanged                                                                                  | 4D                                        |
| The nine builtins                                                                 | `packages/tools/builtins`                                   | unchanged; their AgentTool adaptation is used                                              | 4E                                        |

---

## 6. Production registration and argument-preparation call chain

```text
createDefaultBuiltinToolRegistrations(runtimeResolver)          @caelush/tools, unchanged
        ↓
new ToolRegistryBuilder().register(registration)                compatibility facade
        ↓  resolveAgentToolRegistration                        @caelush/tools adapters
        ↓  DefaultAgentToolRegistryBuilder.register(tool)       @caelush/agent  ← canonical
        ↓  build(): compile input + result schemas, budgets, freeze
        ↓  buildAgentRegistry() / buildCodingCatalog()
activeToolRegistry = filterToolRegistryForEnvironment(registry, exposure)
        ↓  re-registers every resolved entry, AgentTool and coding metadata together
createV1SecureToolDispatcher({ registry, normalization, ... })   @caelush/security
        ↓
new ToolDispatcher({ ... })                                      compatibility facade
        ↓  createToolCallPreparer(registry.agentRegistry(), { normalization })   ← canonical
        ↓  dispatcher.prepareToolCall(request) and preflightBudget() route through it
ToolBatchCoordinator → RunController                              Phase 3D/3F, untouched
```

`apps/daemon/src/daemon.ts` builds the default registration set once, awaits
`ToolRegistryBuilder.buildCodingCatalog()` — which is where `@caelush/coding-agent` refuses a dangling
Coding entry — and hands the same registrations to `composeDaemon`, so the catalog and the active
registry are built from one registration set rather than two.

---

## 7. `AgentToolResult` collision resolution and public export mapping

```text
Phase 3, unchanged   run/ports/tool-turn.ts
                     export interface AgentToolResult { externalCallId, toolName, content, isError }
                     root export name and all four fields kept exactly

Tool V2, new         tools/types/tool-result.ts
                     export interface AgentToolResult<TDetails extends JsonObject = JsonObject>
                       { content, details, isError }
                     `AgentTool.execute()` returns this type

root mapping         export type { AgentToolResult as AgentToolExecutionResult }
                       from "./tools/types/tool-result.js";
```

The alias is an export mapping, not a third DTO: one declaration of the execution-result structure
exists, and neither type grew the other's fields. No union, no intersection, no optional-field
merging, no change to the frozen `ToolTurn` contract, and no new deep import.

Same-name exports were checked and mapped the same way:

```text
ToolExecutionResult     packages/tools  → type alias for AgentToolExecutionResult
ToolPresentationPort    packages/tools  → re-export of the agent declaration
ToolSchemaRuntime       packages/tools  → re-export of the agent declaration
ToolExecutionEnvironment agent port shape, structurally identical to protocol.ToolExecutionEnvironment
```

---

## 8. Contracts and files added or moved

```text
packages/agent/src/tools/
  index.ts
  types/         execution-mode · execution-identity · execution-environment · tool-update
                 execution-input · tool-result · tool-feedback · tool-presentation
                 agent-tool · errors
  schema/        schema-runtime · schema-policy · json-canonical
  registry/      registry · registry-builder
  call/          tool-call-preparer (contracts) · tool-call-preparer-impl (factory)

packages/coding-agent/src/tools/
  index.ts · security-metadata · coding-tool-definition · coding-tool-catalog
  coding-tool-catalog-builder · legacy-argument-normalization

packages/tools/src/ (compatibility layer)
  tool-system-bridge · tool-adapters · legacy-definition · legacy-argument-validation
  registry · registry-builder · options · schema-runtime · schema-policy · json-canonical
  preflight · registration · execution-result · presentation · tool-exposure · dispatcher
  index  (all re-pointed at the canonical implementations)

tests and docs
  tests/architecture/phase-4a-tool-contract-boundaries.test.ts
  packages/agent/test/tools-{registry,call-preparation,independent-use}.test.ts
  packages/coding-agent/test/coding-tool-catalog.test.ts
  packages/tools/test/tool-system-delegation.test.ts
  apps/daemon/test/tool-composition-delegation.test.ts
```

---

## 9. Canonical implementation locations

```text
AgentTool, AgentToolResult, ToolExecutionIdentity, ToolExecutionMode,
ToolExecutionUpdate(+Sink), AgentToolExecutionInput, AgentToolExecutionEnvironment,
ToolFailureFeedback, ToolFailureDisposition, ToolArgumentPreparationError     @caelush/agent
JSON canonicalization, the AJV runtime and policy, schema semantic policy     @caelush/agent
AgentToolRegistry, ResolvedAgentTool, AgentToolRegistryBuilder,
the model-spec projection                                                     @caelush/agent
ToolCallRequest, PreparedToolCall, ToolCallPreparationOutcome,
ToolCallPreparer and its factory                                              @caelush/agent
CodingToolSecurityMetadata, CodingToolDefinition, CodingToolCatalog,
the numeric compatibility normalization                                       @caelush/coding-agent
```

Every one of those has exactly one declaration site outside barrel files. The Phase 4A architecture
guard asserts it.

---

## 10. Legacy entry points, remaining consumers, compatibility reason, exit round

| Legacy entry                                    | Compatibility reason                                                                  | Remaining consumers                                                         | Exit round |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| `ToolRegistryBuilder`                           | production composition and ~20 test suites construct it                               | `apps/daemon`, `packages/security`, `packages/storage`, `tests/integration` | 4F         |
| `ToolRegistry` / `ResolvedTool`                 | the dispatcher and the environment filter read it, and its DTOs are asserted in tests | `packages/tools`, `packages/security`                                       | 4F         |
| `ToolPreflight`                                 | the dispatcher's preflight seam                                                       | `packages/tools`                                                            | 4D         |
| `validateToolArguments` / `ToolValidationError` | a public validation entry with its own tests and message format                       | `packages/tools`                                                            | 4F         |
| `ToolSchemaRuntime`                             | imported by three legacy modules                                                      | `packages/tools`                                                            | 4F         |
| `ToolDefinition` (protocol)                     | durable invocation shape and the legacy definition                                    | everything legacy                                                           | 4F         |
| `ToolDispatcher`                                | owns the whole durable pipeline                                                       | production                                                                  | 4B–4D      |
| `ToolBatchCoordinator`                          | owns batch ordering and outcome union                                                 | production                                                                  | 4D         |
| `ToolRegistration.adapters`                     | carries the canonical AgentTool and the classified coding metadata                    | `packages/tools`                                                            | 4F         |
| `DEFAULT_BUILTIN_TOOL_ORDER`                    | the frozen default catalog and its order                                              | production and tests                                                        | 4E         |

Compatibility flows legacy → target only. `@caelush/tools` depends on `@caelush/agent` and reaches
`@caelush/coding-agent` through a cached dynamic import declared in `tool-system-bridge.ts`; no target
package imports `@caelush/tools`, and the guard enforces it.

---

## 11. Numeric normalization, model guidance and environment filtering

**Numeric normalization.** Scope is a value whose own JSON Schema declares `number` or `integer`;
conversion uses JSON number grammar only, and an `integer` field additionally requires a safe integer;
recursion follows declared `properties` and declared array `items`. Fuzzy strings (`"soon"`,
`"3 seconds"`, `"0x10"`), undeclared properties, missing fields and defaults are untouched. AJV keeps
`coerceTypes: false`, so the conversion is a declared Tool hook rather than a validator mode. It has
one implementation (`packages/coding-agent/src/tools/legacy-argument-normalization.ts`), is applied
only to registrations that opted into it, and a generic `AgentTool` registered directly on
`AgentToolRegistry` receives none.

**Model guidance.** Unchanged and still observable: guidance is validated, copied, frozen, folded
into the description before the catalog byte budget is measured, and returned by
`ToolRegistry.modelGuidance()`. The registry/test evidence is `tool-system-delegation`,
`model-guidance` and `default-tools`.

**Environment filtering.** `filterToolRegistryForEnvironment` still rebuilds the registry from the
resolved entries and still hides `git_status`/`git_diff` unless Git is `AVAILABLE`, failing closed for
`UNKNOWN`. It now re-registers each entry's canonical `AgentTool` and coding metadata together, so the
filtered registry and the filtered Coding overlay cannot disagree, and the filter resolves nothing by
itself.

---

## 12. What the new Preparer does, what the legacy shell still does

| Concern                                                      | Canonical Preparer (4A)             | Legacy `ToolDispatcher` shell (still) |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------------------- |
| resolve a Tool                                               | yes, against the canonical registry | resolves through the same registry    |
| raw argument bound                                           | yes, before any hook runs           | via the Preparer through preflight    |
| defensive copy                                               | yes                                 | yes                                   |
| `prepareArguments` / normalization                           | yes, then bounds the result         | same hook, via the adapter            |
| strict input schema validation                               | yes, after preparation              | after normalization, as it always did |
| creates a ToolInvocation                                     | **never**                           | **creates one when arguments fail**   |
| durable argument-failure record                              | none                                | `persistArgumentFailure`, unchanged   |
| admission, approval, budget, execution, settlement, recovery | not present                         | owns all of it                        |

The target semantics and the shell's compatibility semantics are deliberately different in this
round. Switching the production rejection path — so that a pre-invocation rejection creates no
Invocation — is a **4D** acceptance item, and 4A does not claim that the whole production Tool
pipeline satisfies Tool System V2. 4A did not change the frozen `ToolTurnResult`, fabricate an
Invocation, reuse a mismatched outcome type, or import 4D's work to close the gap.

---

## 13. Behaviour changes

**None in production behaviour.** Phase 4A is a structural migration:

```text
Tool names and order          unchanged   read_file, list_directory, find_files, search_text,
                                          apply_patch, exec_command, write_stdin, git_status, git_diff
provider-visible input schema unchanged   the same schemas, byte-identical to the frozen catalog
default limits                unchanged   64 / 8192 / 5000 / 16384 / 262144
argument semantics            unchanged   the same normalized, frozen args reach the same handlers
error contracts               unchanged   the same error classes, reasons and message formats
durable rows and events       unchanged   no table, migration, column or event changed
security metadata             unchanged   risk level, capabilities and runtime requirements still reach
                                          the durable invocation and the Security composition
approval and budget           unchanged   key computation, exactness and admission order untouched
```

Two deliberate, non-production changes are stated:

```text
1  five test files were adapted to the facade's behaviour rather than the reverse:
     registry-builder.test.ts      the invalid-schema case now asserts the specific reason, because
                                   the canonical policy reports the same reason the legacy policy did
                                   but through the base error class
     registry-options.test.ts      reads the frozen defaults under the legacy option name
     tool-exposure.test.ts         unchanged behaviour, re-pointed at the same public entry
     phase-3a/2c/3f package-boundaries guards
                                   their expected dependency and export surfaces were widened for the
                                   two new package edges, `ajv`, and the new Tool exports, each with a
                                   comment naming Phase 4A
     package-boundaries.test.ts    the "one AJV importer" assertion moved from
                                   `packages/tools/src/schema-runtime.ts` to
                                   `packages/agent/src/tools/schema/schema-runtime.ts`
2  `AgentToolRegistryBuilder.build()` gained an optional `ToolSchemaRuntime` parameter, so the legacy
   facade projects validators compiled by the same runtime the canonical build used instead of
   creating a second compiler
```

One behaviour is _newly covered_ rather than changed: `isJsonObject` now refuses a thenable, so a
`prepareArguments` hook written as `async` is reported as the contract violation it is instead of
being handed to schema validation.

---

## 14. Test results and baseline difference

### 14.1 This round

```text
pnpm test (full)              453 files · 2659 passed · 5 skipped · 0 failed
targeted rerun after formatting
  packages/agent · coding-agent · tools · security · storage · tests/architecture · apps/daemon
                              181 files · 1037 passed · 0 failed
```

New coverage this round:

| Suite                                                          | Tests | What it establishes                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent/test/tools-registry.test.ts`                   | 18    | duplicates, tool limit, stable order, build behaviour, immutability under caller mutation, the exact three-field model projection, no coercion/defaults/removal, result-schema validation, budgets and option validation |
| `packages/agent/test/tools-call-preparation.test.ts`           | 17    | unknown Tool, no hook, hook then validation, size limits on both payloads, error classification, argument isolation, identity preservation, zero side effects, the frozen Phase 3 shapes                                 |
| `packages/agent/test/tools-independent-use.test.ts`            | 5     | register → build → `modelSpecs()` → prepare, with `@caelush/agent` alone                                                                                                                                                 |
| `packages/coding-agent/test/coding-tool-catalog.test.ts`       | 14    | name correspondence, dangling rejection, duplicates, immutability, no execution, the normalization's exact scope                                                                                                         |
| `packages/tools/test/tool-system-delegation.test.ts`           | 13    | the legacy facades really delegate; the nine defaults are intact; guidance, filtering and preflight behaviour preserved                                                                                                  |
| `apps/daemon/test/tool-composition-delegation.test.ts`         | 6     | the production composition reaches the canonical registry and Preparer, including the normalization                                                                                                                      |
| `tests/architecture/phase-4a-tool-contract-boundaries.test.ts` | 11    | the structural guards listed in §15                                                                                                                                                                                      |

### 14.2 Historical baseline, for contrast only

The Phase 3F report recorded 2575 passed / 0 failed / 5 skipped over 446 files. This round's numbers
are its own; the historical values are quoted only to show the direction.

### 14.3 Environment notes

```text
ripgrep   `rg` is installed (15.2.0) but is not on this shell's PATH. Suites that shell out to the
          fixed ripgrep backend are run with its directory prepended to PATH for the command. Without
          that, the two search_text integration tests fail as RIPGREP_UNAVAILABLE — the same
          environmental condition the Phase 3F report recorded, not a code defect.

web build the known dist race between apps/web/test/browser-safe-build.test.ts and
          apps/daemon/test/web-session-lifecycle.test.ts did not occur in either full run this round
          (453/453 files passed both times).
```

---

## 15. Architecture guards added

`tests/architecture/phase-4a-tool-contract-boundaries.test.ts`:

```text
Agent Tool framework imports no Coding, Runtime, Storage, Security or legacy Tool code, and no subpath
a general AgentTool declares no Coding field and does not restate AIToolSpec
ResolvedAgentTool has exactly three fields; the registry is free of security/effect metadata
modelSpecs projects exactly name, description, inputSchema
exactly one production module imports the schema compiler and declares the AJV policy
exactly one module declares the numeric compatibility normalization
no target package imports @caelush/tools; each legacy entry name has one declaration site
the legacy facade delegates rather than reimplementing (no second compiler, no second validator)
CodingToolDefinition composes `tool`, and the catalog refuses a dangling overlay
no executor/scheduler/admission/settlement class and no concurrency primitive was added
no migration file and no daemon route mentions the new Tool contracts
the Phase 3 Tool turn contract is structurally unchanged and the alias mapping is exactly as specified
```

Three existing guards were widened, each with a comment naming Phase 4A:
`package-boundaries` (dependencies, the AJV importer), `phase-2c` (the deliberate root export
surface), `phase-3a` (the one bounded host-vocabulary exception for the execution locator) and
`phase-3f` (`ajv` on the agent package).

---

## 16. Architecture baseline

```text
                              before   after
rule set version              2        2
active rules                  276      276
workspace projects            21       21
scanned source files          574      601
parsed module specifiers      2947     3077
workspace source edges        446      495
workspace manifest edges      54       61
legacy violations frozen      31       31
baseline entries              31       31
new violations                0        0
stale baseline entries        0        0
private subpath imports       0        0
cross-project relative imports 0       0
readiness                     READY    READY
```

The baseline did not grow and was not regenerated. No entry was removed, because this round resolved
no dependency edge — it moved code between packages that already had, or newly and legitimately
gained, an allowed edge.

---

## 17. build / typecheck / lint / format / diff

```text
pnpm build                    exit 0
pnpm typecheck                exit 0   (tsc --build for every package, root tsc --noEmit, per-package)
pnpm lint                     exit 0
pnpm check:architecture:ci    exit 0   boundaries PASS · verify PASS · readiness READY
pnpm test                     exit 0   453 files · 2659 passed · 5 skipped
git diff --check              exit 0   no whitespace error
prettier --check <changed files>   all matched files use Prettier code style
```

`pnpm format:check` over the whole repository still fails for pre-existing files this round never
touched, for the reason the Phase 3F report recorded: `core.autocrlf=true` checks files out with
CRLF while Prettier expects LF. Every file this round created or modified was formatted and passes;
no unrelated file was reformatted.

---

## 18. Verification not performed, and why

```text
browser smoke                 not run; it exercises the Web session fixture, and 4A changes no UI,
                              route or SSE contract
whole-repository format:check not a pass, for the recorded CRLF reason; the changed-file check passes
full suite in the clean clone  not run; the clean environment reported no new problem and the seven
                              key suites in it passed. The whole suite was run twice on the working
                              checkout instead (453/453 files, 2659 passed, 5 skipped)
```

---

## 19. Git delivery

```text
base                    b96e25ed90b289b36123de8f048506318bc28e5d
branch                  deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
code head               f5850101e3ebb352df24f8419a9f015dbbe91482
remote                  https://github.com/GehrmannMerlin/Caelush.git
remote branch           refs/heads/deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
remote slug             deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
tracking                origin/deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
```

The clean-checkout reproduction in §19.1 was cloned at the code head,
`f5850101e3ebb352df24f8419a9f015dbbe91482`. A single documentation-only commit follows it and changes
no source file; the branch tip after that commit, the remote parity check and the working-tree state
are recorded in the appended delivery note, so the report never claims a SHA it was not verified at.

The four commits, in order:

```text
219198d  feat(agent): own the executable Tool contract, registry, schema and call preparation
1d24b09  refactor(tools): delegate registry, schema and preparation to the canonical implementation
52ea4e2  test(architecture): guard the Phase 4A Tool boundaries and prove the delegation
f585010  docs(architecture): record the Phase 4 round plan and the Phase 4A contract map
```

No merge, no force push, no rewrite of any Phase 1–3 commit, and no automatic merge into
`master`/`main`. Nothing was deployed, released or published.

### 19.1 Clean-checkout verification

Reproduced in an isolated directory, cloned from the remote at
`f5850101e3ebb352df24f8419a9f015dbbe91482`:

```text
git clone --branch deepseek/architecture-v2-phase-4a-... --single-branch    exit 0
pnpm install --frozen-lockfile                                              exit 0
pnpm build                                                                  exit 0
pnpm check:architecture:ci                                                  exit 0
  boundaries PASS · verify PASS · readiness READY · 31 baseline entries · 0 new · 0 stale
7 key test files (84 tests)                                                 passed
```

The clean environment reported no new problem, so the whole suite was not re-run there.

### 19.2 Environment adaptation

As in Phase 3F, this host reaches GitHub through a local HTTP proxy that git does not read by
default, so the proxy was passed per command rather than written into the repository or the user's git
configuration. No credential appears in any command, log or document. `rg` is installed but is not on
this shell's `PATH`, so suites that shell out to the fixed ripgrep backend were run with its directory
prepended for that command.

### 19.3 Delivery note

```text
code head                f5850101e3ebb352df24f8419a9f015dbbe91482
branch tip (docs only)   one documentation-only commit follows the code head and changes no source
remote ref               refs/heads/deepseek/architecture-v2-phase-4a-tool-contract-registry-preparation
remote parity            `git ls-remote origin <branch>` equals local HEAD
working tree             clean
tracking                 up to date with origin on this branch
```

The commits on the base, in order:

```text
219198d  feat(agent): own the executable Tool contract, registry, schema and call preparation
1d24b09  refactor(tools): delegate registry, schema and preparation to the canonical implementation
52ea4e2  test(architecture): guard the Phase 4A Tool boundaries and prove the delegation
f585010  docs(architecture): record the Phase 4 round plan and the Phase 4A contract map
         docs(architecture): record the Phase 4A git delivery and clean-checkout verification
```

The code head is the SHA the full suite, the architecture gate and the clean-checkout reproduction
were all verified at. The trailing documentation commit records this section and touches no source
file, so it cannot invalidate any verification above.

Nothing was merged, force-pushed, rewritten, deployed, released or published.

---

## 20. Work not started

```text
4B  ToolInvocationExecutor · ToolResultPipeline · transient update sink and sanitizer
4C  admission · approval · budget · settlement · DurableToolExecutionCoordinator · Storage commit
4D  batch coordinator · model feedback projector · result normalizer · production ToolTurn rejection path
4E  the nine builtins · Operations ports · Runtime adapters · Coding facts/effects/presentation/prompt
4F  final assembly · legacy production dependency removal · facade retirement · whole-phase acceptance
```

Also not started, and not part of Phase 4: parallel Tool execution, `terminate: true`, MCP, Skills,
Browser, Web Search, Multi-Agent, a remote Runtime, an OS sandbox, and any change to Security V2,
Context V2, Memory V2 or Message/Session V2.

---

## 21. Verdict

```text
Phase 4A — Tool contracts, canonical registry & call-preparation migration: COMPLETE
```

with one explicit limitation: the production Tool execution pipeline is still the legacy
`ToolDispatcher`, and 4A deliberately did not rewrite its outer outcome or persistence behaviour. The
canonical implementations own the executable contract, schema compilation, registration/resolution
and argument preparation today; the durable pipeline, batch, builtins and production cleanup remain
with 4B–4F exactly as [PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md](PHASE_4_TOOL_SYSTEM_ROUND_PLAN.md) fixes them.

Not claimed: Tool System V2 complete, a durable Tool pipeline, parallel execution, or any 4B–4F work.