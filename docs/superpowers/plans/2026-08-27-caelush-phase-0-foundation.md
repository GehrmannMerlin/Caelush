# Caelush V1 Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a strict, testable TypeScript/pnpm monorepo foundation for Caelush V1 without implementing Agent functionality.

**Architecture:** Create three application boundaries (`daemon`, `cli`, `web`) and twelve package boundaries under a single pnpm workspace. Every package exposes only `src/index.ts`; root scripts run uniform lint, typecheck, test, build, and formatting checks. Vitest architecture tests inspect workspace manifests and dependency declarations so forbidden dependency direction fails deterministically.

**Tech Stack:** TypeScript 5.x, Node.js 24.x LTS, pnpm 11.x, pnpm workspaces, Vitest, ESLint flat config, typescript-eslint, Prettier, native Node scripts, ESM.

**Spec:** `Caelush V1 技术架构设计文档.md`, especially the Phase 0 section and frozen package boundaries in sections 7–18.

## Global Constraints

- Language: TypeScript.
- Runtime: Node.js 24 LTS; root `engines.node` must require `>=24.0.0 <25.0.0`.
- Package manager: pnpm 11 with a concrete validated `packageManager` version, not `latest`.
- Repository: pnpm monorepo; do not add Turborepo, Nx, Changesets, or other orchestration frameworks.
- Module system: ESM with `"type": "module"`; do not use CommonJS or `require()`.
- Dependencies: install only Phase 0 tooling; do not install Fastify, React, Vite, Ink, Drizzle, SQLite, AI SDK, Zod, node-pty, Pino, or future feature dependencies.
- Package names: `@caelush/protocol`, `@caelush/core`, `@caelush/llm`, `@caelush/context`, `@caelush/tools`, `@caelush/runtime`, `@caelush/security`, `@caelush/verification`, `@caelush/events`, `@caelush/storage`, `@caelush/observability`, `@caelush/shared`; apps are `@caelush/daemon`, `@caelush/cli`, and `@caelush/web`.
- All workspace packages and apps are private and expose their public API through `src/index.ts`.
- `packages` may not depend on `apps`; `protocol` may not depend on any other Caelush feature package.
- Internal package dependencies, when they exist, use `workspace:*`; no deep `src` cross-package imports.
- Phase 0 does not implement AgentLoop, formal Agent state/session/run models, LLM providers, tools, runtime execution, storage, API, SSE, CLI UI, or web UI.
- Preserve the existing architecture design document; do not delete, overwrite, or auto-commit unrelated user files.

## Reference Architecture Notes

- OpenAI Codex reinforces a Core/UI split with explicit turn submission, event messages, interrupt, approval, and sandbox/execution-policy boundaries; Caelush therefore keeps apps thin and reserves protocol/event/security boundaries for later phases.
- Pi reinforces a provider-facing conversion boundary, an Agent Core event stream, tool execution events, session context, and `AbortSignal`; Caelush Phase 0 establishes package seams without implementing those behaviors.
- OpenCode reinforces schema/core separation and explicit Session, Provider, Permission, Registry, and Event ownership; Caelush protects `protocol` as a stable contract and keeps future responsibilities in separate packages.
- Goose reinforces Core/CLI separation, provider abstraction, streaming events, cancellation, and permission requests; Caelush documents these as future seams rather than installing their implementations now.
- Aider reinforces repository-awareness plus dirty-state and diff-based editing safeguards; Caelush initializes Git safely and keeps repository changes inspectable, without implementing editing tools.

### Task 1: Initialize the repository and define root workspace metadata

**Files:**

- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

**Interfaces:**

- Produces the root package scripts and workspace metadata consumed by package manifests and architecture tests.

- [ ] **Step 1: Confirm the repository state before writes**

Run `git status --short`, `git branch --show-current`, `git worktree list`, `node --version`, and `corepack pnpm@11 --version`. Record that the repository was newly initialized and that Node 24 is available; use pnpm 11.21.0 through Corepack for all package-manager commands.

- [ ] **Step 2: Write root configuration**

Create a private ESM root package with `engines.node` constrained to Node 24, `packageManager` set to `pnpm@11.21.0`, and scripts:

```json
{
  "build": "pnpm -r --if-present run build",
  "typecheck": "pnpm -r --if-present run typecheck",
  "test": "vitest run",
  "lint": "eslint .",
  "format:check": "prettier --check .",
  "check": "pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check"
}
```

Use only Phase 0 dev dependencies: TypeScript, `@types/node`, Vitest, ESLint, `typescript-eslint`, `@eslint/js`, and Prettier. Configure TypeScript as strict ESM-compatible base settings without Node-only module resolution so the future web app can inherit it.

- [ ] **Step 3: Run a metadata smoke check**

Run `corepack pnpm@11 install` after package manifests exist, then inspect the generated `pnpm-lock.yaml` header and root manifest to confirm the lockfile was produced by pnpm 11.21.0 and no prohibited runtime dependency was added.

### Task 2: Add red architecture tests before package scaffolding

**Files:**

- Create: `tests/architecture/workspace-shape.test.ts`
- Create: `tests/architecture/package-boundaries.test.ts`

**Interfaces:**

- Tests read JSON/YAML-like workspace metadata with Node `fs/promises` or synchronous `fs` APIs and assert the expected package/app manifests, names, exports, and dependency rules.

- [ ] **Step 1: Write the failing workspace-shape test**

Assert that all twelve package directories and three app directories exist, each has `package.json` and `src/index.ts`, each manifest has the expected unique `name`, `private: true`, ESM `type`, and an `exports` map whose root entry resolves to `./src/index.ts`.

- [ ] **Step 2: Write the failing boundary test**

Assert that package manifests contain no dependency on an `@caelush/daemon`, `@caelush/cli`, or `@caelush/web` package; `@caelush/protocol` has no `@caelush/*` dependency; any internal dependency value is exactly `workspace:*`; and no manifest or source file contains a path matching a cross-package deep `src` import such as `../../../packages/.../src/...`.

- [ ] **Step 3: Run the tests and verify the expected Red state**

Run `corepack pnpm@11 exec vitest run tests/architecture`. Expect failures caused by missing workspace directories/manifests, not syntax or test-runner errors.

### Task 3: Scaffold packages and apps to turn the architecture tests Green

**Files:**

- Create: `packages/{protocol,core,llm,context,tools,runtime,security,verification,events,storage,observability,shared}/package.json`
- Create: `packages/{protocol,core,llm,context,tools,runtime,security,verification,events,storage,observability,shared}/src/index.ts`
- Create: `apps/{daemon,cli,web}/package.json`
- Create: `apps/{daemon,cli,web}/src/index.ts`
- Create: package-local `tsconfig.json` files for all packages and apps

**Interfaces:**

- Every package has a stable public root export at `@caelush/<name>` through `src/index.ts`; all Phase 0 entries may contain only `export {};`.
- Every package and app provides uniform `build` and `typecheck` scripts using `tsc`, with output kept in ignored `dist/` directories.

- [ ] **Step 1: Create the minimal manifests and public entries**

Generate explicit manifests rather than a runtime generator. Set `main` and `types` to `./dist/index.js` and `./dist/index.d.ts`, set `exports` to those built files, and keep all package dependencies empty in Phase 0.

- [ ] **Step 2: Add package-local TypeScript inheritance**

Each Node package/app extends `../../tsconfig.base.json` or `../../../tsconfig.base.json` as appropriate, sets `rootDir: "src"`, `outDir: "dist"`, and `composite: false`; use the same strict base for all current empty entries while keeping the base browser-neutral.

- [ ] **Step 3: Run architecture tests to verify Green**

Run `corepack pnpm@11 exec vitest run tests/architecture`. Expect all workspace-shape and boundary assertions to pass.

- [ ] **Step 4: Refactor only duplication that does not change behavior**

Keep manifests explicit and readable; if test helpers are needed, place them under `tests/architecture/support/` and keep production packages empty. Re-run the architecture tests after any refactor.

### Task 4: Add repository guidance and architecture documentation

**Files:**

- Create: `README.md`
- Create: `AGENTS.md`
- Create: `docs/architecture/README.md`
- Create: `docs/architecture/package-boundaries.md`

