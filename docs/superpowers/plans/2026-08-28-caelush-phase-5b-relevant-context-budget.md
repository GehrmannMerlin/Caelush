# Caelush Phase 5B — Relevant File Discovery & Context Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@caelush/context` with deterministic, bounded, explainable relevant-file discovery and provider-independent file-context budgeting while preserving the Phase 5A project-intelligence boundary.

**Architecture:** `RelevantFilePlanner` composes a metadata-first `CandidateFileDiscovery`, an `IgnorePolicy`, a pure `RelevantPathRanker`, an injectable `TokenEstimator`, and a budgeted content selector. The planner consumes the existing `ProjectIntelligenceSnapshot` and `ContextFileSystem`, returns a structured `RelevantFileContextPlan`, and never mutates the snapshot or renders an LLM prompt.

**Tech Stack:** TypeScript ESM, Node 24, Vitest, existing `ContextFileSystem`/Phase 5A types, and exactly pinned `ignore@7.0.6` for Git-ignore matching.

**Spec:** User-provided Phase 5B brief in `C:/Users/韩吉衍/.codex/attachments/d776eeed-997f-4ce0-af9f-0e5616c95226/pasted-text.txt`.

## Global Constraints

- Phase 5 is exactly 5A, 5B, and 5C; this plan implements only 5B.
- The implementation must start from the Phase 5A-containing base `origin/codex/phase-5a-context-foundation` and the dedicated branch `codex/phase-5b-relevant-context-budget`.
- `ProjectIntelligenceSnapshot` and `ContextFileSystem` are reused; `ProjectInspector` is not expanded to perform file planning.
- Discovery remains inside `snapshot.projectRoot.projectRoot` and `snapshot.workspace.realRoot`, and never traverses directory symlinks, `.worktrees`, VCS metadata, dependencies, generated output, or other hard exclusions.
- `.gitignore` matching uses the exact pinned `ignore@7.0.6` dependency; no hand-written glob parser or global Git excludes are used.
- Discovery is metadata-first; source bodies are read only during budgeted selection.
- Ordinary unreadable/non-text source candidates become diagnostics and are skipped; unreadable, invalid, or oversized `.gitignore` files fail closed with `ContextIgnoreError`.
- Common credential paths are excluded from ambient context; `.env.example`, `.env.sample`, and `.env.template` remain eligible.
- Ranking is deterministic and explainable through `RelevanceReason[]`; no mtime, AST graph, embeddings, RAG, NLP library, or LLM ranking is used.
- The estimator is `ceil(UTF-8 byte length / 3)` for non-empty text and is a planning heuristic, not billing-token truth.
- Default file budget is 12 files, 12000 total estimated tokens, 4000 tokens per file, and 128 minimum useful tokens; it is not the final model context window.
- No dependency on `@caelush/llm`, AI SDKs, storage, events, daemon, runtime, tools, shell, child processes, network, or `process.env` may be introduced.
- New and modified files must pass targeted Prettier checks; existing repository-wide formatting debt must not be rewritten.

---

### Task 1: Pin `ignore` and define the ambient ignore policy

**Files:**

- Modify: `packages/context/package.json` — add exact production dependency `"ignore": "7.0.6"`.
- Modify: `pnpm-lock.yaml` — update through `pnpm install --lockfile-only`/`pnpm install` using the pinned version.
- Modify: `packages/context/src/errors.ts` — add `ContextIgnoreError` with code `IGNORE_POLICY_FAILURE`.
- Create: `packages/context/src/ignore-policy.ts` — define hard exclusions, sensitive-name rules, binary extensions, and per-directory `ignore@7.0.6` layers behind a class API.
- Create: `packages/context/test/ignore-policy.test.ts` — policy and Git-ignore behavior tests.
- Modify: `packages/context/src/index.ts` — export only the public policy/error types that callers need; do not export the matcher instance or internal rule-layer type.

**Interfaces:**

- `IgnorePolicy` consumes `ContextFileSystem`, project root, and workspace real root; it produces `IgnoreDecision` values and throws `ContextIgnoreError` for policy metadata failures.
- `IgnoreDecision` contains only public booleans/reason metadata needed by discovery; the underlying `ignore` object and matcher layers stay private.
- Public hard defaults include `.git`, `.hg`, `.svn`, `.worktrees`, `node_modules`, `.pnpm`, `.yarn/cache`, `.venv`, `venv`, `__pycache__`, `target`, `dist`, `build`, `coverage`, `out`, `.next`, `.nuxt`, `.turbo`, `.cache`, and `vendor`.

