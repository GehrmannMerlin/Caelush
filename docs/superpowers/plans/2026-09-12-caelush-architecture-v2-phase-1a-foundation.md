# Caelush Architecture V2 — Phase 1A Implementation Plan

## Goal

Install Architecture V2 as a machine-verifiable rule set without changing any
runtime behaviour of the existing system.

Concretely, Phase 1A delivers:

1. A checked-in dependency-boundary checker that reads the real repository with
   the TypeScript Compiler API and evaluates the frozen Architecture V2 rule
   matrix against both source imports and `package.json` workspace dependencies.
2. A deterministic, checked-in Legacy Dependency Baseline with no-new-violation
   and stale-entry ratchet semantics.
3. Three empty package skeletons — `packages/ai`, `packages/agent`,
   `packages/coding-agent` — that establish the final architectural destination
   and are already protected by the checker.
4. The boundary documentation that turns the frozen Architecture V2 design into a
   repo-local implementation guardrail.
5. The real scanned dependency baseline of the repository at the moment the
   guardrail became active.

Phase 1A deliberately does **not** migrate business code. The success condition
is that a future `agent → runtime`, `agent → storage`, `client → agent`, or
`ai → agent` edge fails CI immediately, not that the directory tree resembles the
final layout.

## Architecture

### Final package layout (frozen)

```text
packages/
  ai/            @caelush/ai            model, provider, API adapter, AI message/tool spec, stream, usage
  protocol/      @caelush/protocol      cross-process contracts, HTTP/SSE DTOs, public ids/errors/events
  agent/         @caelush/agent         general agent kernel, loop, context engine, tool framework,
                                        generic security/completion gate, memory contracts, events
  runtime/       @caelush/runtime       filesystem, shell, process, patch, git primitives, path boundary
  coding-agent/  @caelush/coding-agent  general-agent → coding-agent composition, coding tools/prompt
  storage/       @caelush/storage       durable adapter layer implementing upper-layer ports
  client/        @caelush/client        protocol-only client transport

apps/
  daemon/        composition root, HTTP/SSE surface
  cli/           terminal presentation
  web/           browser presentation
  launcher/      product entry, daemon discovery
```

`experimental/orchestrator` is forbidden in Phase 1A.

### Allowed dependency direction

```text
ai            -> none (inside Caelush)
protocol      -> none (inside Caelush)
runtime       -> execution substrate only, never above itself
storage       -> implements ports, never a business authority
agent         -> kernel contracts only
coding-agent  -> ai, protocol, agent, runtime
client        -> protocol
apps/*        -> packages/* (never the reverse)
```

### Checker architecture

```text
scripts/architecture/v2-rules.mjs          pure frozen rule matrix (data only)
scripts/architecture/scan-workspace.mjs    workspace discovery + AST/manifest edge extraction
scripts/architecture/check-boundaries.mjs  rule evaluation + baseline comparison + CLI
scripts/architecture/legacy-import-baseline.json   checked-in frozen violation list
```

Data flow:

```text
discoverWorkspaceProjects(root)
        ↓
scanSourceScope(root, projects, "src")  ──┐
scanSourceScope(root, projects, "test")  ─┤ diagnostic only, never baselined
manifest dependency scan                 ─┘
        ↓
evaluateScan(scan)                    → violations with rule ids
        ↓
compareWithBaseline(evaluated, baseline)
        ↓
NEW_VIOLATION / STALE_BASELINE_ENTRY / PASS
```

## Tech Stack

```text
Node.js             >=24.0.0 <25.0.0   (verified 24.18.0)
pnpm                11.21.0            (unchanged)
TypeScript          6.0.3              (existing devDependency, used via its Compiler API)
Vitest              4.1.11             (existing test runner)
ESLint              10.9.1             (existing)
Prettier            3.9.6              (existing)
```

