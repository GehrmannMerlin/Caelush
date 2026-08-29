# Caelush V1 Phase 8A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**建立一个与 Tool System 解耦的 `@caelush/runtime` 本地只读执行基座，并通过 Phase 7 的 Registry、Dispatcher、Batch Coordinator 和 RunController 暴露有边界、可恢复、可审计的 `read_file`、`list_directory`、`find_files`、`search_text` 四个 Tool。

**Architecture:** `AgentRun.workspace` 和 `AgentRun.runtime` 通过 data-only `ToolExecutionEnvironment` 进入 Tool execution pipeline；built-in handlers 解析 runtime、打开 workspace scope、用 `WorkspacePathResolver` 同时执行 lexical 与 realpath containment，再调用 runtime-owned filesystem/discovery/search 能力。`@caelush/runtime` 只依赖 `@caelush/protocol` 与 `@caelush/shared`（以及 fast-glob），不依赖 tools/core/context/storage/events/llm/security/verification；只有 `@caelush/tools` 的 built-in layer 依赖 runtime。所有 operational failure 都转为 `ToolExecutionResult.isError=true`，Runtime invariant 或 malformed backend output 才抛 typed infrastructure error。

**Tech Stack:** TypeScript/ESM, Node.js 24 `node:fs/promises`/`node:path`, `TextDecoder(fatal)`, exact-pinned `fast-glob@3.3.3`, fixed `rg` subprocess with `shell:false` and JSON output, Vitest, Ajv-backed Phase 7 ToolRegistry。

**Spec:** `C:/Users/韩吉衍/.codex/attachments/90f6b627-535a-4e4b-9e40-8aef8dfb9e08/pasted-text.txt`

## Global Constraints

- Phase 8 contains exactly 8A, 8B, 8C and 8D; this plan does not create another Phase 8 round.
- Phase 8A is strictly read-only: no file mutation, patching, shell execution, managed process runtime, Git tool, permission evaluator, approval resolution, retry, run cancellation or verification execution.
- The Phase 8A branch is `codex/phase-8a-local-runtime-filesystem-read-search`, based on `origin/codex/phase-7c-tool-batch-agent-integration` because commit `1fd0c5b7290fdbc0b992375809a0e273af38a6c4` is not an ancestor of `origin/master`.
- The worktree is `D:/Develop/Caelush/.worktrees/phase-8a-local-runtime-filesystem-read-search` and `.worktrees` is already ignored.
- `AgentRun.workspace` is the only source of truth for the Tool workspace; `AgentRun.runtime` is the only source of truth for runtime selection. `RunExecutionConfig.cwd` is context configuration and never changes Tool scope.
- Phase 8 built-in paths are workspace-relative, never process-cwd-relative; model-facing paths use `/` and never expose host absolute paths, internal IDs, stacks or raw filesystem/ripgrep errors.
- Runtime workspace containment is a correctness boundary, not Phase 9 authorization. Built-ins do not inspect permission profiles or approval policies and do not implement secret-file policy.
- Runtime public declarations must not leak `fs.Stats`, `Dirent`, `FileHandle`, `ChildProcess`, provider SDK types, raw parser state or mutable buffers.
- `read_file` is bounded valid UTF-8 text only; `find_files` is deterministic and bounded; `search_text` uses a fixed executable and argv backend and never accepts raw rg flags from the model.
- Durable Phase 7 `ToolInvocation`/`ToolObservation` remains the audit mechanism. No non-atomic `file.read` event side channel and no Phase 8A migration/table are added.
- Every behavior follows RED → observed failure → minimal GREEN → refactor; existing Phase 7 behavior must remain unchanged.

## Actual Baseline and Audit