- [ ] **Step 1: Add failing tests** for exact dependency intent, root and nested `.gitignore`, negation, ignored-parent short-circuit, root-anchored paths, Windows separators, hard exclusions that cannot be negated, `.env` versus `.env.example`, and binary extensions.
- [ ] **Step 2: Run `pnpm vitest run packages/context/test/ignore-policy.test.ts`** and confirm failures are caused by the missing policy/error API rather than fixture errors.
- [ ] **Step 3: Add `ignore@7.0.6` and implement the minimal policy.** Read only `.gitignore` metadata through `ContextFileSystem.readTextFile` with a 131072-byte limit; reject oversized, invalid UTF-8, unreadable, and directory `.gitignore` files with `ContextIgnoreError`; evaluate root-to-nested layers using project-relative slash-normalized paths; apply hard/sensitive/binary rules after Git-ignore matching so negations cannot re-include ambient exclusions.
- [ ] **Step 4: Run the focused test again** and confirm all policy behaviors pass.
- [ ] **Step 5: Run `pnpm prettier --check packages/context/src/errors.ts packages/context/src/ignore-policy.ts packages/context/test/ignore-policy.test.ts packages/context/src/index.ts packages/context/package.json`** and commit `chore(context): add gitignore matching dependency`.

### Task 2: Implement bounded metadata-first candidate discovery

**Files:**

- Create: `packages/context/src/file-discovery.ts` — bounded deterministic directory traversal and discovery statistics.
- Create: `packages/context/test/file-discovery.test.ts` — traversal, boundaries, limits, symlinks, and no-eager-read tests.
- Modify: `packages/context/src/index.ts` — export `CandidateFileDiscovery` and its public option/result/stat types.

**Interfaces:**

- `CandidateDiscoveryOptions` has positive safe-integer defaults `maxVisitedEntries=20000`, `maxCandidateFiles=5000`, `maxDepth=32`, and `maxRankedCandidatesReturned=100` (the last cap is consumed by ranking but remains part of the discovery contract only if needed).
- `CandidateFile` contains `path`, `relativePath`, `fileName`, optional lowercase `extension`, `depth`, and location metadata; it has no source content or Node `Dirent`/`Stats` type.
- `CandidateFileDiscovery.discover(snapshot, options?)` returns `{ candidates, stats, diagnostics }`, where stats contain `visitedEntries`, `candidateFiles`, `ignoredEntries`, `hardExcludedEntries`, `sensitiveSkipped`, `binarySkipped`, `symlinkSkipped`, `nonTextSkipped`, `readFailures`, and `truncatedByLimit`.
- Discovery uses `snapshot.projectRoot.projectRoot` as its root, validates real paths against `snapshot.workspace.realRoot` and project root, never follows symlink entries, and reads only directories plus `.gitignore` policy metadata.

- [ ] **Step 1: Add failing tests** for project-root-only traversal, workspace/project boundary escape, directory and file symlinks, `.worktrees`/`node_modules`/`dist`, depth/visited/candidate limits, deterministic traversal, CWD/active-package traversal priority, and a recording fake filesystem proving source bodies are not read.
- [ ] **Step 2: Run the focused discovery test** and confirm the missing discovery API causes the expected failures.
- [ ] **Step 3: Implement breadth/depth-bounded traversal.** Sort entries, prioritize the CWD ancestor/subtree and active package subtree before lexicographic siblings, stop adding files once the candidate cap is reached, return `DISCOVERY_LIMIT_REACHED` diagnostics instead of throwing on limits, and prune ignored parents before loading nested `.gitignore` files.
- [ ] **Step 4: Run the focused discovery test** and verify all limits/boundaries and the read-count assertion pass.
- [ ] **Step 5: Run Prettier on changed files and commit `feat(context): add bounded project file discovery`.**

### Task 3: Add deterministic query normalization and path relevance ranking

**Files:**

- Create: `packages/context/src/relevance.ts` — tokenizer, scoring, reason generation, and stable ordering.
- Create: `packages/context/test/relevance.test.ts` — score/reason/tie-break tests.
- Modify: `packages/context/src/index.ts` — export query, candidate, reason, and ranker-facing public types.