No third-party dependency is added. `dependency-cruiser`, `madge`, `nx`,
`eslint-plugin-boundaries`, and equivalents are explicitly rejected; the checker
uses only `node:fs`, `node:path`, `node:child_process`, `node:util`, and the
already-installed `typescript` package resolved through the workspace root
`node_modules`.

## Specs / Frozen Constraints

### Frozen rule matrix

Every forbidden edge is expressed twice: once as a `source-import` rule and once
as a `package-manifest` rule. Rule ids are derived mechanically:

```text
<FROM>_MUST_NOT_DEPEND_ON_<TO>                  source-import
<FROM>_MUST_NOT_DECLARE_DEPENDENCY_ON_<TO>      package-manifest
```

The complete frozen set:

```text
AI_MUST_NOT_DEPEND_ON_{AGENT,CODING_AGENT,RUNTIME,STORAGE,CLIENT}
PROTOCOL_MUST_NOT_DEPEND_ON_{AGENT,RUNTIME,CODING_AGENT,STORAGE,DAEMON,CLIENT}
AGENT_MUST_NOT_DEPEND_ON_{CODING_AGENT,RUNTIME,STORAGE,CLIENT,DAEMON}
RUNTIME_MUST_NOT_DEPEND_ON_{AGENT,CODING_AGENT,STORAGE,CLIENT,DAEMON}
CODING_AGENT_MUST_NOT_DEPEND_ON_{STORAGE,CLIENT,DAEMON}
STORAGE_MUST_NOT_DEPEND_ON_{DAEMON,CLIENT,WEB,CLI}
CLIENT_MUST_NOT_DEPEND_ON_{AGENT,RUNTIME,STORAGE,CODING_AGENT}
WEB_MUST_NOT_DEPEND_ON_{AGENT,RUNTIME,STORAGE,CODING_AGENT}
CLI_MUST_NOT_DEPEND_ON_{AGENT,RUNTIME,STORAGE,CODING_AGENT}
```

80 rules total: 40 forbidden edges, each enforced once as a `source-import` rule and
once as a `package-manifest` rule.

### Frozen scanning constraints

- Scan roots: `packages/*/<scope>/**` and `apps/*/<scope>/**`.
- Authoritative scope is `src`. Project `test` directories are a diagnostic
  surface that never enters the baseline.
- Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.
- Excluded directory names: `node_modules`, `dist`, `dist-test`, `build`, `out`,
  `coverage`, `.next`, `.nuxt`, `.cache`, `.turbo`, `.vite`, `.worktrees`,
  `release-artifacts`, `test-results`, `.vitest`, `__snapshots__`.
- Excluded path segments inside a scope: `dist`, `build`, `coverage`,
  `generated`, `.cache`.
- Specifier normalization: the first path segment after `@caelush/` is the
  package. `@caelush/agent/tools/foo` normalizes to `@caelush/agent`.
- Parser: TypeScript Compiler API. `static-import`, `export-from`,
  `dynamic-import`, `require-call` (including `import x = require(...)`).
  Regular expressions are never the primary parser.
- A specifier that does not resolve to a discovered workspace project is
  recorded as a diagnostic and is never a violation.

### Frozen baseline semantics

- Match key: `kind`, `sourcePackage`, `sourcePath`, `targetPackage`, `rule`,
  `dependencyField` (manifest entries only).
- Deliberately excluded from the match key: line, column, occurrence count, raw
  deep specifier, import kind.
- Listed violation → allowed. Unlisted violation → `NEW_VIOLATION` → exit 1.
  Listed entry without a matching violation → `STALE_BASELINE_ENTRY` → exit 1.
  Duplicate entry → exit 1.
- The baseline is never written by `pnpm check:architecture`. Only an explicit
  `--write-baseline` writes it, and CI refuses that write whenever it would add
  entries that are not already checked in.
- The baseline is deterministic, sorted, LF-only, one entry per line.

### Frozen non-changes

