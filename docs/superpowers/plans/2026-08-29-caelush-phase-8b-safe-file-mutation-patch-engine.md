# Caelush Phase 8B Safe File Mutation & Patch Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one verified `apply_patch` capability to the Phase 8A local runtime so an Agent can safely apply bounded Add/Update/Delete/Move changes with all-file preflight guards, best-effort rollback, and durable uncertainty semantics.

**Architecture:** Keep `packages/tools` as a thin Tool adapter and place parsing, planning, preparation, path safety, byte/version guards, commit, rollback, and post-commit verification in a narrow patch capability owned by `@caelush/runtime`. The pipeline is `PatchParser → PatchDocument → PatchPlanner → PreparedPatch → PatchCommitter → PatchCommitResult`; parsing and preparation perform no mutation, every affected path is guarded before the first mutation, and a committed prefix is rolled back on ordinary commit failure. Runtime uncertainty is represented by a runtime-owned typed error and mapped to the existing Tool `UNCERTAIN_SIDE_EFFECT` durable marker without making the Tool package part of the runtime dependency graph.

**Tech Stack:** TypeScript/ESM, Node.js 24 native filesystem primitives, SHA-256, Vitest, existing `@caelush/protocol`, `@caelush/runtime`, `@caelush/tools`, and Phase 8A `WorkspacePathResolver`/`RuntimeWorkspaceScope`.

**Spec:** `C:\Users\韩吉衍\.codex\attachments\47b94aa2-fed7-4ce7-9f38-f8e8130d821c\pasted-text.txt`

## Global Constraints

- Reuse Phase 8A `LocalRuntime`, `RuntimeWorkspaceScope`, `WorkspacePathResolver`, `RuntimeFileSystem`, and `ToolExecutionEnvironment`; do not create V2 copies or a second runtime path.
- Phase 8B is the only current phase; do not implement AgentLoop, shell/process runtime, Git runtime, final default catalog, approvals, or future Phase 8 work.
- Parse ≠ Plan ≠ Commit; prepare every operation and guard every affected path before any workspace mutation.
- This is transactional best effort only: it is not an OS-level atomic transaction, crash-atomic, exactly-once, or fully transactional filesystem.
- No generic public blind-write/delete API, no shell/Git delegation, no watcher/event side channel, no Storage migration/table, and no direct file events or `AgentState.changedFiles`.
- Patch input is exactly `{ patch: string }`; strict schema has no defaults and rejects unknown properties.
- Enforce `MAX_PATCH_BYTES = 256 KiB`, `MAX_PATCH_FILES = 100`, `MAX_PATCH_HUNKS = 1000`, `MAX_PATCH_TARGET_FILE_BYTES = 8 MiB`, `MAX_PATCH_PREPARED_BYTES = 32 MiB`, and the existing 8A 4096 UTF-8-byte path budget; effective invocation args must still respect `DEFAULT_MAX_INVOCATION_ARGS_BYTES`.
- Existing source files must be regular, strict UTF-8 text; preserve BOM, dominant/tie-first newline style, final newline, and exact bytes for unchanged operations. New files use UTF-8 LF without BOM.
- Mutation never traverses a symlink; sources and existing ancestors are checked with no-follow metadata; missing destination parents may be created only after existing ancestor containment/symlink checks and are removed only when empty during rollback.
- Infrastructure failures throw typed runtime/tool errors; expected model-recoverable failures return bounded Tool error results without host paths, raw patch text, file content, credentials, or internal IDs.
- Every production behavior is introduced through a failing test first; each task ends with focused verification and a small commit.
- Completion requires fresh lint, typecheck, test, build, changed-file Prettier zero warnings, baseline-aware full check, clean diff/status, and local/remote 8B SHA equality after a normal push.

## Baseline and Delivery Gates

- 8A remote gate completed before this plan: local and remote `codex/phase-8a-local-runtime-filesystem-read-search` both resolve to `42416cb980c728594aee85f0da7fb79b5618b0e1`; it is not an ancestor of `origin/master`, so this worktree starts from the remote 8A branch.
- Worktree: `D:\Develop\Caelush\.worktrees\phase-8b-safe-file-mutation-patch-engine`; branch: `codex/phase-8b-safe-file-mutation-patch-engine`.
- Baseline: `pnpm lint`, `pnpm typecheck`, `pnpm test` (157 files, 541 passed, 3 skipped), and `pnpm build` pass. `pnpm format:check`/`pnpm check` fail only on the existing 447-file Prettier debt; no baseline lint/type/test/build failure is accepted.
- Before push, assert `git diff --check`, `git status --short`, changed-file formatting, full verification, and `git rev-parse HEAD == git ls-remote origin refs/heads/codex/phase-8b-safe-file-mutation-patch-engine`.