**Interfaces:**

- `RelevantFileQuery` is `{ readonly text: string; readonly explicitPaths?: readonly string[] }`; empty text is valid.
- `RelevanceReason` is a closed string union covering explicit exact/basename, query basename/stem/segment/substring, CWD subtree, active package, same directory, test-source pair, common entrypoint, project document, and depth penalty signals.
- `RelevantFileCandidate` is the metadata candidate plus `score` and `reasons`.
- `RelevantPathRanker.rank(candidates, query, snapshot)` returns at most 100 candidates by default, sorted by score descending, active-package membership, depth ascending, and project-relative path lexicographically.

- [ ] **Step 1: Add failing tests** for explicit-path wins, basename/stem/segment/substring matching, CWD and active package boosts, same-directory boost, test/source pairing in both directions, entrypoint/document boosts, depth penalty, Unicode query tokenization, score reasons, cap/floor behavior, and stable ties.
- [ ] **Step 2: Run the focused relevance tests** and verify the ranker/tokenizer are absent.
- [ ] **Step 3: Implement normalization and the fixed scoring table:** explicit exact +1000, explicit basename +300, CWD subtree +140, active package +120, same CWD directory +80, test/source pair +120, common entrypoint +25, project document +20; per unique query term use only the highest of basename +220, stem +180, path segment +100, substring +30; cap all query-term contribution at +500; subtract `min(40, 2 * relative-directory-depth)` and clamp the final score at zero.
- [ ] **Step 4: Run focused relevance tests** and verify exact reasons and deterministic order.
- [ ] **Step 5: Format changed files and commit `feat(context): rank task-relevant project files`.**

### Task 4: Implement the injectable UTF-8 token estimator

**Files:**

- Create: `packages/context/src/token-estimator.ts` — estimator interface and default implementation.
- Create: `packages/context/test/token-estimator.test.ts` — byte-based heuristic tests.
- Modify: `packages/context/src/index.ts` — export `TokenEstimator` and `Utf8HeuristicTokenEstimator`.

**Interfaces:**

- `TokenEstimator` exposes `estimateText(text: string): number`.
- `Utf8HeuristicTokenEstimator` returns `0` for empty text and `Math.ceil(Buffer.byteLength(text, "utf8") / 3)` otherwise; it has no provider dependency.

- [ ] **Step 1: Add failing tests** for empty, ASCII, CJK, mixed code/text, deterministic, and same-input/same-output behavior.
- [ ] **Step 2: Run the focused estimator test** and confirm the missing class fails.
- [ ] **Step 3: Implement the two-line heuristic behind the interface.**
- [ ] **Step 4: Run the focused estimator test** and confirm all cases pass.
- [ ] **Step 5: Format and commit `feat(context): add provider-independent token estimation`.**

### Task 5: Add budget validation and safe content selection

**Files:**

- Create: `packages/context/src/file-budget.ts` — budget types, defaults, validation, line-safe content reads, and selection diagnostics.
- Create: `packages/context/test/file-budget.test.ts` — budget and content behavior tests.
- Modify: `packages/context/src/errors.ts` only if a narrowly scoped budget-validation error is required; otherwise use existing `ContextError` with a stable budget code.
- Modify: `packages/context/src/index.ts` — export budget/report/section types required by the planner.

**Interfaces:**

- `RelevantFileBudget` is `{ maxSelectedFiles; maxTotalTokens; maxPerFileTokens; minUsefulFileTokens }`, all positive safe integers with `maxPerFileTokens <= maxTotalTokens`; defaults are `12/12000/4000/128`.
- `RelevantFileContextSection` contains `provenance`, `content`, `estimatedTokens`, `bytesIncluded`, and `truncated`.
- `FileBudgetSelector.select(rankedCandidates, filesystem, estimator, budget)` returns sections, a budget report, and diagnostics; it never adds a truncation marker to content.
- Read size is `min(maxPerFileTokens, remainingTokens) * 3`, capped at 262144 bytes; whitespace-only/empty, binary, invalid UTF-8/NUL, and ordinary read failures are skipped with counts/diagnostics; truncation removes an incomplete final line when a newline exists and preserves the valid prefix when it does not.

