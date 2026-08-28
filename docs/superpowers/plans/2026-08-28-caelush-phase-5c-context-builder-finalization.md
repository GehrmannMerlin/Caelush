# Caelush Phase 5C — ContextBuilder & Phase 5 Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-independent, deterministic `ContextBuilder` that turns Phase 5A project intelligence, Phase 5B relevant-file sections, complete recent conversation turns, a base system prompt, and caller-supplied input limits into a budgeted `BuiltModelContext` containing valid `LLMMessage[]`.

**Architecture:** Reuse the existing `packages/llm/src/messages.ts` contract through the narrow `@caelush/llm/messages` export; never import the LLM runtime or provider adapters. Keep rendering, conversation validation/selection, budget accounting, and orchestration in focused modules. `ContextBuilder` is synchronous and consumes only already-materialized runtime values, so it performs no filesystem, network, process, storage, event, tool, model, or provider work.

**Tech Stack:** TypeScript ESM, Node 24, Vitest, existing `ProjectIntelligenceSnapshot`, `RelevantFileContextPlan`, `Utf8HeuristicTokenEstimator`, `LLMMessageSchema`, `LLMUserMessageSchema`, and `LLMRequestSchema`; no new external production dependency.

**Spec:** User-provided Phase 5C brief at `C:/Users/韩吉衍/.codex/attachments/e7d12552-982c-4ea0-b1a1-61a45d4eb977/pasted-text.txt`.

## Global Constraints