## Architecture References

| Source | Observed design | Adopted idea | Intentionally different Caelush design |
|---|---|---|---|
| [Codex apply_patch handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch.rs) and [runtime](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/runtimes/apply_patch.rs) | Handler validates/coordinates while runtime applies a verified action; partial deltas are explicit. | Keep Tool handler thin and make runtime own verified patch execution and structured changes. | No Codex sandbox, permission profile, cancellation token, remote environment, or provider-specific protocol. |
| [Codex parser](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/parser.rs) and [patch library](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/lib.rs) | Strict envelope, Add/Delete/Update/Move, `@@` chunks, EOF marker, parser independent from filesystem. | Use a pure parser and explicit Update chunk model including move-only/update+move. | Caelush adds byte/operation budgets, strict model-facing errors, mutation symlink policy, and all-file preflight. |
| [OpenCode apply_patch](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/apply_patch.ts) | Precomputes file changes, preserves BOM, produces per-file summaries, separates permission metadata. | Prepare all changes in memory and return bounded structured deltas. | No LSP, formatter, watcher/event side channel, `permission ask()`, or remote environment; stale content is rejected by SHA/size guards. |
| [OpenCode core patch tool](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/apply-patch.ts) | Uses a separate mutation service and conditional-write concept. | Keep mutation implementation behind a narrow runtime capability. | Caelush requires rollback of the committed prefix and typed uncertain side effects. |

## File Map

- Create `packages/runtime/src/patch/types.ts`: JSON-safe patch document, plan, prepared operation, version, result, limits, and narrow injectable mutation port.
- Create `packages/runtime/src/patch/errors.ts`: sanitized expected patch errors and `RuntimePatchUncertainError`.
- Create `packages/runtime/src/patch/parser.ts`: pure strict envelope/directive/hunk parser with no filesystem imports.
- Create `packages/runtime/src/patch/text.ts`: strict UTF-8, BOM/newline/final-newline metadata, logical line conversion, and bounded re-encoding.
- Create `packages/runtime/src/patch/planner.ts`: path resolution, symlink/type/size checks, read-only preparation, dry hunk application, SHA-256 versions, and aggregate budget.
- Create `packages/runtime/src/patch/committer.ts`: deterministic sequential commit, patch-private filesystem operations, reverse-prefix rollback, and exact rollback verification.
- Create `packages/runtime/src/patch/service.ts`: `RuntimePatchService` orchestration for Parse → Plan → Prepare → Guard → Commit.
- Modify `packages/runtime/src/workspace-path.ts`, `workspace-scope.ts`, `local-runtime.ts`, `runtime-errors.ts`, and `index.ts` to reuse 8A scope/path boundaries and expose only the narrow runtime patch capability.
- Create `packages/runtime/test/patch-*.test.ts` and extend `workspace-path.test.ts`/architecture tests for parser, encoding, symlinks, guards, operations, rollback, and no-blind-write boundaries.
- Create `packages/tools/src/builtins/apply-patch.ts` and `packages/tools/src/builtins/file-mutation-tools.ts`; modify `packages/tools/src/index.ts`, dispatcher error handling, and relevant batch/integration tests.
- Create/update `docs/architecture/patch-engine.md`, `docs/architecture/runtime.md`, `docs/architecture/tool-system.md`, `README.md`, and `AGENTS.md` to describe the 8B boundary without overclaiming atomicity or permissions.

### Task 1: Establish patch contracts and strict parser

**Files:**
- Create: `packages/runtime/src/patch/types.ts`, `packages/runtime/src/patch/errors.ts`, `packages/runtime/src/patch/parser.ts`.
- Test: `packages/runtime/test/patch-parser.test.ts`, `packages/runtime/test/patch-contracts.test.ts`.