- `git fetch origin --prune` completed before branch creation.
- `git merge-base --is-ancestor 1fd0c5b... origin/master` returned exit 1, so the selected base is the Phase 7C remote branch.
- Phase 7C baseline: `pnpm install --frozen-lockfile`, `pnpm lint`, build/typecheck and the serial test path passed; `pnpm check` observed 150 test files, 524 passed, 2 skipped, 0 failures. An initial parallel test invocation had a build/import race and is not used as evidence.
- Pre-hygiene `pnpm format:check` reported 415 repository-wide warnings. Exactly 32 of 33 Phase 7C changed files were Prettier-supported failures; `pnpm-lock.yaml` was not applicable. Only those 32 files were formatted, the targeted check passed, and commit `724d63e` (`chore: normalize phase 7c changed-file formatting`) records the hygiene fix. No repository-wide formatter run is allowed.
- Post-hygiene repository-wide warning count and final Phase 8A changed-file warning count will be recorded at the verification gate; Phase 8A changed files must have zero warnings and final repository-wide count must not exceed the post-hygiene baseline.

## Current Runtime/Context State

- `@caelush/runtime` and `@caelush/shared` are empty public packages (`src/index.ts` only) with no project dependencies.
- Context owns `LocalContextFileSystem`, `WorkspaceScopeResolver`, `IgnorePolicy`, `CandidateFileDiscovery` and `ProjectInspector` for prompt/context construction. It already performs logical and realpath checks, strict UTF-8 prefix decoding, deterministic directory ordering and hard/sensitive/binary discovery policy.
- The shared extraction is limited to pure, reusable path containment and hard-excluded directory constants. Context keeps its own Context IO, IgnorePolicy, ProjectInspector and discovery responsibilities; runtime gets separate runtime scope and Tool IO.
- Characterization tests for `WorkspaceScopeResolver` run before and after the shared extraction so Context semantics do not drift.

## Architecture References

| Source                                                                                                                             | Observed design                                                                                                                             | What Caelush adopts                                                                                        | What Caelush intentionally does not copy                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [OpenCode read tool](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/read.ts)                  | Paginated line reads, 50 KiB output cap, 2,000-character line cap, sample-based binary detection, explicit continuation text, line metadata | bounded streaming reads, valid UTF-8 enforcement, line numbers, byte/line limits and explicit `nextOffset` | absolute-path contract, image/PDF attachments, LSP warm-up, instruction loading, Effect runtime and permission asks |
| [OpenCode glob tool](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/glob.ts)                  | fixed bounded result count, deterministic file listing and truncation notice                                                                | bounded deterministic glob discovery and model-visible truncation                                          | external-directory approvals and unrestricted host paths                                                            |
| [OpenCode grep tool](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/grep.ts)                  | regex search delegated to ripgrep with line numbers, include pattern and bounded results                                                    | fixed rg JSON backend, parsed `{path,line,text}` results, bounded match text/count and no-match success    | arbitrary rg options, permission asks and output of host absolute paths                                             |
| [Codex handlers](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/mod.rs)                      | handlers are selected tool-facing adapters while execution policies are separate                                                            | keep built-in handlers above a narrow runtime substrate and keep ToolRegistry/Dispatcher generic           | Phase 8A does not implement Codex approvals, sandbox policy, shell, PTY or patch handlers                           |
| [Codex unified-exec runtime](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/runtimes/unified_exec.rs) | runtime prepares trusted execution request and delegates process startup; sandbox/approval orchestration is distinct                        | preserve Runtime != Handler != Permission/Sandbox boundary; only fixed rg is allowed here                  | no generic process manager, approval orchestration, timeout/cancellation or shell runtime in 8A                     |

## File Map

- Shared: `packages/shared/src/path-boundary.ts`, `packages/shared/src/project-exclusions.ts`, `packages/shared/src/index.ts`; context changes in `packages/context/src/workspace.ts`, `packages/context/src/ignore-policy.ts`, package manifest and characterization tests.
- Runtime contracts and errors: `packages/runtime/src/runtime.ts`, `runtime-ref.ts`, `workspace-scope.ts`, `workspace-path.ts`, `runtime-errors.ts`, `index.ts`.
- Runtime IO: `packages/runtime/src/filesystem/types.ts`, `local-filesystem.ts`, `text-reader.ts`, `binary-detection.ts`; discovery in `discovery/file-discovery.ts`, `discovery/exclusions.ts`; search in `search/text-search.ts`, `ripgrep-runner.ts`, `ripgrep-parser.ts`; composition in `local-runtime.ts`.
- Tool environment and built-ins: `packages/tools/src/execution-environment.ts`, `handler.ts`, `dispatcher-types.ts`, `batch-types.ts`, `dispatcher.ts`, `batch-coordinator.ts`, `builtins/result.ts`, `read-file.ts`, `list-directory.ts`, `find-files.ts`, `search-text.ts`, `read-only-filesystem-tools.ts`, `index.ts` and `package.json`.
- Core propagation: `packages/core/src/run-controller.ts`, `run-controller-ports.ts`, existing Phase 7 tests/fixtures and new mapping/E2E coverage.
- Tests: new focused tests under `packages/shared/test`, `packages/runtime/test`, `packages/tools/test`, core/storage integration tests, architecture tests and a real read-only Agent E2E.
- Docs: `docs/architecture/runtime.md`, `docs/architecture/tool-system.md`, `README.md`, `AGENTS.md`.