**Interfaces:**

- Documentation describes current Phase 0 capability accurately and is the source of contributor/package-boundary guidance for future work.

- [ ] **Step 1: Document the current project and commands**

Describe Caelush as a future general-purpose Agent Kernel, state that the repository is in V1 Phase 0, list the frozen stack without claiming the uninstalled pieces are implemented, show the monorepo tree, and document `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, and `pnpm check`.

- [ ] **Step 2: Document architecture rules in AGENTS.md**

Include project identity, CLI/Web shared-core rules, package dependency direction, stable protocol contract, future AgentLoop/Tool/Provider/Dispatcher/Runtime/AgentEvent/Verification constraints, minimal-change and test rules, commands, and the explicit Phase 0 boundary.

- [ ] **Step 3: Document the layer view and package matrix**

In `docs/architecture/README.md`, show Presentation → Local Agent Service → Kernel → LLM/Tool System → Security/Runtime → OS integrations → Storage/Events/Trace. In `package-boundaries.md`, give each package/app concrete responsibilities, exclusions, allowed dependencies, prohibited dependencies, and typical future consumers.

- [ ] **Step 4: Run formatting on the documentation**

Run `corepack pnpm@11 exec prettier --check README.md AGENTS.md docs/architecture docs/superpowers/plans/2026-08-27-caelush-phase-0-foundation.md` and fix only formatting issues.

### Task 5: Add minimal CI and generate the lockfile

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `pnpm-lock.yaml`

**Interfaces:**

- CI installs the exact lockfile with Node 24 and pnpm 11, then invokes the single root quality gate `pnpm check`.

- [ ] **Step 1: Write the CI workflow**

Use maintained official actions `actions/checkout@v4` and `actions/setup-node@v4`, configure Node 24 and pnpm cache, enable Corepack, run `corepack pnpm@11 install --frozen-lockfile`, and run `corepack pnpm@11 run check`; do not add release, deploy, Docker, coverage, or version matrices.

- [ ] **Step 2: Generate and inspect the lockfile**

Run `corepack pnpm@11 install`, then inspect that all workspace projects are represented and only Phase 0 tooling is resolved.

### Task 6: Prove architecture guard failure and restore Green

**Files:**

- Temporarily modify and restore one package manifest only; do not retain the mutation.

**Interfaces:**

- The boundary test must fail for a realistic illegal dependency and pass again after restoration.

- [ ] **Step 1: Introduce a temporary illegal dependency**

Add a temporary `"@caelush/core": "workspace:*"` dependency to `packages/protocol/package.json` using a reversible patch.

- [ ] **Step 2: Run the focused guard and verify Red**

Run `corepack pnpm@11 exec vitest run tests/architecture/package-boundaries.test.ts`; confirm the test fails specifically on protocol depending on another Caelush feature package.

- [ ] **Step 3: Restore the manifest and verify Green**

Remove only the temporary dependency with `apply_patch`, then rerun the focused architecture test and the complete test suite.

### Task 7: Execute the full verification checklist and review Git state

**Files:**

- No new files; inspect all Phase 0 changes.

**Interfaces:**

- Completion report must include actual exit codes, test/failure counts, version output, diff statistics, and any remaining dirty files.

- [ ] **Step 1: Run the required commands independently**

Run `node --version`, `corepack pnpm@11 --version`, `corepack pnpm@11 install`, `corepack pnpm@11 run lint`, `corepack pnpm@11 run typecheck`, `corepack pnpm@11 run test`, `corepack pnpm@11 run build`, `corepack pnpm@11 run format:check`, and `corepack pnpm@11 run check`.

- [ ] **Step 2: Inspect repository changes**

Run `git status --short`, `git diff --stat`, and `git diff`; confirm the original architecture document remains intact, no user files were deleted or overwritten, and `node_modules`/build outputs are ignored and untracked.

- [ ] **Step 3: Apply verification-before-completion**

Use `superpowers:verification-before-completion` immediately before the final report. Do not claim completion unless fresh command output confirms the required checks and the architecture failure demonstration was restored to Green.