**Interfaces:**
- `parsePatch(patch: string): PatchDocument` is pure and throws `RuntimePatchError` with codes such as `INVALID_PATCH`, `EMPTY_PATCH`, `PATCH_TOO_LARGE`, `TOO_MANY_FILES`, and `TOO_MANY_HUNKS`.
- `PatchDocument` contains ordered Add/Update/Delete operations; Update contains ordered hunks and optional `moveTo`, while all paths remain untrusted workspace-relative strings until runtime resolution.
- `PatchOperation`, `PatchHunk`, `FileVersion`, `PreparedPatch`, `PatchCommitResult`, `PatchChange`, `PatchMutationFileSystem`, and `RuntimePatchRequest` are defined once in runtime and contain no Tool, Storage, Node SDK, or provider types.

- [ ] **Step 1: Write failing parser tests** for missing/extra envelope lines, empty patches, unknown/malformed directives, duplicate/conflicting source blocks, duplicate move destinations, Add/Delete/Update/Move syntax, EOF marker, CRLF normalization, hunk counts, and byte/file budgets.
- [ ] **Step 2: Run `pnpm vitest run packages/runtime/test/patch-parser.test.ts packages/runtime/test/patch-contracts.test.ts` and confirm the missing parser/contract failure.**
- [ ] **Step 3: Implement the pure parser and bounded JSON-safe contracts.** Parse only the strict marker grammar; do not resolve paths, read files, or mutate.
- [ ] **Step 4: Re-run the focused tests and then `pnpm typecheck`; refactor only while green.**
- [ ] **Step 5: Commit `feat(runtime): add strict patch parser contracts`.**

### Task 2: Add mutation-safe path and text preparation primitives

**Files:**
- Modify: `packages/runtime/src/workspace-path.ts`, `packages/runtime/src/workspace-scope.ts`, `packages/runtime/src/local-runtime.ts`, `packages/runtime/src/runtime-errors.ts`, `packages/runtime/src/index.ts`.
- Create: `packages/runtime/src/patch/text.ts`, `packages/runtime/src/patch/planner.ts`.
- Test: `packages/runtime/test/patch-path-safety.test.ts`, `packages/runtime/test/patch-text.test.ts`, `packages/runtime/test/patch-preparation.test.ts`.

**Interfaces:**
- `WorkspacePathResolver.resolveMutationTarget(relativePath, options)` permits an absent leaf but rejects absolute/traversal/NUL/oversize input, external real paths, and every symlink in the existing ancestor chain.
- `RuntimePatchService` receives a workspace scope and a narrow `PatchMutationFileSystem`; default LocalRuntime wiring uses `LocalRuntimeFileSystem` plus private Node mutation methods, while tests can inject a fault-injecting adapter.
- `preparePatch(document, context): Promise<PreparedPatch>` reads every source before mutation, rejects missing/non-regular/binary/invalid UTF-8/oversize input, dry-applies all hunks, preserves existing BOM/newline/final-newline, computes raw-byte SHA-256 and size, and never writes.

- [ ] **Step 1: Write failing tests** for lexical path rejection, external symlink escape, source/ancestor symlink rejection, absent destination parent handling, strict UTF-8/BOM/newline/final-newline preservation, binary/oversize rejection, exact delete/move bytes, unique hunk matching, mismatch/ambiguous matching, multi-hunk one-result application, and zero mutation after a preparation failure.
- [ ] **Step 2: Run the focused runtime tests and confirm they fail before implementation.**
- [ ] **Step 3: Implement mutation target resolution by extending the existing 8A resolver; implement bounded text decoding/encoding and planner preparation.** Existing ancestors are checked with no-follow metadata; only the logical workspace root may itself be a configured symlink.
- [ ] **Step 4: Run focused tests, then existing `packages/runtime/test/workspace-path.test.ts` and `packages/runtime/test/text-reader.test.ts`; fix implementation, never weaken tests.**
- [ ] **Step 5: Commit `feat(runtime): prepare guarded patch changes in memory`.**

### Task 3: Implement precommit guards, commit, rollback, and uncertainty

**Files:**
- Create: `packages/runtime/src/patch/committer.ts`, `packages/runtime/src/patch/service.ts`.
- Modify: `packages/runtime/src/local-runtime.ts`, `packages/runtime/src/workspace-scope.ts`, `packages/runtime/src/index.ts`.
- Test: `packages/runtime/test/patch-commit.test.ts`, `packages/runtime/test/patch-rollback.test.ts`, `packages/runtime/test/patch-guards.test.ts`.