Phase 1A must not modify Run behaviour, Agent Loop, model invocation, Tool
lifecycle, Message semantics, Event semantics, Context semantics, Session
semantics, SQLite schema, Drizzle migrations, HTTP API, SSE, Web UI, CLI UX, or
any legacy package's code or identity.

Preserved semantics include: `RunController` as the lifecycle authority; final
candidate is not `COMPLETED`; only Coding Verification authorizes `COMPLETED`;
Tool execution passes through the durable/security pipeline; durable approval,
cancellation, deadline, retry, budget, and tool settlement behaviour; durable SSE
sequence replay; raw tool output is not the model-facing observation; bounded
context overflow recovery; budget and resource governance separation; memory
never overrides Runtime/Security/Verification authority; Web/CLI are never the
Run State Authority.

## Files

### Created

```text
scripts/architecture/v2-rules.mjs
scripts/architecture/scan-workspace.mjs
scripts/architecture/check-boundaries.mjs
scripts/architecture/legacy-import-baseline.json
tests/architecture/architecture-boundaries.test.ts
tests/architecture/support/fixture-workspace.ts
packages/ai/package.json
packages/ai/tsconfig.json
packages/ai/src/index.ts
packages/agent/package.json
packages/agent/tsconfig.json
packages/agent/src/index.ts
packages/coding-agent/package.json
packages/coding-agent/tsconfig.json
packages/coding-agent/src/index.ts
docs/architecture/v2/DEPENDENCY_BOUNDARIES.md
docs/architecture/v2/PHASE_1A_DEPENDENCY_BASELINE.md
docs/superpowers/plans/2026-09-12-caelush-architecture-v2-phase-1a-foundation.md
```

### Modified

```text
package.json                          adds check:architecture, check:architecture:verify,
                                      wires architecture check first in `check`
pnpm-lock.yaml                        three new workspace importers, no new external package
tests/architecture/support/workspace.ts   registers the three new package identities
```

### Deleted

```text
none
```

### Explicitly untouched

```text
packages/llm  packages/core  packages/context  packages/tools  packages/security
packages/verification  packages/memory  packages/events  packages/shared
packages/observability
packages/protocol  packages/runtime  packages/storage  packages/client
apps/**
pnpm-workspace.yaml
eslint.config.js
tsconfig.json  tsconfig.base.json  .prettierrc.json  .prettierignore
```

## Interfaces

### `scripts/architecture/v2-rules.mjs`

```ts
export const MANIFEST_DEPENDENCY_FIELDS: string[];
export const CAELUSH_SCOPE: string; // "@caelush/"
export const V2_ALLOWED_DEPENDENCIES: Record<string, readonly string[]>;
export const V2_TARGET_PACKAGES: string[];
export const V2_HOST_APPS: string[];
export const V2_PHASE_1A_CREATED_PACKAGES: string[]; // ai, agent, coding-agent
export const V2_PHASE_1A_DEFERRED_PACKAGES: string[]; // protocol, runtime, storage, client
export const DEPENDENCY_RULES: DependencyRule[];
export const RULE_INDEX: Map<string, DependencyRule>; // key: "<kind>\0<from>\0<to>"
export const RULE_IDS: string[]; // sorted
export function findRule(kind, fromPackage, toPackage): DependencyRule | undefined;
```

### `scripts/architecture/scan-workspace.mjs`

```ts
export const SOURCE_EXTENSIONS: string[];
export const EXCLUDED_DIRECTORY_NAMES: Set<string>;
export function extractSourceImports(filePath, contents): SourceImport[];
export function normalizeCaelushSpecifier(specifier): string | undefined;
export function packageIdentityFromSpecifier(specifier): string | undefined;
export function isScannableSourcePath(relativeFilePath, scopeRoot?): boolean;
export function discoverWorkspaceProjects(root): Promise<WorkspaceProject[]>;
export function scanWorkspace(
  root,
  options?: { includeTests?: boolean },
): Promise<{
  projects;
  projectByIdentity;
  sourceEdges;
  manifestEdges;
  sourceFileCount;
  sourceImportCount;
  unknownCaelushSpecifiers;
  testSourceEdges;
  testSourceFileCount;
  testSourceImportCount;
}>;
```