## Runtime and Tool Contracts

The public runtime contract is intentionally narrow:

```ts
export interface Runtime {
  readonly kind: string;
  supports(ref: RuntimeRef): boolean;
  openWorkspace(workspace: WorkspaceRef): Promise<RuntimeWorkspaceScope>;
}

export interface RuntimeResolver {
  resolve(ref: RuntimeRef): Runtime | undefined;
}

export interface ToolExecutionEnvironment {
  readonly workspace: WorkspaceRef;
  readonly runtime: RuntimeRef;
}
```

`RuntimeWorkspaceScope` retains `workspace`, normalized `logicalRoot`, canonical `realRoot`, and runtime-owned `pathResolver`, `filesystem`, `discovery`, and `textSearch` capabilities. `WorkspacePathResolver.resolveExisting(workspaceRelativePath)` rejects NUL, over-4096-byte, POSIX absolute, Windows drive-absolute, UNC, and lexical traversal paths before resolving an existing target and rechecking realpath containment. It returns a Caelush-owned `ResolvedWorkspacePath` with absolute internal paths and a canonical `/`-separated workspace-relative path; internal absolute paths never enter model content.

The built-in handler sequence is fixed:

```text
ToolExecutionRequest
  → RuntimeResolver.resolve(request.environment.runtime)
  → runtime.openWorkspace(request.environment.workspace)
  → WorkspacePathResolver
  → runtime operation
  → ToolExecutionResult
```

`ToolExecutionEnvironment` is required on `ToolBatchRequest`, `ToolDispatchRequest`, and `ToolExecutionRequest`; it contains only validated durable refs and no Runtime object, filesystem, storage, EventBus, permission manager, abort signal, secret or model. RunController constructs it directly from `AgentRun.workspace` and `AgentRun.runtime`.

## Tool Semantics and Limits

- `read_file`: input `{path, offset?, limit?}`, defaults `offset=1`, `limit=400`, hard maximum 2,000 lines, model cap 50 KiB, per-line cap 2,000 characters with `... [line truncated]`, strict valid UTF-8, optional BOM removal with `utf8Bom`, CRLF/LF normalization only in display, no-final-newline preservation, empty-file success, and explicit `truncated`/`nextOffset`. Operational codes include `PATH_OUTSIDE_WORKSPACE`, `PATH_NOT_FOUND`, `NOT_A_FILE`, `BINARY_FILE`, `INVALID_UTF8`, `INVALID_RANGE`, `FILE_READ_FAILED`, `UNSUPPORTED_RUNTIME`.
- `list_directory`: input `{path, offset?, limit?}`, defaults `path="."`, `offset=1`, `limit=200`, hard maximum 500; immediate children only, deterministic canonical name/path order, entries expose `name`, workspace-relative `path`, and `kind` (`FILE|DIRECTORY|SYMLINK|OTHER`), with `/` and `@` display markers. It never recursively follows child symlinks. Operational codes include `PATH_OUTSIDE_WORKSPACE`, `PATH_NOT_FOUND`, `NOT_A_DIRECTORY`, `DIRECTORY_READ_FAILED`, `INVALID_RANGE`, `UNSUPPORTED_RUNTIME`.
- `find_files`: input `{pattern,path?,limit?}`, default path `.`, default limit 100, hard max 500, pattern cap 2,048 UTF-8 bytes, no absolute or parent-traversing glob, `fast-glob@3.3.3` with `cwd`, `onlyFiles:true`, `followSymbolicLinks:false`, `unique:true`, `absolute:false`, shared hard exclusions, deterministic sorted `/`-separated paths, `limit+1` truncation detection and no-result success. Invalid pattern is model-recoverable `INVALID_PATTERN`.
- `search_text`: input `{pattern,path?,include?,limit?}`, default path `.`, default limit 100, hard max 200 matches, rg-compatible regex, fixed `rg --json --line-number --color=never` plus internal globs/exclusions, `shell:false`, no `--follow`, `-L`, `--no-ignore`, model match cap 1,000 characters with `... [match truncated]`, stdout cap 1 MiB and stderr cap 16 KiB. rg exit 0 is match success, 1 is no-match success, >=2 is typed search failure; ENOENT is model-recoverable `RIPGREP_UNAVAILABLE`; malformed JSON or unsafe returned path is `RuntimeInvariantError`.
- All four definitions have LOW risk, `requiredCapabilities: ["FS_READ"]` as metadata only, concise property-level descriptions and output schemas that accept both success and expected-error detail shapes. The registration factory returns the fixed order `read_file`, `list_directory`, `find_files`, `search_text`; no final all-tools catalog is created in 8A.

