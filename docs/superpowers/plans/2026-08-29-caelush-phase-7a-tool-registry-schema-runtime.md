# Caelush Phase 7A Tool Registry and Schema Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the first Caelush Tool Kernel with validated, immutable registrations whose model catalog and runtime handlers are always derived from one registry snapshot, without executing tools.

**Architecture:** `@caelush/protocol` remains the source of truth for JSON-safe `ToolDefinition`, `ToolName`, `ToolInvocation`, `RiskLevel`, and `Capability` contracts. `@caelush/tools` binds each protocol definition to one `ToolHandler`, validates and compiles both schemas at build time through one strict Ajv runtime, freezes the copied registration set, and exposes model definitions plus resolved runtime validators. Provider-specific projection remains in `@caelush/llm`; no Tool Dispatcher, persistence, events, permission evaluation, or host execution is added.

**Tech Stack:** TypeScript ESM, Node.js 24, pnpm 11, Vitest, Zod 4 protocol contracts, Ajv 8.20.0 exact pin, Prettier, ESLint.

**Spec:** User-provided `pasted-text.txt` Phase 7A requirements; architecture document produced in `docs/architecture/tool-system.md`.

## Global Constraints

- Phase 7 contains exactly 7A, 7B, and 7C; do not add extra Phase 7 rounds.
- `ToolRegistry` is the single source of truth for active tools and model-visible definitions.
- A registration binds one `ToolDefinition` to one `ToolHandler`; duplicate `ToolName` registration fails closed.
- The registry is immutable after build; definitions and nested JSON schemas are copied and deeply frozen at registration boundaries.
- Input and output schemas compile once at registry build time and never coerce, default, remove properties, or mutate validation values.
- Phase 7A input and output schemas require object roots and top-level `additionalProperties: false`; external refs, async schemas, and custom keywords are not supported.
- No lossy schema compaction; oversized schemas and catalogs fail registration/build instead of being truncated or hidden.
- Model-facing projection contains only `name`, `description`, and `inputSchema`; risk, capabilities, runtime requirements, and output schema stay runtime metadata.
- `ToolExecutionResult.content` is model-facing text and `details` is structured runtime/UI data; output schema validates `details` only.
- Phase 7A does not execute handlers, create `ToolInvocation`/`ToolObservation`, persist output, publish tool events, evaluate permissions, request approvals, or add Filesystem/Shell/Process/Git/MCP/Tool Search/Code Mode functionality.
- `@caelush/tools` may depend on `@caelush/protocol` and exact `ajv` only; it must not depend on Core, Context, Storage, Events, Runtime, Security, Verification, Daemon, or LLM.
- All production changes are introduced by RED → GREEN → REFACTOR; every focused RED failure is recorded in the completion report.
- Base is `origin/codex/phase-6c-run-controller-persistence` at the freshly verified reference SHA; do not merge master.

## Architecture References