- Phase 5 contains exactly 5A, 5B, and 5C; this completes 5C and must not implement Phase 6 `AgentLoop`.
- The implementation starts from `origin/codex/phase-5b-relevant-context-budget` at the actual fetched SHA and lives on `codex/phase-5c-context-builder-finalization`.
- `ProjectIntelligenceSnapshot` and `RelevantFileContextPlan` remain separate runtime concepts; neither gains messages, conversation, model, provider, or final-prompt fields.
- `@caelush/context` may import only `@caelush/llm/messages`; it must not import `@caelush/llm` root, any other LLM subpath, providers, `ai`, or `@ai-sdk/*`.
- `ContextBuilder` is pure in-memory composition. It must not use `ContextFileSystem`, filesystem I/O, network, `process.env`, child processes, Runtime, Tools, Storage, EventBus, Gateway, model selection, or AgentEvents.
- The final message order is one generated system message, selected structured history, one optional synthetic user file-reference message, and the exact current user message last.
- System context order is base system prompt (when non-empty), context policy, runtime facts, project metadata, then project instructions. Project metadata and relevant file contents are explicitly labeled reference data; only discovered project instructions are project-level instructions.
- History must pass runtime schema validation, reject system messages, preserve structured message values, and reject orphan, duplicate, missing, or wrong-name tool results while allowing parallel tool results in either order.
- History selection keeps a newest contiguous suffix of complete user-led turns, never splits a turn, drops no message inside a selected turn, and reports `requiresCompaction` without invoking an LLM or producing a summary.
- `maxInputTokens` is required and means the caller-supplied model-input planning budget after external reserves. Default optional limits are safety margin 512, conversation cap 12000, relevant-file cap 12000, and minimum useful file tokens 128.
- Mandatory system/current-user context is never silently trimmed; mandatory overflow throws `ContextBudgetExceededError` with aggregate structured breakdown and no raw prompt content.
- Optional allocation uses integer 40% conversation / 60% relevant files, applies caps, transfers unused capacity in one spillover pass, and performs a final hard rendered-message estimate check.
- Relevant-file selection consumes `RelevantFileContextPlan.sections` in order, does not re-plan/re-score/re-read, uses provenance relative paths, counts rendered overhead, and carries both 5B `truncated` and 5C `furtherTruncated` into the final `truncated` marker.
- Existing repository-wide formatting debt is preserved. Every Phase 5C changed supported file must pass Prettier; final `pnpm check` may only retain the measured pre-existing format baseline if it remains unchanged.
- Before completion run fresh `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, `pnpm check`, `git diff --check`, declaration/static audits, and remote SHA verification after a non-force push.

## File Map

- `packages/llm/package.json`: expose the existing message module as `./messages` without copying its implementation.
- `packages/llm/test/messages-subpath.test.ts`: prove the subpath exports the same provider-independent schemas/types and excludes runtime/provider surface.
- `packages/context/package.json`: add only `@caelush/llm: workspace:*`.
- `packages/context/src/context-build-report.ts`: public budget, conversation, relevant-file, source, and final provenance report types.
- `packages/context/src/context-text.ts`: private deterministic path normalization, XML attribute escaping, CDATA-safe splitting, and bounded text fitting helpers.
- `packages/context/src/context-renderer.ts`: private system and synthetic user file-reference renderers, with no I/O.
- `packages/context/src/conversation-history.ts`: private schema validation, tool lifecycle integrity, turn grouping, contiguous suffix selection, and estimation helpers.
- `packages/context/src/context-budget.ts`: private limit validation, mandatory/optional allocation, file fit, spillover, hard-budget checks, and metadata assembly.
- `packages/context/src/context-builder.ts`: public `ContextBuilder`, input/output contracts, injected estimator orchestration, and local factory.
- `packages/context/src/errors.ts`: add only `ContextBuildError`, `ContextBudgetExceededError`, and `ContextConversationError` with stable codes.
- `packages/context/src/index.ts`: export the approved public ContextBuilder/API/error/report types and keep renderer/history/budget helpers private.
- `packages/context/test/*.test.ts`: focused red-green tests for each boundary plus final E2E and architecture guards.
- `tests/architecture/package-boundaries.test.ts`, `packages/context/test/architecture.test.ts`, and `packages/context/test/public-api.test.ts`: exact subpath dependency and SDK/declaration/public-surface checks.
- `docs/architecture/context-builder.md`, `docs/architecture/context-and-project-intelligence.md`, `docs/architecture/relevant-context-discovery.md`, `README.md`, and `AGENTS.md`: finalize Phase 5 and document the exact boundaries without claiming autonomous execution or prompt-injection elimination.

### Task 1: Expose the narrow provider-independent message boundary

**Files:**

- Modify: `packages/llm/package.json` — add the `"./messages"` export pointing to `dist/messages.js` and `dist/messages.d.ts`.
- Create: `packages/llm/test/messages-subpath.test.ts` — import the subpath and verify schema identity/behavior and absence of runtime names.
- Modify: `tests/architecture/package-boundaries.test.ts` — allow exactly `@caelush/llm/messages` for Context while continuing to reject root/provider/SDK imports.

**Interfaces:**

- Produces the existing `LLMMessage`, `LLMSystemMessage`, `LLMUserMessage`, `LLMAssistantMessage`, `LLMToolResultMessage`, `LLMMessageSchema`, `LLMUserMessageSchema`, and necessary assistant/tool schemas through `@caelush/llm/messages` only.

- [ ] **Step 1: Write the failing test** that resolves `@caelush/llm/messages`, parses a system/user/tool-rich message, and asserts the subpath does not expose `LLMGateway` or provider factories.
- [ ] **Step 2: Run `pnpm vitest run packages/llm/test/messages-subpath.test.ts`** and confirm it fails because the subpath export is missing.
- [ ] **Step 3: Add the export map entry without changing `packages/llm/src/messages.ts` or duplicating any contract.**
- [ ] **Step 4: Run the focused test and `pnpm --filter @caelush/llm build`; confirm it passes and emits only provider-independent declarations.
- [ ] **Step 5: Run Prettier on changed files and commit `feat(llm): expose provider-independent message contracts`.

### Task 2: Define ContextBuilder errors, limits, reports, and public input/output contracts

**Files:**

- Modify: `packages/context/package.json` — add `@caelush/llm: workspace:*`.
- Modify: `packages/context/src/errors.ts` — add the three minimal build/conversation/budget error classes.
- Create: `packages/context/src/context-build-report.ts` — define report metadata types with no raw content fields.
- Create: `packages/context/src/context-builder.ts` — define `ContextBuildInput`, `ContextBuildLimits`, `BuiltModelContext`, `ContextBuilderOptions`, and the public class/factory signatures.
- Modify: `packages/context/src/index.ts` — export only approved public types/classes/errors.
- Create: `packages/context/test/context-contracts.test.ts` — validate required/optional limits, error codes, report shape, and public compile-time/runtime surface.

**Interfaces:**

- `ContextBuildInput = { baseSystemPrompt: string; snapshot: ProjectIntelligenceSnapshot; relevantFiles?: RelevantFileContextPlan; history?: readonly LLMMessage[]; currentUserMessage: LLMUserMessage; limits: ContextBuildLimits }`.
- `ContextBuildLimits = { maxInputTokens: number; safetyMarginTokens?: number; maxConversationTokens?: number; maxRelevantFileTokens?: number; minRelevantFileTokens?: number }`.
- `BuiltModelContext = { messages: readonly LLMMessage[]; report: ContextBuildReport }`.
- `ContextBuilderOptions = { tokenEstimator?: TokenEstimator }`; `createDefaultContextBuilder()` injects `Utf8HeuristicTokenEstimator` and no filesystem.
- Reports include limits, `estimatedInputTokens`, `remainingTokens`, system/current-user estimates, conversation metadata, relevant-file metadata, `snapshotDiagnosticCount`, and system source counts/provenance without raw user/file/instruction text.

- [ ] **Step 1: Write failing contract tests** for missing/non-positive `maxInputTokens`, optional zero caps, invalid safety margin/minimum file values, error codes, and public type names.
- [ ] **Step 2: Run `pnpm vitest run packages/context/test/context-contracts.test.ts`** and verify missing APIs fail for the expected reason.
- [ ] **Step 3: Implement contracts and strict limit validation only; do not add rendering or selection behavior yet.**
- [ ] **Step 4: Run the focused contract tests and package typecheck; confirm all validations pass.
- [ ] **Step 5: Format changed files and commit `feat(context): define context build contracts`.

### Task 3: Implement deterministic system and file-context rendering

**Files:**

- Create: `packages/context/src/context-text.ts` — implement `/` path normalization, XML attribute escaping for `&\"<>`, CDATA split for `]]>`, and deterministic token-safe text fitting.
- Create: `packages/context/src/context-renderer.ts` — render the policy/runtime facts/metadata/scripts/instructions system content and optional synthetic file-reference user message.
- Create: `packages/context/test/context-renderer.test.ts` — cover section order, escaping, instruction provenance, package script priority/limits, path normalization, and privilege labeling.

**Interfaces:**

- Internal renderer consumes only `ProjectIntelligenceSnapshot`, selected `RelevantFileContextSection[]`, base prompt, and current budget helper values; it returns `LLMSystemMessage`/`LLMUserMessage` fragments plus source metadata.
- System section order is base prompt if non-empty, policy, runtime facts (`workspaceRoot`, `projectRoot`, `cwd`, `platform`, `arch`, Node version), project metadata (`project_metadata`, ecosystems, language signals, package manager/version hint, monorepo, root/active package, tooling), and structured `project_instructions` in existing root-to-cwd order.
- Only the allowlisted scripts `build`, `test`, `lint`, `typecheck`, `check`, `dev`, `start` render, in that order per root/active package, with command content bounded to 512 UTF-8 bytes and a truncation marker.
- Relevant file context is a synthetic `user` message only when selected sections are non-empty; it includes policy text, relative path, `truncated=true/false`, and CDATA-safe content, never score/reasons/absolute paths or the complete plan.

- [ ] **Step 1: Write failing tests** for deterministic system output, base-prompt omission, Windows paths, package metadata/scripts, root-before-nested instruction order, CDATA/attribute edge cases, and file content labeled as reference data rather than instructions.
- [ ] **Step 2: Run the renderer test and confirm failures are caused by absent renderer behavior.
- [ ] **Step 3: Implement the private renderers using only structured inputs; use `Buffer.byteLength` and the existing estimator boundary, never current time/locale/randomness.
- [ ] **Step 4: Run focused renderer tests and repeat each build ten times to verify deep-equal messages/source metadata.
- [ ] **Step 5: Format and commit `feat(context): render model-facing project context`.

### Task 4: Validate conversation messages, tool integrity, and turn grouping

**Files:**

- Create: `packages/context/src/conversation-history.ts` — runtime schema validation, system rejection, tool-call/result matching, duplicate/missing/orphan detection, and internal `ConversationTurnGroup` creation.
- Create: `packages/context/test/conversation-history.test.ts` — valid/invalid structured histories and tool-rich estimates.
- Modify: `packages/context/src/errors.ts` only if a stable detail field is needed; do not expose raw Zod errors/content.

**Interfaces:**

- Internal validation accepts `readonly LLMMessage[]` and returns the original message references grouped by turns; every message is parsed with `LLMMessageSchema.safeParse()`.
- Reject history system messages, malformed runtime values, initial orphan tool results, wrong tool names, duplicate tool results, and assistant tool calls lacking a later matching tool result. Allow parallel calls/results and reversed result order by `toolCallId`.
- A new `user` starts a group; leading assistant continuation is allowed; assistant/tool messages remain in the group until the next user. Selected history is never converted to plain text or rewritten.

- [ ] **Step 1: Write failing tests** for user/assistant history, assistant tool call/result, parallel reversed results, orphan/wrong-name/duplicate/missing result, system-in-history, malformed runtime message, leading assistant, and tool-rich token estimation.
- [ ] **Step 2: Run `pnpm vitest run packages/context/test/conversation-history.test.ts`** and verify expected missing/invalid behavior.
- [ ] **Step 3: Implement validation and internal grouping with sanitized `ContextConversationError` messages and deterministic issue metadata.
- [ ] **Step 4: Run the focused test and confirm all valid/invalid cases pass without raw schema error leakage.
- [ ] **Step 5: Format and commit `feat(context): validate structured conversation history`.

### Task 5: Select newest complete conversation suffix and report compaction boundary

**Files:**

- Modify: `packages/context/src/conversation-history.ts` — add newest-suffix selection against a conversation token cap.
- Create: `packages/context/test/conversation-selection.test.ts` — all-fit, oldest-drop, multi-drop, unsplittable latest-turn, zero-cap, and no-summary tests.

**Interfaces:**

- `selectRecentConversation(groups, maxConversationTokens, estimator)` returns selected original messages, provided/selected/dropped message and turn counts, estimated used tokens, `requiresCompaction`, and `latestTurnTooLarge`.
- Start from the newest complete group and prepend whole groups while each complete group fits; if the newest group alone is too large, select none and set `latestTurnTooLarge=true`. `requiresCompaction` is true whenever any complete turn is dropped; no LLM or summary is involved.

- [ ] **Step 1: Write failing selection tests** proving contiguous suffix order, no split turns, latest-too-large behavior, dropped counts, and `requiresCompaction`.
- [ ] **Step 2: Run the focused selection test and confirm the selector is absent.
- [ ] **Step 3: Implement greedy reverse-group selection with integer-safe counts and original message preservation.
- [ ] **Step 4: Run focused conversation validation plus selection tests; confirm no summary prompt/import/call exists.
- [ ] **Step 5: Format and commit `feat(context): select complete recent conversation turns`.

### Task 6: Implement final relevant-file fit and two-pass optional budget allocation

**Files:**

- Create: `packages/context/src/context-budget.ts` — mandatory estimate/overflow, 40/60 allocation, cap/spillover, rendered file fit, further truncation, final hard-check degradation, and report helpers.
- Modify: `packages/context/src/context-text.ts` — reuse/centralize safe line/UTF-8 prefix fitting for Phase 5C without changing Phase 5B semantics.
- Create: `packages/context/test/context-budget.test.ts` — mandatory overflow, ratios/caps/spillover, file fit/truncation thresholds, overhead, and final invariant.

**Interfaces:**

- The allocator consumes rendered system/current-user fragments, selected history groups, ordered `RelevantFileContextSection[]`, limits, and estimator; it returns final structured messages plus metadata.
- Mandatory tokens include the actual rendered system message and exact current user message. The optional budget is `maxInputTokens - safetyMarginTokens - mandatoryTokens`; conversation target is `floor(optionalBudget * 2 / 5)`, file target is the remainder, then caps apply.
- Pass 2 transfers unused capacity from one source to the other once. File fit uses actual synthetic-message rendering overhead, includes whole files first, further-truncates only the final in-memory section if remaining is at least `minRelevantFileTokens`, and drops later/last files when it cannot fit. Hard-check degradation drops last relevant file, then oldest selected turn, repeatedly; mandatory overflow remains fatal.

- [ ] **Step 1: Write failing tests** for exact mandatory fit, safety margin, mandatory overflow breakdown, 40/60 integer allocation, both caps, each spillover direction, whole/tail/further-truncated files, min threshold, 5B truncation propagation, overhead, and optional-all-dropped hard overflow.
- [ ] **Step 2: Run `pnpm vitest run packages/context/test/context-budget.test.ts`** and verify the allocator is absent.
- [ ] **Step 3: Implement the smallest deterministic allocator using the shared estimator and memory-only file content; do not re-plan or read files.
- [ ] **Step 4: Run focused budget, renderer, and conversation tests; verify every final output obeys `estimatedInputTokens + safetyMarginTokens <= maxInputTokens` unless a typed mandatory overflow is thrown.
- [ ] **Step 5: Format and commit `feat(context): allocate final model context budget`.

### Task 7: Orchestrate ContextBuilder and prove LLMRequest readiness

**Files:**

- Modify: `packages/context/src/context-builder.ts` — wire validation, rendering, selection, allocation, report, and exact final-user preservation.
- Create: `packages/context/test/context-builder.test.ts` — message-order/no-history/no-files/current-user/determinism/no-I/O/factory tests.
- Create: `packages/context/test/context-e2e.test.ts` — real temp project `ProjectInspector.inspect()` → `RelevantFilePlanner.plan()` → `ContextBuilder.build()` → `LLMRequestSchema.parse()` flow without Gateway.

**Interfaces:**

- `new ContextBuilder({ tokenEstimator })` is synchronous and has no filesystem parameter; `createDefaultContextBuilder()` is local and injects only the default estimator.
- `build(input)` validates current user with `LLMUserMessageSchema`, validates history at runtime, builds exactly one system message, preserves history structures, adds at most one file reference message, puts the exact current user last, and returns `BuiltModelContext`.
- The E2E fixture contains root/nested `AGENTS.md`, `package.json`, `pnpm-workspace.yaml`, `packages/app/package.json`, `parser.ts`, and `parser.test.ts`; query `Fix parser behavior` must preserve planner section order and produce an LLMRequest-schema-valid message array.

- [ ] **Step 1: Write failing builder/E2E tests** for every allowed message shape, exact current user string, final order, no empty file message, no system history, report fields, deterministic repeated builds, constructor no-I/O boundary, and `LLMRequestSchema.parse({ model, messages: built.messages })`.
- [ ] **Step 2: Run the focused builder/E2E tests and confirm missing orchestration fails.
- [ ] **Step 3: Implement orchestration with no asynchronous APIs, no hidden rescans, no provider/model fields, and sanitized report construction.
- [ ] **Step 4: Run focused builder/E2E tests and verify no Gateway/provider call occurs.
- [ ] **Step 5: Format and commit `feat(context): add context builder`.

### Task 8: Complete architecture/public API guards and declaration audits

**Files:**

- Modify: `packages/context/test/architecture.test.ts` — permit only the messages subpath and reject root/other LLM/SDK/network/process/storage/event/tool/runtime imports, `process.env`, explicit `any`, and leaked Node implementation types.
- Modify: `packages/context/test/public-api.test.ts` — assert approved exports and internal helper absence.
- Modify: `packages/llm/test/architecture-sdk-isolation.test.ts` or add a focused declaration test — assert `packages/llm/dist/messages.d.ts` is provider-independent.
- Modify: `tests/architecture/package-boundaries.test.ts` — assert `context → protocol`, `context → llm/messages`, and no other LLM edge.

- [ ] **Step 1: Add failing exact architecture/declaration tests** before source/export adjustments.
- [ ] **Step 2: Run focused architecture/public API tests and inspect the expected failures.
- [ ] **Step 3: Implement only required export/guard corrections; keep `ConversationTurnGroup`, renderer helpers, CDATA helpers, allocator state, and fragments private.
- [ ] **Step 4: Run all context-focused tests and inspect `packages/context/dist/index.d.ts` and `packages/llm/dist/messages.d.ts` for forbidden names.
- [ ] **Step 5: Format and commit `test(context): cover model-context assembly boundaries`.

### Task 9: Finalize Phase 5 documentation and repository instructions

**Files:**

- Create: `docs/architecture/context-builder.md` — exact data-flow diagram, message order, privilege layers, rendering safety, budget algorithm, overflow/compaction boundary, and Phase 5 stop at `BuiltModelContext`.
- Modify: `docs/architecture/context-and-project-intelligence.md` — link 5A/5B/5C boundaries and preserve Inspector/Snapshot responsibilities.
- Modify: `docs/architecture/relevant-context-discovery.md` — link final file fit into ContextBuilder without moving planning responsibilities.
- Modify: `AGENTS.md` — add the exact Phase 5 completion and ContextBuilder architecture rules from the brief.
- Modify: `README.md` — mark Phase 5A/5B/5C complete and describe only provider-independent budgeted message-context construction, not autonomous execution.

- [ ] **Step 1: Write a documentation checklist** covering the required diagram, order, privilege labels, no prompt-injection guarantee claim, 40/60/two-pass budget, mandatory overflow, history compaction flag/no summary, caller-supplied `maxInputTokens`, UTF-8 bytes/3 heuristic, and Phase 6 as the next work.
- [ ] **Step 2: Update the five documents to match the actual public types and implementation.
- [ ] **Step 3: Run Prettier checks on every changed documentation/instruction file; fix only Phase 5C files and commit `docs: finalize phase 5 context architecture`.

### Task 10: Full verification, clean build, commit audit, and push

**Files:**

- No new production scope. Only corrections required by fresh verification are allowed.

- [ ] **Step 1: Run focused tests and record exact files/tests/failures/skips plus TDD RED→GREEN evidence for subpath, tool integrity, mandatory overflow, file fit, and E2E (or honestly label any characterization test that initially passes).
- [ ] **Step 2: Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` independently; each must exit 0.
- [ ] **Step 3: Remove only generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` via a bounded Node filesystem script if needed; never use `git clean`, reset, or force checkout.
- [ ] **Step 4: Run `pnpm install --frozen-lockfile`, then repeat lint/typecheck/test/build independently and retain outputs.
- [ ] **Step 5: Run `pnpm format:check`; compare final failure count and paths with the measured baseline of 276, and run Prettier checks on every changed supported file with zero Phase 5C failures.
- [ ] **Step 6: Run `pnpm check`; report PASS only if exit 0, otherwise state explicitly that only the unchanged pre-existing format baseline causes failure.
- [ ] **Step 7: Run `git diff --check`, static architecture audits, public declaration audits, and `git status --short`/`git diff`; commit any final verification-only corrections after re-running affected tests.
- [ ] **Step 8: Ensure the worktree is clean, push with `git push -u origin codex/phase-5c-context-builder-finalization`, and compare `git rev-parse HEAD` with `git ls-remote --heads origin refs/heads/codex/phase-5c-context-builder-finalization`.
- [ ] **Step 9: Produce the required `Caelush Phase 5C / Phase 5 Final Completion Report` with origin/master SHA, origin Phase 5B SHA, BASE_REF/BASE_SHA, branch/worktree, baseline counts, architecture/data-flow/contracts/budget/test/TDD/verification/commit/push evidence, remote URL, clean status, current capabilities, explicit non-goals, Phase 5 COMPLETED, and Phase 6 as the next phase.