## TDD Implementation Tasks

### Task 1: Phase 7C formatting audit

- [x] Record base/ref, changed files, 415 pre-hygiene warning count and targeted changed-file audit.
- [x] Apply only targeted Phase 7C formatting and commit `724d63e`.

### Task 2: Context characterization

- [ ] Add characterization assertions covering workspace missing/file/normal/symlink roots, lexical sibling-prefix containment, realpath escape, and relative/absolute cwd behavior against current `WorkspaceScopeResolver`.
- [ ] Run only the characterization test and confirm the pre-change behavior fails only for the newly asserted missing contract, then refactor shared helpers while keeping all existing Context tests green.

### Task 3: Shared path containment and exclusions

- [ ] Add tests for root, child, deep child, sibling same-prefix, parent traversal and Windows-style separators.
- [ ] Implement `isPathInsideOrEqual(root, candidate)` and export one shared hard-excluded directory-name/glob source; change Context IgnorePolicy to reuse it without extracting sensitive-file policy.
- [ ] Run shared and Context tests, then commit `refactor(shared): centralize workspace path boundaries`.

### Task 4: ToolExecutionEnvironment propagation

- [ ] Add contract tests proving environment is required and contains only `WorkspaceRef`/`RuntimeRef`.
- [ ] Extend batch/dispatch/execution request types and runtime validation with `WorkspaceRefSchema` and `RuntimeRefSchema`; copy environment through coordinator and dispatcher without changing Phase 7 idempotency, recovery, ordering or approval behavior.
- [ ] Update existing fixtures with explicit test environment and run the complete Phase 7 tools/storage regression suite.

### Task 5: Runtime contracts, resolver and LocalRuntime shell

- [ ] Add failing tests for `LocalRuntime.supports`, unsupported refs, `RuntimeResolver`, and no dependency from runtime to tools/core/context/storage/events/llm/security/verification.
- [ ] Implement `LOCAL_RUNTIME_KIND`, `Runtime`, `RuntimeResolver`, `SingleRuntimeResolver`, `RuntimeWorkspaceScope`, typed error base/classes and `LocalRuntime` composition without adding execution, permission, cancellation or persistence APIs.
- [ ] Verify runtime package builds and public exports contain no forbidden Node/provider/tool types.

### Task 6: Workspace scope and path resolution

- [ ] Add the full path matrix: `.`, normalized `src/../README.md`, parent escape, POSIX absolute, Windows drive absolute, UNC (both spellings), NUL, byte-overlong, Unicode/spaces, missing root, file root, normal root, symlink root, internal symlink target and outside symlink target.
- [ ] Implement `LocalRuntime.openWorkspace` with normalized logical root, realpath root, absolute/existing/directory checks, and `WorkspacePathResolver` with lexical then real containment. Preserve logical and real roots when the workspace ref itself is a symlink.
- [ ] Run runtime scope/symlink tests and assert model-facing paths are relative `/` paths.

### Task 7: Runtime filesystem primitives