| Source                                                                                                                                      | Observed design                                                                                                                   | What Caelush adopts                                                                                                       | What Caelush intentionally does NOT copy                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [Codex `gpt_5_1_prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md)                                      | Global instructions describe tool use, safety, selection, and patch behavior independently from callable tool data.               | Keep prompt guidance outside the registry; keep tool descriptions concise and put argument guidance in schema properties. | No Phase 7A prompt composer, cross-tool policy layer, or AgentLoop change.                                                        |
| [Codex `tool_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_spec.rs)                                           | A model-facing `ToolSpec` carries names, descriptions, schemas, and supports multiple exposure kinds.                             | Treat definition/schema as the model prompt surface and preserve a deterministic model catalog.                           | No namespaces, deferred exposure, `tool_search`, web tools, or Code Mode. All successful Phase 7A registrations are direct tools. |
| [Codex `tool_definition.rs`](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_definition.rs)                               | A definition is metadata/schema that downstream runtime adapters consume; output schema and deferred loading are separate fields. | Reuse existing Caelush `ToolDefinition` without a V2 type and keep output schema as runtime metadata.                     | No `ToolDefinitionV2`, provider SDK types, or deferred-loading flag.                                                              |
| [Codex `tool_executor.rs`](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_executor.rs)                                   | Runtime executor owns the callable behavior and can expose metadata/search surfaces.                                              | Bind one handler to one definition in one registration so spec and runtime cannot drift.                                  | No executor lifecycle, hook runtime, permission integration, telemetry, cancellation, or dynamic registration.                    |
| [Codex `tool_output.rs`](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_output.rs)                                       | Tool output separates model response conversion from logging/structured runtime concerns and applies explicit limits.             | Separate `content` from `details`, and provide an explicit UTF-8-safe model-content bounding helper.                      | No Codex response-item/history/hooks/logging contracts or tool-specific truncation.                                               |
| [Codex `json_schema.rs`](https://github.com/openai/codex/blob/main/codex-rs/tools/src/json_schema.rs)                                       | Schema support is modeled as data and handles object ordering/structured schema traversal deliberately.                           | Canonicalize JSON object keys for deterministic byte budgets while preserving array order and schema semantics.           | No hand-written validator, lossy schema sanitization, or provider-specific schema subset beyond Phase 7A policy.                  |
| [Codex `registry.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/registry.rs)                                        | Registry assembles a set of executable tools and their specs; runtime routing resolves from that set.                             | Use a single ordered Map-backed immutable registry and enforce model-catalog-to-resolve consistency.                      | No Core-owned registry, hooks, sandbox tags, analytics, session state, or execution routing.                                      |
| [Codex `router.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs)                                            | Router normalizes calls and chooses a tool source/surface before dispatch.                                                        | Reserve `resolve(name)` for the future Dispatcher and keep Phase 7A resolution side-effect free.                          | No router, call normalization, source heuristics, or tool execution.                                                              |
| [Codex `spec_plan.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)                                      | A composition plan explicitly registers concrete handlers and their specs into the active set.                                    | Make startup/configuration-time registration and build the only way to create the active snapshot.                        | No built-in tool list, host composition root, or concrete tool implementations.                                                   |
| [Codex `apply_patch_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)               | Concrete tool specification is a small model-facing description/format contract while runtime handler is elsewhere.               | Keep definition descriptions focused on purpose and boundaries, not global instructions.                                  | No `apply_patch` tool, filesystem access, freeform grammar, or Phase 8 handler.                                                   |
| [Codex `request_user_input_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) | Argument-specific usage guidance lives in nested schema property descriptions.                                                    | Preserve this separation in schema input properties.                                                                      | No user-input control tool or UI integration.                                                                                     |
| [Codex `tool_search_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs)               | Deferred tool discovery has its own search schema, source metadata, and description budgeting.                                    | Apply bounded catalog metadata and explicit fail-closed budgets.                                                          | No deferred loading, searchable sources, or dynamic catalogs.                                                                     |
| [Codex `permissions_instructions.rs`](https://github.com/openai/codex/blob/main/codex-rs/prompts/src/permissions_instructions.rs)           | Permission behavior is generated as a separate prompt/instruction layer from tool specs and runtime.                              | Keep `riskLevel`, `requiredCapabilities`, and `runtimeRequirements` as opaque metadata only.                              | No authorization, approval, sandbox, or permission prompt evaluation in 7A.                                                       |
| [Codex issue #30648](https://github.com/openai/codex/issues/30648)                                                                          | Prompt-documented tools can drift from actually registered tools, leaving the model with an unavailable function.                 | Add architecture/integration tests proving every model definition resolves in the same registry snapshot.                 | No Codex-specific `apply_patch` registration workaround or prompt patching.                                                       |

## File Map

- Modify `packages/protocol/src/events/tool.ts`, `packages/protocol/src/events/index.ts` only if needed for the privacy-safe `tool.requested` payload; update `packages/protocol/test/event.test.ts` and `packages/protocol/test/tool.test.ts`.
- Modify `packages/tools/package.json` and `pnpm-lock.yaml` through `pnpm add --filter @caelush/tools ajv@8.20.0`; keep the package independent from all execution layers.
- Create focused `packages/tools/src/errors.ts`, `json-canonical.ts`, `schema-runtime.ts`, `schema-policy.ts`, `execution-result.ts`, `handler.ts`, `output-policy.ts`, `registration.ts`, `registry-builder.ts`, and `registry.ts`; export only Caelush-owned public types from `packages/tools/src/index.ts`.
- Create focused tests under `packages/tools/test/` for privacy-independent contracts, canonical bytes, schema runtime/policy, output policy, builder/registry, immutability, catalog consistency, and public API.
- Add `docs/architecture/tool-system.md`; update `README.md`, `AGENTS.md`, and architecture boundary tests for Phase 7A claims and dependency guards.
- Add cross-layer characterization coverage only in existing `packages/llm/test/openai-compatible-tools.test.ts` or an architecture/integration test; `packages/tools` never imports `@caelush/llm` or AI SDK code.

## Execution Tasks

### Task 1: Research and baseline

- [x] Fetch origin and select the actual Phase 6-containing base.
- [x] Read the required Codex prompt/spec/runtime sources and issue #30648.
- [x] Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`; record `124` test files, `418` passed, `2` skipped, and the current historical formatting debt.
- [x] Write Architecture References in this plan and preserve the explicit Phase 7A/7B/7C boundary.

### Task 2: Tool event privacy hardening

**Files:** modify `packages/protocol/src/events/tool.ts`; test `packages/protocol/test/event.test.ts`.

- [ ] RED: replace the `tool.requested` fixture with a payload containing `invocationId`, `toolName`, `externalCallId?`, and `riskLevel`, and assert a JSON-stringified event omits `args`, `error`, `startedAt`, and `finishedAt`, including `CAELUSH_TOOL_SECRET_42`.
- [ ] Run the focused protocol event test and observe the expected schema mismatch.
- [ ] GREEN: change only the `tool.requested` payload schema; leave `tool.started`, `tool.completed`, `tool.failed`, and `tool.output` unchanged.
- [ ] Run protocol focused tests, then refactor only if needed while retaining secret absence.

### Task 3: Tool runtime contracts

**Files:** create `packages/tools/src/handler.ts`, `execution-result.ts`, `registration.ts`, `errors.ts`; modify `packages/tools/src/index.ts`, `packages/tools/package.json`; test `packages/tools/test/contracts.test.ts`.

- [ ] RED: define tests for `ToolExecutionRequest` fields (`RunId`, `StepId`, `ToolInvocationId`, `externalCallId`, readonly JSON args), exact `ToolExecutionResult` (`content`, `details`, `isError`), and one registration binding a definition to one handler without an independent handler name.
- [ ] Run the focused test and observe missing exports/types.
- [ ] GREEN: add type-only contracts and typed configuration errors without any handler invocation or runtime dependency.
- [ ] Run tools typecheck/tests and refactor after green.

### Task 4: Canonical JSON and option/error primitives

**Files:** create `packages/tools/src/json-canonical.ts`, `errors.ts`; test `packages/tools/test/json-canonical.test.ts`, `registry-options.test.ts`.

- [ ] RED: cover lexicographically sorted object keys, preserved array order, UTF-8 byte counts, and rejection of non-positive/non-finite registry/output limits.
- [ ] Run focused tests and observe missing helpers.
- [ ] GREEN: implement JSON-value-only canonicalization, deterministic `JSON.stringify`, UTF-8 `Buffer.byteLength`, default budgets (`64`, `8192`, `5000`, `16384`, `262144`), and typed error reasons.
- [ ] Run focused tests and refactor with no semantic array sorting.

### Task 5: Strict Ajv schema runtime

**Files:** create `packages/tools/src/schema-runtime.ts`; modify `packages/tools/package.json`; test `packages/tools/test/schema-runtime.test.ts`.

- [ ] RED: cover valid/invalid object schemas, wrong primitive types, missing required fields, arrays/enums/compositions/local `$defs`, capped issues (16 plus `truncatedIssueCount`), no input mutation, no raw input/schema in issues, and malformed/remote/async schemas failing closed.
- [ ] Run the focused suite and observe missing runtime behavior.
- [ ] GREEN: create one explicit `ToolSchemaRuntime` with Ajv `allErrors:true`, `strict:true`, `coerceTypes:false`, `useDefaults:false`, `removeAdditional:false`, no `loadSchema`, no custom keywords/formats; wrap validators behind Caelush-owned `CompiledToolSchema`, `ToolSchemaValidationResult`, and `ToolSchemaIssue`.
- [ ] Run focused tests and verify generated declarations expose no Ajv types.

### Task 6: Definition and schema semantic policy

**Files:** create `packages/tools/src/schema-policy.ts`; modify `packages/tools/src/registry-builder.ts` later; test `packages/tools/test/schema-policy.test.ts`.

- [ ] RED: reject non-object roots, missing/true top-level `additionalProperties`, remote refs, `$async:true`, malformed schemas, whitespace-only/oversized descriptions, oversized input/output schemas, and accept local `$defs` recursion when Ajv compiles deterministically.
- [ ] Run focused policy tests and observe missing semantic validation.
- [ ] GREEN: validate protocol `ToolDefinitionSchema.safeParse()` first, then semantic schema policy, byte budgets, and strict runtime compilation without rewriting schemas.
- [ ] Run policy/runtime tests and refactor only after all remain green.

### Task 7: Output policy

**Files:** create `packages/tools/src/output-policy.ts`; modify `packages/tools/src/index.ts`; test `packages/tools/test/output-policy.test.ts`.

- [ ] RED: cover exact unchanged ASCII, exact byte boundary, over-budget ASCII/Chinese/emoji/multibyte content, explicit truncation marker counted within budget, marker-too-large deterministic safe prefix, and invalid policy limits.
- [ ] Run focused tests and observe absent bounding behavior.
- [ ] GREEN: validate positive integer `maxModelContentBytes`; implement `boundToolModelContent(content, policy)` with UTF-8-safe code-point boundaries, no trim, explicit marker, and no details truncation.
- [ ] Run focused tests and refactor with deterministic boundary behavior.

### Task 8: Registry builder

**Files:** create `packages/tools/src/registry-builder.ts`; test `packages/tools/test/registry-builder.test.ts`.

- [ ] RED: cover empty/single/multiple registration, stable registration order, duplicate name rejection (`DUPLICATE_TOOL_NAME`), max tool limit, atomic build failure with no partial registry, build-time input/output compilation, and register-after-build/second-build semantics.
- [ ] Run focused tests and observe absent builder behavior.
- [ ] GREEN: copy and protocol-validate definitions at `register`, defer complete schema compilation and aggregate catalog budgeting to `build`, use a `Map<ToolName, ...>`, return the same immutable registry on repeated `build`, and fail closed after finalization.
- [ ] Run focused builder tests and refactor only after green.

### Task 9: Immutable registry

**Files:** create `packages/tools/src/registry.ts`; modify `registry-builder.ts`; test `packages/tools/test/registry.test.ts`, `immutability.test.ts`.

- [ ] RED: cover `size`, `has`, `resolve`, `names`, `modelDefinitions`, missing resolution, caller top-level/nested schema mutation, returned definition mutation, and handler identity preservation.
- [ ] Run focused tests and observe missing registry behavior.
- [ ] GREEN: deep-copy/deep-freeze JSON metadata and definitions, retain opaque handler identity, expose ordered snapshots only, and expose Caelush-owned compiled validators without mutable maps or Ajv internals.
- [ ] Run focused tests and refactor while keeping handler state allowed but registry structure immutable.

### Task 10: Catalog/runtime consistency and E2E contract

**Files:** create `packages/tools/test/catalog-consistency.test.ts`, `e2e.test.ts`; modify architecture tests if required.

- [ ] RED: construct `echo_value` and `lookup_value`, build the registry, assert model count equals registry size, every model definition resolves, valid/invalid input and extra fields behave correctly, output `details` validation is correct, and handler execution count remains zero.
- [ ] Run focused tests and observe absent end-to-end behavior.
- [ ] GREEN: expose model definitions only from the registry snapshot and enforce catalog-byte limits over normalized `name`/`description`/`inputSchema` metadata; reject overflow atomically without truncated schemas.
- [ ] Run focused tests and refactor only after consistency invariants pass.

### Task 11: LLM projection characterization

**Files:** modify `packages/llm/test/openai-compatible-tools.test.ts` or add `tests/integration/tool-catalog.test.ts`; no dependency from tools to llm.

- [ ] RED/characterization: feed `registry.modelDefinitions()` into `LLMRequestSchema`, call the existing `toAISDKTools()` test seam, and assert provider definitions contain only `name` by map key, `description`, and `inputSchema`, with no `riskLevel`, `requiredCapabilities`, `runtimeRequirements`, `outputSchema`, or `execute`.
- [ ] Run the characterization test and record `CHARACTERIZATION PASS` if it already passes before implementation changes.
- [ ] GREEN: make only the smallest projection/test adjustment needed to preserve the existing provider boundary; never import AI SDK from `packages/tools`.
- [ ] Run focused LLM tests and architecture SDK-isolation tests.

### Task 12: Architecture/docs/audit and completion

**Files:** modify `AGENTS.md`, `README.md`, architecture boundary tests; create `docs/architecture/tool-system.md`; modify package exports/manifests and tests as needed.

- [ ] RED: add architecture assertions for allowed `tools → protocol`, forbidden feature-package/app/LLM imports, zero AI SDK/filesystem/network/child-process/SQLite/EventBus access, no production handler calls, no invocation/observation/event creation, and public declarations without Ajv/ValidateFunction/ErrorObject.
- [ ] GREEN: update docs with the fixed three-round Phase 7 boundary, Prompt Guidance/Tool Definition/Tool Runtime separation, registry invariant, Codex issue lesson, schema/output policy, security boundary, and Phase 8/9 boundaries; update README to say the registry is validated/immutable but tools are not executable yet.
- [ ] Run changed-file format checks, full format check, all focused tests, lint, typecheck, test, build, `pnpm check`, `git diff --check`, and static audits; compare formatting failures to baseline without formatting unrelated debt.
- [ ] Remove generated `dist`/`tsbuildinfo` only through explicit Node filesystem operations, reinstall frozen dependencies, rerun clean verification, inspect `git status --short` and `git diff`, commit focused changes, push the actual branch without force, and verify local/remote SHA equality.

## Verification Commands

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm check
git diff --check
git status --short
```

Changed-file formatting is checked with `git diff --name-only 74da683c657fa47d01880fb380e4d1b4bef22912...HEAD` filtered to supported Prettier files. Generated artifacts are removed only by explicit Node filesystem operations; `git clean`, reset, force checkout, force push, and master merges are prohibited.