**Interfaces:**
- `RuntimePatchService.apply(request: RuntimePatchRequest): Promise<PatchCommitResult>` executes Parse → Plan/Prepare → guard-all → sequential commit → post-commit verification.
- `PatchCommitter.commit(prepared: PreparedPatch): Promise<PatchCommitResult>` checks every source version and every destination absence immediately before mutation; it stops on first failure.
- Safe rollback throws/returns a model-visible `PATCH_COMMIT_FAILED_ROLLED_BACK`; rollback failure or verification mismatch throws `RuntimePatchUncertainError` with sanitized details only.

- [ ] **Step 1: Write failing tests** for stale source hash/size, source disappearance/type change, add/move destination races, all operation kinds, deterministic order, created-parent rollback, ordinary commit failure with exact reverse rollback, rollback verification mismatch, rollback failure, and prepared-byte/detail bounds.
- [ ] **Step 2: Run focused tests and verify the new guards/committer fail.**
- [ ] **Step 3: Implement private patch-specific mutation primitives** (`writePreparedPatchFile`, `removePreparedPatchFile`, `renamePreparedPatchFile`, `makePreparedPatchDirectory`, `removePreparedPatchDirectoryIfEmpty`) with no generic public blind-write API. Capture exact before bytes and verify exact after/rollback bytes and versions.
- [ ] **Step 4: Run focused tests, including injected TOCTOU/race faults, then run all runtime tests.**
- [ ] **Step 5: Commit `feat(runtime): commit guarded patches with rollback`.**

### Task 4: Integrate LocalRuntime capability and `apply_patch` Tool

**Files:**
- Create: `packages/tools/src/builtins/apply-patch.ts`, `packages/tools/src/builtins/file-mutation-tools.ts`.
- Modify: `packages/tools/src/builtins/result.ts`, `packages/tools/src/index.ts`, `packages/tools/test/public-api.test.ts`, `packages/tools/test/apply-patch.test.ts`.
- Test: `packages/tools/test/apply-patch.test.ts`, `packages/tools/test/registry-options.test.ts`, `packages/tools/test/read-only-filesystem-tools.test.ts`.

**Interfaces:**
- `createFileMutationToolRegistrations(runtimeResolver = createLocalRuntimeResolver(new LocalRuntime()))` returns only the `apply_patch` registration; the final default catalog remains deferred to 8D.
- Tool definition: name `apply_patch`, HIGH risk, required capabilities `FS_WRITE` and `FS_DELETE`, runtime `local`, input exactly `{ patch: string }`, bounded output schema, and expected error codes from the spec.
- Handler calls `withRuntimeScope` and `scope.patch.apply({ patch })`; it performs no path parsing, Node filesystem calls, hashing, rollback, Storage access, or Run lookup. Runtime uncertainty is rethrown as a Tool-owned infrastructure uncertainty marker; normal expected patch errors become bounded `isError` results.

- [ ] **Step 1: Write failing Tool tests** for strict input schema/unknown property rejection, metadata/capabilities, expected error mapping, bounded success details, no raw content/host path leakage, and the separate read-only factory.
- [ ] **Step 2: Run focused Tool tests and observe failure.**
- [ ] **Step 3: Implement the registration/factory/handler using the existing runtime-scope helper; add only the narrow runtime-to-tool uncertainty bridge required by the durable dispatcher contract.**
- [ ] **Step 4: Run focused Tool tests and existing registry/catalog tests.**
- [ ] **Step 5: Commit `feat(tools): expose guarded apply_patch tool`.**

### Task 5: Preserve durable uncertainty and batch semantics

**Files:**
- Modify: `packages/tools/src/errors.ts`, `packages/tools/src/dispatcher.ts`, `packages/tools/src/dispatcher-errors.ts`, `packages/tools/src/index.ts`, and only the existing batch/coordinator files if tests prove a change is required.
- Test: `packages/tools/test/dispatcher-uncertainty.test.ts`, `packages/tools/test/batch-coordinator.test.ts`, `packages/storage/test/tool-dispatcher-integration.test.ts`, `packages/core/test/agent-tool-batch.test.ts`.