- [ ] Add tests for Caelush-owned metadata/kind types and local listing/read operations, including `OTHER`, symlink `lstat`, deterministic order, and no Node object leakage.
- [ ] Implement local filesystem adapters using only read operations (`lstat`, `realpath`, `readdir`, bounded file reads/open handles); never use mutation primitives.
- [ ] Run the focused filesystem tests and static mutation audit.

### Task 8: Binary detection and bounded strict text reader

- [ ] Add RED tests for NUL/control-ratio/known-extension binary input, text with binary-looking extension, invalid UTF-8, BOM, CRLF/LF, Chinese/emoji/multibyte chunk boundaries, no final newline, empty file, long line and >50 KiB output.
- [ ] Implement sample-based binary detection and streaming `TextDecoder("utf-8", {fatal:true})` line reader with bounded buffers, 1-based pagination and continuation metadata; strip only display terminators and leading BOM.
- [ ] Verify instrumentation proves large reads do not load the whole file before truncating and all reader tests pass.

### Task 9: `read_file` Tool

- [ ] Add handler/registry/dispatcher tests for success, all expected error codes, output schemas, privacy, canonical paths and `ToolObservation` creation.
- [ ] Implement the handler through injected `RuntimeResolver` and scope filesystem/path resolver; convert only expected operational errors to `isError=true` results and rethrow invariant errors.
- [ ] Register no direct filesystem access outside the handler/runtime boundary and run RegistryBuilder + Dispatcher integration.

### Task 10: `list_directory` Tool

- [ ] Add tests for root/nested/empty directories, file/directory/symlink/other kinds, ordering, pagination/truncation, non-recursion, and expected path/type errors.
- [ ] Implement bounded immediate-child listing through runtime scope, with structured entries and model-safe display content.
- [ ] Run the built-in list tests through the real Dispatcher.

### Task 11: Shared hard exclusions

- [ ] Add tests proving `.git`, `.worktrees`, `node_modules`, `dist`, `build`, `coverage`, `target` and all existing shared hard exclusions are omitted from explicit discovery without adding secret policy.
- [ ] Implement the shared names/globs once and reuse them from Context and runtime discovery/search adapters.
- [ ] Run Context ignore regression and runtime exclusion tests.

### Task 12: `find_files` via fast-glob

- [ ] Add tests for nested globs, no result, deterministic sorting, only-files behavior, symlink non-following, hard exclusions, path scope, Unicode names, invalid/absolute/parent-traversing patterns, limits and truncation.
- [ ] Add exact `fast-glob` dependency `3.3.3` to runtime and lockfile; implement validated search root, fixed options, shared ignores, defensive result resolution and relative output.
- [ ] Run discovery tests and inspect the package dependency graph for the required `tools → runtime → protocol/shared` direction.

### Task 13: Ripgrep runner and JSON parser

- [ ] Add parser tests for rg match JSON, malformed JSON, workspace-outside path, Unicode, line numbers, long lines, exit 0/1/>=2, stdout/stderr caps and truncation termination.
- [ ] Implement a public `RipgrepRunner` request/result contract and private local adapter using a fixed `rg` executable, argv-only invocation, `shell:false`, bounded stdout/stderr and no model-controlled executable/flags. Allow only this production `child_process` usage.
- [ ] Add invocation tests proving injection strings remain one argv value and no `--follow`, `-L`, `--no-ignore` or `shell:true` is emitted.

### Task 14: `search_text` Tool

- [ ] Add handler tests using a fake runner for match/no-match, multiple files/matches, ordering, line numbers, limits, long-match truncation, invalid pattern, unavailable rg, exit failures, malformed output, defensive path rejection and Unicode.
- [ ] Implement path validation, include forwarding as a bounded glob value, result parsing/projection and expected error conversion; never expose raw stdout/stderr or host paths.
- [ ] Run search tests through real Registry/Dispatcher integration and assert malformed backend/invariant failures remain infrastructure failures.

### Task 15: Read-only registration factory

