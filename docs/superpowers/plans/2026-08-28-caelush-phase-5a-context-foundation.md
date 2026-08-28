# Caelush Phase 5A Context Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, bounded, evidence-driven workspace and project intelligence subsystem in `@caelush/context`.

**Architecture:** A `ContextFileSystem` port isolates all filesystem reads from a local Node adapter. `ProjectInspector` composes workspace scope resolution, evidence-based root detection, allowlisted environment detection, project profiling, and hierarchical instruction discovery into a runtime-only snapshot; no prompt assembly or execution is included.

**Tech Stack:** TypeScript/ESM, Node.js built-ins (`node:fs/promises`, `node:path`), Zod-backed `@caelush/protocol` `WorkspaceRef`, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-28-caelush-phase-5a-context-foundation-design.md`

## Global Constraints

- `@caelush/context` may depend only on `@caelush/protocol` and must not depend on `@caelush/llm`, storage, events, daemon, runtime, tools, security, or apps.
- `WorkspaceRef` is reused from `@caelush/protocol`; do not introduce a duplicate workspace contract.
- Context filesystem access is read-only and exposes only metadata, bounded text read, directory listing, and realpath.
- `WorkspaceRef.path` must be absolute; workspace and cwd logical and real paths must stay within the workspace boundary using `path.relative`, never `startsWith`.
- Root detection is bounded to cwd through workspace root and never executes shell commands, reads `process.env`, fetches network resources, or recursively scans the repository.
- Project root tier order is nearest `.git`, workspace marker, project manifest, cwd fallback.
- Instructions are selected per directory as `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md`, ordered project root to cwd, with a 32768-byte total budget and safe UTF-8 truncation.
- Malformed project manifests become diagnostics; unreadable/invalid-UTF-8/out-of-bound instruction files fail closed with typed errors.
- No production source may contain explicit `any`, `node:child_process`, shell execution, LLM/AI SDK imports, or prompt assembly.
- All public types enter through `packages/context/src/index.ts`; built declarations must not expose Node `fs` types.
- Every behavior change follows TDD: write a failing test, run it, implement the minimum, run it again, then refactor.

### Task 1: Context errors and read-only filesystem port

**Files:**

- Create: `packages/context/src/errors.ts`
- Create: `packages/context/src/filesystem.ts`
- Modify: `packages/context/package.json`
- Modify: `packages/context/tsconfig.json`
- Test: `packages/context/test/filesystem.test.ts`

**Interfaces:**

- `ContextFileMetadata = { kind: "FILE" | "DIRECTORY" | "SYMLINK" }`.
- `ContextTextFile = { text: string; bytes: number; truncated: boolean }`.
- `ContextDirectoryEntry = { name: string; kind: "FILE" | "DIRECTORY" | "SYMLINK" }`.
- `ContextFileSystem` has `getMetadata(path)`, `readTextFile(path, { maxBytes })`, `readDirectory(path)`, and `realpath(path)`; no mutating method.
- `LocalContextFileSystem` implements the port using `node:fs/promises` and `node:path` only.
- Error classes are `ContextError`, `ContextInvalidWorkspaceError`, `ContextBoundaryError`, `ContextInstructionError`, and `ContextIOError`.

- [ ] Write tests proving bounded UTF-8 reads, deterministic directory entries, missing metadata as `null`, and the public filesystem surface has no write method.
- [ ] Run `pnpm vitest run packages/context/test/filesystem.test.ts`; observe failure because the port and adapter do not exist.
- [ ] Implement the error hierarchy, the port-owned value types, and a local adapter that maps Node errors to `ContextIOError`, reads no more than the requested bounded prefix, validates UTF-8, and maps `Dirent` to Caelush-owned entries.
- [ ] Run the focused test and then `pnpm --filter @caelush/context build`.
- [ ] Commit with `feat(context): add read-only filesystem port`.

### Task 2: Workspace scope and boundary resolver

**Files:**

- Create: `packages/context/src/workspace.ts`
- Test: `packages/context/test/workspace.test.ts`

**Interfaces:**

- `WorkspaceScope = { workspace: WorkspaceRef; logicalRoot: string; realRoot: string; cwd: string; realCwd: string }`.
- `WorkspaceScopeResolver` accepts a `ContextFileSystem` and exposes `resolve(workspace: WorkspaceRef, cwd?: string): Promise<WorkspaceScope>`.

- [ ] Write tests for absolute workspace, default cwd, relative cwd, absolute cwd, cwd equal to root, outside cwd, `..` escape, missing root, and file root; include a symlink/junction escape helper that skips only when the host rejects symlink creation and records the reason.
- [ ] Run the focused workspace tests and confirm failures are caused by the missing resolver.
- [ ] Implement absolute-path validation, root directory validation, logical path resolution, realpath resolution, and dual logical/real boundary checks with `path.relative`; never use `startsWith`.
- [ ] Run the focused workspace tests and verify all boundary cases pass.
- [ ] Commit with `feat(context): add read-only workspace boundary`.

### Task 3: Evidence-based project root detector

**Files:**

- Create: `packages/context/src/project-root.ts`
- Test: `packages/context/test/project-root.test.ts`

**Interfaces:**

- `ProjectRootReason = "VCS_MARKER" | "WORKSPACE_MARKER" | "PROJECT_MANIFEST" | "CWD_FALLBACK"`.
- `ProjectRootDetectionResult = { projectRoot: string; reason: ProjectRootReason; marker?: string; evidencePath?: string }`.
- `ProjectRootDetector` accepts a `ContextFileSystem` and exposes `detect(scope: WorkspaceScope): Promise<ProjectRootDetectionResult>`.

- [ ] Write tests for `.git` directory, `.git` file, nested nearest git, each workspace marker, `package.json` with explicit `workspaces`, standalone package/python/rust/go/java manifests, cwd fallback, deterministic marker selection, and refusal to inspect above workspace root.
- [ ] Run the root focused tests and observe the expected missing-detector failures.
- [ ] Implement ancestor enumeration from real cwd to real root, tiered marker checks with explicit stable filename order, safe `package.json` workspaces parsing, and manifest fallback; return real project root paths.
- [ ] Run root tests and confirm all tiers and boundary limits pass.
- [ ] Commit with `feat(context): detect project roots from workspace evidence`.

### Task 4: Allowlisted environment snapshot

**Files:**

- Create: `packages/context/src/environment.ts`
- Test: `packages/context/test/environment.test.ts`

**Interfaces:**

- `EnvironmentSnapshot = { platform: NodeJS.Platform; arch: string; hostNodeVersion: string; pathStyle: "POSIX" | "WINDOWS"; workspaceRoot: string; projectRoot: string; cwd: string }`.
- `EnvironmentDetector` exposes `detect(scope: WorkspaceScope, projectRoot: string): EnvironmentSnapshot`.
- `LocalEnvironmentDetector` is the default implementation.

- [ ] Write tests asserting platform, arch, and Node version equal the current host and that serialized output has no environment-secret fields.
- [ ] Run the focused tests and verify they fail because the detector is absent.
- [ ] Implement the detector using only `process.platform`, `process.arch`, `process.version`, and `path.sep`; do not read or spread `process.env`.
- [ ] Run the focused tests and static-search the production context source for `process.env`.
- [ ] Commit with `feat(context): detect local project environments`.

### Task 5: Evidence-driven project profile

**Files:**

- Create: `packages/context/src/project-profile.ts`
- Test: `packages/context/test/project-profile.test.ts`

**Interfaces:**

- `ProjectEcosystem = "NODE" | "PYTHON" | "RUST" | "GO" | "JAVA"`.
- `ProjectManifestEvidence = { path: string; relativePath: string; type: string; ecosystem?: ProjectEcosystem }`.
- `ProjectPackage = { path: string; relativePath: string; name?: string; packageManager?: string; nodeVersionRange?: string; scripts: readonly { name: string; command: string }[]; workspaces?: boolean | readonly string[] }`.
- `ProjectProfile` contains `ecosystems`, `manifestEvidence`, `packageManager: { name: "pnpm" | "yarn" | "npm" | "bun" | "uv" | "poetry" | "cargo" | "go" | "maven" | "gradle" | "UNKNOWN"; versionHint?: string; source?: string; evidencePaths: readonly string[] }`, `isMonorepo`, `monorepoEvidence`, `rootPackage?`, `activePackage?`.
- `ProjectProfileDetector` exposes `detect(scope, projectRoot): Promise<{ profile: ProjectProfile; diagnostics: readonly ContextDiagnostic[] }>`.
- `ContextDiagnostic = { code: string; severity: "WARNING" | "ERROR"; message: string; path?: string }`.

- [ ] Write fixture-driven tests for Node, TypeScript signal, packageManager field/version, npm/yarn/bun lockfile fallback, conflicting lockfiles, Python/uv/poetry, Rust, Go, Maven/Gradle conflict, monorepo markers, root versus nearest active package, stable scripts, and malformed package JSON diagnostics.
- [ ] Run profile tests and observe missing detector/type failures.
- [ ] Implement only known-file probes from project root through cwd, safe JSON parsing through `unknown` guards, sorted script output, root package/active package distinction, explicit manager precedence, lockfile conflict diagnostics, and no dependency list copying.
- [ ] Run profile tests and verify malformed manifests do not abort the profile.
- [ ] Commit with `feat(context): detect project manifests and package managers`.

### Task 6: Hierarchical project instructions

**Files:**

- Create: `packages/context/src/instructions.ts`
- Test: `packages/context/test/instructions.test.ts`

**Interfaces:**

- `InstructionKind = "OVERRIDE" | "AGENTS" | "FALLBACK"`.
- `ProjectInstruction = { path: string; relativePath: string; kind: InstructionKind; depth: number; content: string; bytes: number; truncated: boolean }`.
- `ProjectInstructions = { entries: readonly ProjectInstruction[]; totalBytes: number; maxBytes: number }`.
- `ProjectInstructionDiscovery` accepts a `ContextFileSystem` and exposes `discover(scope, projectRoot, cwd, options?): Promise<ProjectInstructions>` with default fallback `CLAUDE.md` and budget `32768`.

- [ ] Write tests for root/child ordering, override precedence, AGENTS over CLAUDE, CLAUDE fallback, empty files, empty override winning, 32768-byte budget, safe multibyte truncation, invalid UTF-8, unreadable files, project-root boundary, workspace realpath symlink boundary, literal `@reference`, and no global/remote reads.
- [ ] Run instruction tests and confirm the expected missing-discovery failures.
- [ ] Implement root-to-cwd directory construction, per-directory candidate selection, realpath containment before read, bounded UTF-8 reads, empty-content filtering, remaining-budget stop behavior, and typed fatal instruction errors.
- [ ] Run instruction tests and verify entries and byte totals are deterministic and within budget.
- [ ] Commit with `feat(context): discover hierarchical project instructions`.

### Task 7: Inspector orchestration and public entry

**Files:**

- Create: `packages/context/src/snapshot.ts`
- Create: `packages/context/src/project-inspector.ts`
- Modify: `packages/context/src/index.ts`
- Modify: `packages/context/package.json`
- Test: `packages/context/test/project-inspector.test.ts`
- Test: `packages/context/test/public-api.test.ts`

**Interfaces:**

- `ProjectIntelligenceSnapshot = { workspace: WorkspaceScope; projectRoot: ProjectRootDetectionResult; environment: EnvironmentSnapshot; profile: ProjectProfile; instructions: ProjectInstructions; diagnostics: readonly ContextDiagnostic[] }`.
- `ProjectInspector` accepts injected `ContextFileSystem`, optional detectors, and optional instruction options; `inspect({ workspace: WorkspaceRef; cwd?: string }): Promise<ProjectIntelligenceSnapshot>` is its sole application-facing operation.
- `createLocalProjectInspector(options?): ProjectInspector` composes the local filesystem/environment detector without starting a daemon or causing import side effects.

- [ ] Write an E2E temp-workspace test with `.git`, root and nested package manifests, pnpm workspace marker, root and nested AGENTS, active package under `packages/app/src`, repeated inspect calls, and an outside directory that must never appear in the snapshot.
- [ ] Run the integration/public API tests and observe missing orchestration and exports.
- [ ] Implement the immutable runtime snapshot assembly in the prescribed order, aggregate profile diagnostics, and export only the approved public types/classes/factory from `src/index.ts`.
- [ ] Run focused context tests and `pnpm --filter @caelush/context build`; inspect `dist/index.d.ts` for absence of `fs.Stats`, `Dirent`, and private adapter types.
- [ ] Commit with `feat(context): add project intelligence inspector`.

### Task 8: Architecture guards and documentation

**Files:**

- Modify: `tests/architecture/package-boundaries.test.ts`
- Create: `packages/context/test/architecture.test.ts`
- Create: `docs/architecture/context-and-project-intelligence.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] Write failing architecture/static tests for context's dependency allowlist, no LLM/runtime/tool/storage/events/daemon/security imports, no explicit `any`, no `process.env`, no child process/network calls, and no deep source import.
- [ ] Run the guard tests to confirm they fail until the package dependency and guard logic are present.
- [ ] Add `@caelush/protocol: workspace:*` to the context package, update boundary expectations, and implement static audits covering production context source and generated declarations.
- [ ] Document root distinctions, algorithm, instruction precedence/hierarchy/budget, no reference/remote/global loading, read boundary versus Phase 9 permissions, and the Phase 5A/5B boundary; update AGENTS and README with the exact project-level rules without claiming prompt assembly.
- [ ] Run focused architecture tests and format only the files changed in this phase.
- [ ] Commit with `test(context): cover workspace and project discovery boundaries` and `docs: document phase 5a project intelligence`.

### Task 9: Full verification and remote handoff

**Files:**

- No new production files; inspect and verify all Phase 5A files.

- [ ] Run focused tests for workspace, root, environment, profile, instructions, inspector, public API, architecture, and existing architecture suites; record test files/tests/failures.
- [ ] Run `node --version`, `pnpm --version`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`; distinguish pre-existing formatting failures if they remain.
- [ ] Remove only generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` with explicit Node filesystem operations when needed; never run `git clean`; rerun frozen install and `pnpm check`.
- [ ] Run `git diff --check`, `git status --short`, and inspect the final diff for forbidden Phase 5B/AgentLoop/Tool/Storage/Daemon scope.
- [ ] Commit any verification-only fixes with a focused message, then push `codex/phase-5a-context-foundation` without force; record local and remote SHA using `git ls-remote`.