- [ ] **Step 1: Add failing tests** for total/per-file/file-count limits, minimum-useful stop, full small files, large truncation, UTF-8 and line safety, empty/whitespace/non-text/read-failure skips, injectable estimator, and no truncation marker.
- [ ] **Step 2: Run the focused budget tests** and verify the selector is missing.
- [ ] **Step 3: Implement strict budget validation and greedy ranked selection.** Recompute included tokens from the selected text, never exceed total/per-file limits, skip unusable content without failing the plan, and keep structured `truncated` state.
- [ ] **Step 4: Run the focused budget tests** and confirm all budget assertions pass.
- [ ] **Step 5: Format and commit `feat(context): budget relevant file context`.**

### Task 6: Define provenance and the structured `RelevantFileContextPlan`

**Files:**

- Create or extend: `packages/context/src/relevant-file-plan.ts` — public plan/provenance/report types and internal result assembly helpers.
- Create: `packages/context/test/relevant-file-plan.test.ts` — provenance shape and snapshot-separation tests.
- Modify: `packages/context/src/index.ts` — export `RelevantFileContextPlan`, `FileContextProvenance`, and `RelevantFileBudgetReport`.

**Interfaces:**

- `FileContextProvenance` is `{ kind: "PROJECT_FILE"; path; relativePath; score; reasons }`.
- `RelevantFileBudgetReport` is `{ maxTotalTokens; maxPerFileTokens; maxSelectedFiles; estimatedTokensUsed; remainingTokens; selectedFileCount }`.
- `RelevantFileContextPlan` is `{ query; rankedCandidates; sections; budget; discovery; diagnostics }` and is a runtime planning value, not a Protocol entity, storage row, event, message, or prompt.

- [ ] **Step 1: Add failing tests** asserting every selected section retains relative path, score, reasons, estimated tokens, bytes, and truncation state, and asserting no `relevantFiles` field is added to `ProjectIntelligenceSnapshot`.
- [ ] **Step 2: Run the focused plan test** and verify the structured plan API is absent.
- [ ] **Step 3: Implement immutable type-safe plan assembly without adding Protocol contracts.**
- [ ] **Step 4: Run the focused plan test** and confirm provenance and snapshot separation.
- [ ] **Step 5: Format and commit `feat(context): add relevant file planning`.**

### Task 7: Orchestrate the planner and local factory

**Files:**

- Create: `packages/context/src/relevant-file-planner.ts` — injected planner and local composition factory.
- Create: `packages/context/test/relevant-file-planner.test.ts` — orchestration, explicit-path, instruction-dedup, diagnostic, and determinism tests.
- Modify: `packages/context/src/index.ts` — export `RelevantFilePlanner` and `createLocalRelevantFilePlanner`.

**Interfaces:**

- `RelevantFilePlannerDependencies` requires `filesystem: ContextFileSystem`, with optional `estimator`, `policy`, `discovery`, and `ranker` implementations for tests/custom runtime composition.
- `RelevantFilePlanner.plan(input)` accepts `{ snapshot: ProjectIntelligenceSnapshot; query: RelevantFileQuery; budget?: RelevantFileBudget; discovery?: CandidateDiscoveryOptions }` and returns `Promise<RelevantFileContextPlan>`.
- `createLocalRelevantFilePlanner()` composes `LocalContextFileSystem`, default estimator, default ignore policy, discovery, ranker, and selector; no singleton is created.

- [ ] **Step 1: Add failing orchestration/E2E tests** using a real `ProjectInspector.inspect()` snapshot and fixture files for parser source/test, unrelated source, package manifest, `.gitignore`, nested ignore, `.env`, `.env.example`, hard-excluded trees, binary file, and instruction file.
- [ ] **Step 2: Run the focused planner test** and verify orchestration and factory APIs are missing.
- [ ] **Step 3: Implement planner composition.** Exclude all paths already present in `snapshot.instructions.entries`, exclude `.gitignore`, block explicit sensitive/outside/hard-ignored paths with diagnostics, preserve ordinary read diagnostics, and return deterministic ranked/selected output.
- [ ] **Step 4: Run the focused planner tests** and verify the top parser candidates, expected exclusions, budget bounds, sensitive explicit-path diagnostic, instruction deduplication, and repeatability.
- [ ] **Step 5: Format and commit `feat(context): add relevant file planning` if not already included in Task 6.