**Interfaces:**
- `ToolExecutionUncertainError` is the Tool boundary error carrying `executionDisposition: "UNCERTAIN_SIDE_EFFECT"`; Dispatcher persists a terminal failure/observation with that durable marker before propagating infrastructure uncertainty.
- Existing RUNNING recovery remains fail-closed: a crashed apply_patch is never automatically rerun and later batch tools are skipped.

- [ ] **Step 1: Write failing tests** for safe rollback as model-recoverable, uncertain rollback as durable `UNCERTAIN_SIDE_EFFECT`, no automatic rerun of a RUNNING invocation, and no execution of trailing batch calls.
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Add the narrow typed bridge and preserve existing dispatcher lifecycle/event/storage boundaries; do not add a migration.**
- [ ] **Step 4: Run focused tools/storage/core tests and the relevant Agent E2E.**
- [ ] **Step 5: Commit `fix(tools): persist patch uncertainty fail-closed`.**

### Task 6: End-to-end/runtime architecture coverage

**Files:**
- Modify: `packages/runtime/test/architecture.test.ts` if present or add `packages/runtime/test/patch-architecture.test.ts`; `tests/architecture/package-boundaries.test.ts`, `tests/architecture/workspace-shape.test.ts`, `tests/integration/tool-catalog.test.ts` only as required by the existing architecture conventions.
- Test: Add integration coverage in `packages/storage/test/patch-tool-e2e.test.ts` or the nearest existing storage/core integration seam.

- [ ] **Step 1: Write failing architecture/E2E tests** proving `packages/runtime` has no Tools/Core/Storage dependency, parser has no filesystem/runtime import, runtime has no `child_process`/Git apply, public runtime API has no generic blind write/delete, handler has no Node filesystem/hash/path parsing, no migration/table/events are added, and AgentRun workspace/runtime flow reaches the real local patch service.
- [ ] **Step 2: Run architecture/E2E tests and verify the intended failures.**
- [ ] **Step 3: Implement the minimum integration wiring and test helpers; use real temporary workspaces for end-to-end cases.**
- [ ] **Step 4: Run all focused architecture/integration tests and then `pnpm test`.**
- [ ] **Step 5: Commit `test: cover phase 8b patch architecture and e2e`.**

### Task 7: Documentation and changed-file formatting

**Files:**
- Create: `docs/architecture/patch-engine.md`.
- Modify: `docs/architecture/runtime.md`, `docs/architecture/tool-system.md`, `README.md`, `AGENTS.md`.

- [ ] **Step 1: Add docs tests/grep checks** for Phase 8A and 8B complete, Phase 8 in progress, `apply_patch` contract, Parse/Plan/Prepare/Guard/Commit/Rollback/Verify flow, symlink/encoding/guard rules, uncertain semantics, and explicit non-claims about crash atomicity/exactly-once/sandbox/production permissions/shell.
- [ ] **Step 2: Run the docs guard and confirm it fails before documentation changes.**
- [ ] **Step 3: Write the architecture documentation with no host-specific examples or future Phase 8C/8D implementation claims.**
- [ ] **Step 4: Run `pnpm exec prettier --check` on every changed file; use formatter only on changed files and keep the baseline warning count unchanged outside them.**
- [ ] **Step 5: Commit `docs: document phase 8b patch engine`.**

### Task 8: Full verification, review, and remote delivery

- [ ] **Step 1: Review the plan and spec coverage** with `rg` checks for forbidden V2 APIs, generic writes, `child_process`, `git apply`, raw path/content leakage, new migrations, and premature 8C/8D claims.
- [ ] **Step 2: Run fresh `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; record complete outputs and failure counts.**
- [ ] **Step 3: Run changed-file Prettier check (zero warnings), `git diff --check`, and full `pnpm check`; accept only the baseline 447-file format debt and report any increase.
- [ ] **Step 4: Inspect `git status --short`, `git diff`, package boundaries, public exports, and the complete commit history; invoke the verification-before-completion skill before any completion claim.**
- [ ] **Step 5: Push with `git push -u origin codex/phase-8b-safe-file-mutation-patch-engine` (never force push), fetch/prune, and assert local SHA equals the remote branch SHA.**
- [ ] **Step 6: Commit any final documentation/format adjustments before the final push; report branch, commit SHA, tests, known baseline format debt, and explicit 8B scope.**