- [ ] Add tests constructing `RuntimeResolver`, `LocalRuntime`, four registrations and `ToolRegistryBuilder`, asserting exact order, resolution, LOW risk, FS_READ metadata, concise descriptions, strict input/output schemas and model projection of only name/description/inputSchema.
- [ ] Implement `createReadOnlyFilesystemToolRegistrations` with injected resolver/default local runtime and fixed order; keep runtime requirements metadata simple (`runtimeKinds`, and `executables: ["rg"]` for search).
- [ ] Run catalog consistency and public API tests.

### Task 16: ToolRegistry/Dispatcher integration

- [ ] Add end-to-end Dispatcher tests for each built-in, expected result persistence, invocation state, observation details, global output bounding and no file event side channel.
- [ ] Ensure the generic Registry/Dispatcher never imports or knows LocalRuntime/read semantics; only built-in implementations import runtime.
- [ ] Run all existing Phase 7 Dispatcher, recovery, batch and approval tests with environment propagation.

### Task 17: RunController environment mapping

- [ ] Add a mapping test with a deliberately conflicting `RunExecutionConfig.cwd` proving the emitted `ToolBatchRequest.environment` exactly uses `AgentRun.workspace` and `AgentRun.runtime`.
- [ ] Update RunController request construction to include a validated data-only environment and no runtime lookup/storage access in built-in handlers.
- [ ] Run core/storage RunController tests and update all test fixtures without changing result/state transitions.

### Task 18: Full read-only Agent E2E

- [ ] Create a temporary workspace fixture with UTF-8 files, nested files, binary/empty files, excluded directories and conditional symlinks; keep file-backed SQLite outside the workspace.
- [ ] Run a real LocalRuntime → registrations → Registry → Dispatcher → Coordinator → RunController flow with a fake LLM: first turn requests read/list/find/search, second turn receives source-ordered tool results, then returns a final candidate and reaches `AWAITING_VERIFICATION`/`VERIFYING` without `run.completed`.
- [ ] Snapshot workspace relative paths, sizes and hashes before/after and assert exact equality; assert each invocation is completed or an expected failure and every observation/conversation segment exists.
- [ ] Add error continuation E2E (`../outside.txt` error, run remains alive, next valid read succeeds) and invariant failure E2E (Run fails instead of fabricating a normal Tool Result).

### Task 19: Architecture guards

- [ ] Add/update architecture tests for package dependency manifests, no cycle, runtime declaration boundaries, tools/runtime import boundaries, fixed rg child process only, no mutation/shell/PTY/process-manager/Git/security/retry/cancellation/verification leakage, zero migrations and no file-read side channel.
- [ ] Run public declaration audits on `packages/runtime/dist/index.d.ts` and `packages/tools/dist/index.d.ts`; ensure only allowed public types are exported.
- [ ] Run focused architecture and all Phase 7 regression tests.

### Task 20: Documentation and final gates

- [ ] Add `docs/architecture/runtime.md` with the architecture diagram, logical/real roots, symlinks, read-only filesystem, glob/rg behavior, errors, and Phase 9/10 boundaries; update tool-system, README and AGENTS with the durable 8A rules.
- [ ] Run fresh `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`; clear generated `dist`/`*.tsbuildinfo` only with explicit Node filesystem operations before a clean rebuild, never `git clean`.
- [ ] Run focused tests, changed-file Prettier check from `PHASE_8A_BASE_SHA...HEAD`, full format baseline comparison, `git diff --check`, static audits and `git status --short`/`git diff`.
- [ ] Keep Phase 8A changes in small commits (shared, runtime, environment, read tools, discovery/search, registration, integration/tests, docs); do not auto-merge, force-push or create a PR.

## Verification Gates

Completion requires fresh evidence for every claim:

1. Full verification commands exit 0: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
2. `pnpm check` exits 0, or its only failure is the already measured and verified repository-wide Prettier debt; Phase 8A changed files themselves have zero warnings.
3. Test evidence includes all focused matrices above plus the 150-file Phase 7 regression suite with no new failures.
4. Static audit reports `runtime → tools/core/context/storage/events/llm/security/verification = NO`, `tools → runtime = YES`, fixed rg is the only production `child_process` use, and every forbidden Phase 8B–10 feature is absent.
5. No migration or runtime persistence table changed; workspace snapshot is byte/hash identical through E2E.
6. `git diff --check` is clean, worktree status is reported, and no push/merge/PR is performed automatically.