### `scripts/architecture/check-boundaries.mjs`

```ts
export const DEFAULT_REPOSITORY_ROOT: string;
export const DEFAULT_BASELINE_PATH: string;
export const BASELINE_SCHEMA_VERSION: 1;
export const UNKNOWN_HEAD: string;
export const UNKNOWN_HEAD_DATE: string;
export function baselineKey(entry): string;
export function sortBaselineEntries(entries): BaselineEntry[];
export function evaluateScan(scan): { violations; sourceEdges; manifestEdges };
export function compareWithBaseline(
  evaluated,
  baselineEntries,
): {
  matched;
  newViolations;
  staleEntries;
  duplicateBaselineKeys;
};
export function buildBaselineDocument(evaluated, context): object;
export function renderBaselineDocument(document): string;
export function canonicalizeBaselineDocument(document): string;
export function parseBaselineDocument(value, label?): BaselineEntry[];
export function formatViolation(entry, locationIndex): string;
export function formatStaleEntry(entry): string;
export function formatSummary(summary): string;
export function runBoundaryCheck(options?): Promise<{ exitCode; output; summary }>;
```

CLI surface:

```text
node scripts/architecture/check-boundaries.mjs [--verify-baseline] [--write-baseline]
                                               [--json] [--report <path>]
                                               [--root <path>] [--baseline <path>]
                                               [--help]
exit 0  no NEW violation, no STALE baseline entry
exit 1  new violation, stale entry, duplicate entry, missing/invalid baseline,
        baseline drift under --verify-baseline, or a CI-refused write
exit 2  unknown command-line argument
```

### `tests/architecture/support/fixture-workspace.ts`

```ts
export type FixtureProjectSpec = {
  source?: Record<string, string>;
  test?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
export type FixtureWorkspace = { root: string; projectPath(p): string; cleanup(): Promise<void> };
export function createFixtureWorkspace(specs): Promise<FixtureWorkspace>;
export function v2WorkspaceSpec(overrides?): Record<string, FixtureProjectSpec>;
```

### `packages/{ai,agent,coding-agent}`

```json
{
  "name": "@caelush/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc --build", "typecheck": "tsc --noEmit" }
}
```

`src/index.ts` contains `export {};` preceded by a responsibility header comment.
No dependencies section is declared, because no source file uses one.

## Tasks

Each task was executed in order. Test-driven ordering is mandatory for the
checker: a failing test is observed before the implementation that satisfies it.

### Task 1 — Repository baseline scan

Re-run `git status --short`, `git branch --show-current`, `git rev-parse HEAD`,
`git log -10 --oneline`, `git remote -v`. Record the real HEAD and compare it
with the stated analysis baseline. Establish a clean branch from the real HEAD
without stashing, resetting, checking out, or cleaning any user file.

### Task 2 — Real dependency audit

Scan `packages/*/package.json`, `apps/*/package.json`, `packages/*/src/**`,
`apps/*/src/**`, `tsconfig*.json`, `eslint.config.js`, root `package.json`, and
`pnpm-workspace.yaml`. Produce the manifest adjacency list, the source adjacency
list, the per-project identity map, and the unknown-specifier diagnostic.

### Task 3 — Failing tests: specifier normalization

Write expectations for `@caelush/agent`, `@caelush/agent/context`, and
`@caelush/agent/tools/foo` all normalizing to `@caelush/agent`, and for
non-Caelush specifiers returning `undefined`. Run the test file and observe the
import failure.

### Task 4 — Failing tests: AST import extraction

Write expectations for `static-import`, `export-from`, `dynamic-import`, and
`require-call` detection, for one-based line/column positions, for ignoring
non-static dynamic imports, and for never treating a string literal as an edge.
Run and observe failure.