### Task 8: Run the full Phase 5B fixture and architecture guard suite

**Files:**

- Modify: `packages/context/test/architecture.test.ts` — extend source-import/forbidden-runtime/declaration guards for new modules and public declarations.
- Modify: `packages/context/test/public-api.test.ts` — assert approved exports and absence of internal matcher/Node types.
- Add focused coverage in the existing Task 1–7 test files rather than creating an unrelated catch-all test.

- [ ] **Step 1: Add failing architecture assertions** for zero `@caelush/llm`, AI SDK, network, child-process, storage/events/daemon/runtime/tools, `process.env`, and explicit `any` usage under `packages/context/src`; assert `dist/index.d.ts` does not leak `ignore`, `Dirent`, `Stats`, queues, or matcher internals.
- [ ] **Step 2: Run architecture/public API tests** and confirm the new guards fail until exports and source are correct.
- [ ] **Step 3: Implement only the minimal export/source changes needed to satisfy the guards.**
- [ ] **Step 4: Run `pnpm vitest run packages/context/test/architecture.test.ts packages/context/test/public-api.test.ts packages/context/test/ignore-policy.test.ts packages/context/test/file-discovery.test.ts packages/context/test/relevance.test.ts packages/context/test/token-estimator.test.ts packages/context/test/file-budget.test.ts packages/context/test/relevant-file-plan.test.ts packages/context/test/relevant-file-planner.test.ts`** and record files/tests/failures/skips.
- [ ] **Step 5: Commit `test(context): cover relevant context discovery boundaries`.**

### Task 9: Update architecture documentation and repository instructions

**Files:**

- Create: `docs/architecture/relevant-context-discovery.md` — Phase 5B data flow, boundaries, ignore policy, limits, ranking, estimator, budget, provenance, and explicit Phase 5C non-goals.
- Modify: `docs/architecture/context-and-project-intelligence.md` — cross-link and clarify 5A/5B separation.
- Modify: `README.md` — state that Caelush can discover, rank, and budget task-relevant project files, without claiming final model-context assembly.
- Modify: `AGENTS.md` — add the exact Phase 5B architectural guardrails from the brief.

- [ ] **Step 1: Add documentation assertions/checklist** to the docs review: include the required Mermaid/data-flow diagram, hard/sensitive/binary/symlink policy, `20000/5000/32/100` discovery limits, `12/12000/4000/128` file budget, `ceil(UTF-8 bytes/3)`, provider-independent caveat, and no LLM/compaction/ContextBuilder claim.
- [ ] **Step 2: Update the four documents** with terminology matching the exported types and actual behavior.
- [ ] **Step 3: Run Prettier checks on changed documentation/instruction files** and commit `docs: document phase 5b relevant context`.

### Task 10: Final verification, clean build, commits, and push

**Files:**

- No new production scope; only corrections discovered by verification are allowed.

- [ ] **Step 1: Run focused tests and record final counts.**
- [ ] **Step 2: Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` independently; each must exit 0.**
- [ ] **Step 3: Remove only confirmed generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` artifacts using Node filesystem operations if a clean build requires it; never use `git clean`.**
- [ ] **Step 4: Run `pnpm install --frozen-lockfile` and repeat lint/typecheck/test/build.**
- [ ] **Step 5: Run `git diff --check`, inspect `git diff --name-only 4f804fbd13545ba215b3948129344c284ed5ec1b...HEAD`, and run Prettier checks on every changed supported file; changed-file format failures must be zero.
- [ ] **Step 6: Run `pnpm format:check`; report the exact initial/final failure counts and prove no Phase 5B changed file is in the failing list.**
- [ ] **Step 7: Run `pnpm check`; report PASS only if exit 0, otherwise report that lint/typecheck/test/build passed and only the pre-existing format baseline remains.
- [ ] **Step 8: Review `git status --short` and `git diff`, commit any final verification-only corrections, and ensure the worktree is clean.
- [ ] **Step 9: Push without force using `git push -u origin codex/phase-5b-relevant-context-budget`, compare `git rev-parse HEAD` with `git ls-remote --heads origin refs/heads/codex/phase-5b-relevant-context-budget`, and include the remote branch URL in the completion report.