### Task 5 — Failing tests: source scope selection

Write expectations for scanning `src` at any depth and for excluding `dist`,
`node_modules`, `build`, `coverage`, `src/generated`, non-source extensions, and
project `test` directories. Run and observe failure.

### Task 6 — Rule engine

Implement `v2-rules.mjs` as pure data plus `findRule`. Write expectations that
rule ids are unique, mechanically derived, resolvable for a forbidden direction,
and unresolvable for an allowed direction, and that every forbidden edge carries
both a source and a manifest rule. Run and observe failure, then implement.

### Task 7 — Rule engine on fixture workspaces

Implement fixture generation. Write expectations covering: an allowed
`coding-agent → agent|protocol|runtime|ai` workspace passes; `agent → runtime`
fails with the exact human-readable violation format; deep subpath imports
collapse to one edge with the correct occurrence count; dynamic import and
export-from are detected; `ai → agent` in `devDependencies` fails without any
source import; all four manifest sections are scanned; both hosts fail on all
four forbidden edges each; self-import through a deep subpath is not a violation;
test-scope edges are separated from the authoritative scope. Run and observe
failure, then implement.

### Task 8 — Baseline semantics

Implement `baselineKey`, deterministic sorting, document building, rendering,
parsing, and comparison. Write expectations covering: a listed violation is
frozen and passes; an unlisted violation fails; a resolved violation fails as a
stale entry with the required message; editing a baselined file or adding a
second import leaves the baseline byte-identical; drift is detected even while
listed violations still match; a missing baseline fails; a malformed baseline
throws; a CI write that would grow the baseline is refused and leaves the file
unchanged; a CI write that only shrinks is allowed; provenance is reproducible;
an ordinary check never writes; rendering is sorted, LF-only, one entry per line,
and idempotent; duplicate entries are detected; a new violation and a stale entry
in the same run are both reported. Run and observe failure, then implement.

### Task 9 — Repository integration

Write expectations that the checked-in baseline matches the current checkout, that
the real source scope parses with zero unresolved Caelush specifiers, that the
checked-in baseline is deterministic and reviewed, and that the command-line entry
point works, exits 1 on an injected forbidden edge, refuses a growing CI write,
and exits 2 on an unknown argument. Run and observe failure, then implement.

### Task 10 — Package skeletons

Create `packages/ai`, `packages/agent`, and `packages/coding-agent` with the
manifest and tsconfig conventions of the existing packages. Do not copy legacy
source, do not re-export a legacy package, do not create a compatibility bridge,
do not guess a public API, and do not declare an unused dependency. Build each
package independently.

### Task 11 — Workspace-shape registration

Register the three new identities in `tests/architecture/support/workspace.ts` so
the existing workspace-shape and package-boundary suites cover them. Confirm
`pnpm-workspace.yaml` already covers `packages/*` and leave it unmodified.

### Task 12 — Root scripts

Add `check:architecture` and `check:architecture:verify`, and place
`check:architecture` first in `check`:

```text
pnpm check:architecture && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check
```

### Task 13 — Baseline generation and documentation

Generate the checked-in baseline from the real repository, write
`docs/architecture/v2/DEPENDENCY_BOUNDARIES.md` and
`docs/architecture/v2/PHASE_1A_DEPENDENCY_BASELINE.md`, and record every number
from the real scan.

### Task 14 — Verification and delivery

Run the targeted architecture tests, the repository architecture check, the three
package builds, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check`.
Inspect `git status --short`, `git diff --stat`, and `git diff` for unintended
changes. Commit in the defined boundaries and push the branch.

## Tests

### Test file

```text
tests/architecture/architecture-boundaries.test.ts
```

### Required coverage, mapped to test names

```text
legal import passes
  "passes a workspace whose imports follow the allowed direction"

illegal target import fails
  "fails on a forbidden source import and names the rule and package"

legacy violation in baseline passes
  "freezes an existing violation when it is present in the baseline"

new legacy violation fails
  "fails on a new violation that is absent from the baseline"

removed violation causes stale baseline failure
  "fails with a stale baseline entry after the violation disappears"

deep import normalized correctly
  "normalizes every deep subpath to its owning Caelush package"
  "normalizes a deep subpath import to one package edge"

package.json illegal dependency detected
  "detects an illegal workspace dependency in package.json without source imports"
  "scans every manifest dependency section"

dynamic import detected
  "detects dynamic import and export-from boundaries"
  "detects static import, export-from, dynamic import and require forms"

export-from detected
  "detects dynamic import and export-from boundaries"
  "detects static import, export-from, dynamic import and require forms"
```

Additional coverage:

```text
"declares both a source and a manifest rule for each forbidden edge"
"resolves a rule only for a forbidden direction and kind"
"keeps every frozen rule id unique and derived from its edge"
"keeps the Web and CLI hosts off the kernel and persistence packages"
"does not flag a project for importing itself through a deep subpath"
"separates diagnostic test-scope edges from the authoritative source scope"
"keeps the baseline stable when a baselined file is edited or gains another import"
"detects baseline drift even while the frozen violations still match"
"reports a missing baseline instead of silently passing"
"rejects a malformed baseline document"
"refuses a baseline write in CI when it would add unreviewed entries"
"allows a CI baseline write that only shrinks the baseline"
"records reproducible provenance in the baseline"
"never rewrites the baseline during an ordinary check"
"produces a deterministic, sorted, one-entry-per-line baseline"
"keeps baseline keys and ordering independent of discovery order"
"round-trips a rendered baseline document through the parser"
"detects duplicate baseline entries"
"fails a new violation and a stale entry in the same run"
"matches entries by edge identity rather than by location"
"distinguishes a manifest entry from a source entry for the same edge"
"ships a checked-in baseline that matches the current checkout"
"parses the real source scope and resolves every Caelush specifier"
"keeps the checked-in baseline deterministic and reviewed"
"exposes a working read-only command-line entry point"
"fails the command-line entry point when a forbidden edge is injected"
"refuses a CI baseline write from the command line when it would grow the baseline"
"rejects an unknown command-line argument with the usage message"
"records one-based line and column positions"
"ignores a dynamic import it cannot resolve statically"
"scans project src trees at any depth"
"excludes generated output, dependency installs and non-source scopes"
"scans project test trees only when the test scope is requested"
```

### Fixture isolation

Unit-level boundary tests never scan the real repository. They construct a
throwaway workspace in the OS temporary directory through
`createFixtureWorkspace`, mirroring `packages/*` and `apps/*`, and remove it in
`afterEach`. The real repository is used only for integration and smoke
validation.

## Commit boundaries

### Commit 1 — `docs(architecture): capture v2 dependency baseline`

```text
docs/superpowers/plans/2026-09-12-caelush-architecture-v2-phase-1a-foundation.md
docs/architecture/v2/DEPENDENCY_BOUNDARIES.md
docs/architecture/v2/PHASE_1A_DEPENDENCY_BASELINE.md
```

Documentation only. No business code, no package source, no scripts.

### Commit 2 — `chore(architecture): scaffold v2 package boundaries`

```text
packages/ai/{package.json,tsconfig.json,src/index.ts}
packages/agent/{package.json,tsconfig.json,src/index.ts}
packages/coding-agent/{package.json,tsconfig.json,src/index.ts}
pnpm-lock.yaml
tests/architecture/support/workspace.ts
```

Skeletons and workspace registration only. No checked-in rules and no baseline.

### Commit 3 — `test(architecture): enforce v2 dependency ratchet`

```text
scripts/architecture/v2-rules.mjs
scripts/architecture/scan-workspace.mjs
scripts/architecture/check-boundaries.mjs
scripts/architecture/legacy-import-baseline.json
tests/architecture/architecture-boundaries.test.ts
tests/architecture/support/fixture-workspace.ts
package.json
```

The ratchet: rules, scanner, checker, frozen baseline, tests, and the root
scripts that make it enforceable.

## Acceptance criteria

Phase 1A is complete only when all of the following hold:

- [x] An isolated task branch is used; no development happens on `master`.
- [x] The latest real HEAD is scanned and recorded; no user work is overwritten.
- [x] This implementation plan is in the repository.
- [x] The current dependency graph is scanned from real source, not guessed.
- [x] The dependency baseline report is complete.
- [x] The Architecture V2 boundary document is complete.
- [x] `packages/ai` exists and builds independently.
- [x] `packages/agent` exists and builds independently.
- [x] `packages/coding-agent` exists and builds independently.
- [x] Architecture V2 rules are machine-readable.
- [x] Source imports are scanned with the TypeScript Compiler API.
- [x] `export ... from` is scanned.
- [x] Dynamic `import()` is scanned.
- [x] `require()` is scanned.
- [x] `package.json` workspace dependencies are scanned across all four fields.
- [x] The legacy baseline is deterministic, sorted, and human-readable.
- [x] A new violation fails the check.
- [x] A stale baseline entry fails the check.
- [x] The baseline is never modified automatically.
- [x] `pnpm check:architecture` exists.
- [x] `pnpm check` runs the architecture check first.
- [x] Targeted architecture tests pass.
- [x] The repository architecture check passes.
- [x] `pnpm typecheck` is verified.
- [x] `pnpm test` is verified.
- [x] `pnpm build` is verified.
- [x] `pnpm check` is executed.
- [x] No database migration is added.
- [x] No API change is made.
- [x] No UI change is made.
- [x] No business behaviour change is made.
- [x] No legacy package is deleted or renamed.
- [x] All changes are committed.
- [x] The branch is pushed to GitHub.
- [x] The working tree is clean at the end.

## Rollback considerations

Phase 1A is additive and reversible.

### Full rollback

Reverting commit 3 removes the checker, the tests, the frozen baseline, and the
root scripts. Reverting commit 2 removes the three empty skeletons and the
workspace-shape registration. Reverting commit 1 removes the documentation.
Because no legacy package source, migration, API, schema, or UI file is touched
by any of the three commits, a full revert restores the exact previous behaviour
with no data or contract consequence.

### Partial rollback

- If the ratchet blocks a legitimate migration step: do the migration, then run
  `node scripts/architecture/check-boundaries.mjs --write-baseline`, verify the
  diff only removes entries, and commit the shrunken baseline with the migration.
- If a rule is wrong: fix `v2-rules.mjs`, keep the rule matrix and the manifest
  rules symmetric, and add a test that pins the corrected direction. Do not
  loosen a rule merely to make current code pass.
- If the checker itself is broken: `pnpm check` fails closed and CI stays red.
  The recovery is to fix the checker, never to drop `check:architecture` from
  `check`.
- If the baseline file is lost: `check:architecture` fails with "baseline
  missing" and the recovery is an explicit local regeneration and review.

### Residual risk

The checker is an architecture guardrail, not a semantic guarantee. It verifies
package-level dependency direction; it cannot verify that a package respects its
responsibility. That remains the job of the existing `tests/architecture/`
suites, the `AGENTS.md` phase rules, and review.

## Out of scope

```text
Phase 1B, AI migration, Agent migration, CodingAgent migration
renaming packages/llm to packages/ai
renaming packages/core to packages/agent
moving context, tools, security, verification, memory, events, shared
SQLite schema or Drizzle migration changes
HTTP API, SSE, or protocol semantic changes
Run, Tool, Approval, Verification, Context, Message, or Session semantic changes
Web UI or CLI UX changes
model invocation changes
unrelated opportunistic cleanup
reducing the baseline by refactoring business code
creating experimental/orchestrator
```
