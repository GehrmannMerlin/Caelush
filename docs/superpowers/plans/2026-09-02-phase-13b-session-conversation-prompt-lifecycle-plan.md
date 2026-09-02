# Phase 13B Session / Conversation / Prompt Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Session/Run/Prompt lifecycle to the Phase 13A Production Web Host without duplicating daemon authority or leaking internal transcript data.

**Architecture:** Extract browser-safe Session projection semantics into `@caelush/client`, keep Node-only path resolution in the CLI adapter, and place Web orchestration in a React-free `WebSessionManager` with `getSnapshot()`/`subscribe()`. React renders the manager projection and delegates user actions to it.

**Tech Stack:** TypeScript, React 19, Vite, `@caelush/client`, `@caelush/protocol`, Vitest, real Fastify daemon, SQLite, deterministic LLM provider.

**Spec:** `docs/superpowers/specs/2026-09-02-phase-13b-session-conversation-prompt-lifecycle-design.md`

## Global Constraints

- Browser uses the existing `@caelush/client`; it must not scatter direct `fetch()` calls or create a second transport layer.
- Daemon, Protocol, Run State Machine, Verification Completion Authority, and existing route semantics remain authoritative and unchanged.
- The browser must use the daemon-provided canonical `WorkspaceRef`; it must not call `realpath` or define a second workspace contract.
- The new Session draft is presentation-only and creates no durable Session until the first valid prompt.
- Prompt size is bounded by 32 KiB UTF-8 bytes; empty/whitespace prompts are rejected without side effects.
- `createRun()` must precede lifecycle observer startup, and observer readiness must precede `startRun()`.
- Only one active Run is allowed in the Web interaction model; multiple non-terminal Runs disable the composer and fail closed.
- History is Run-level presentation from `run.goal` and validated `VerifiedRunFinalResult`; raw Conversation, Tool messages, system prompts, hidden reasoning, and raw errors are not displayed.
- Phase 13B does not implement Agent Timeline, Tool cards, Approval, Cancellation, Reconnect, Recovery, Inspector, attachments, model management, or other Phase 13C–13E scope.

---

### Task 1: Extract browser-safe Session projection semantics

**Files:**

- Create: `packages/client/src/session-projection.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `apps/cli/src/application/session-resume.ts`
- Modify: `apps/cli/src/application/cli-state.ts`
- Test: `packages/client/test/session-projection.test.ts`
- Test: `apps/cli/test/session-resume.test.ts`

**Interfaces:**

- Produce `SessionCandidate`, `SessionHistoryEntry`, `SessionCandidateClient`, `MAX_SESSION_CANDIDATES`, `SESSION_ENRICH_CONCURRENCY`.
- Produce `normalizeWorkspacePath(value: string): string` with slash/trailing-slash/case normalization only; it must not import Node APIs.
- Produce `deriveSessionActivity`, `sortSessionCandidates`, `listMatchingSessionCandidates`, `resolveSessionWorkspace`, `hydrateSessionTranscript`, and `nonTerminalRuns`.
- Preserve the CLI-facing `normalizeWorkspacePath` behavior by resolving relative paths in the CLI adapter before calling the shared normalizer.

- [ ] **Step 1: Write failing shared projection tests**

  Port the existing CLI policy cases to `packages/client/test/session-projection.test.ts`: deterministic activity/ID sorting, Windows slash/case comparison, current-workspace filtering with at most eight concurrent `listRuns` calls, one-workspace legacy resolution, Run-level history for user goals/verified final results/terminal markers, and non-terminal statuses.

- [ ] **Step 2: Run the shared test to verify it fails**

  Run `pnpm exec vitest run packages/client/test/session-projection.test.ts`.

  Expected: FAIL because the shared module and exports do not exist.

- [ ] **Step 3: Implement the narrow shared module**

  Move the React-free, Ink-free logic from `apps/cli/src/application/session-resume.ts` into the client package. Replace its Node `resolve()` use with a browser-safe normalizer that assumes daemon/client workspace paths are absolute canonical values. Keep `VerifiedRunFinalResultSchema` validation and the existing safe terminal markers.

- [ ] **Step 4: Run shared and CLI policy tests**

  Run `pnpm exec vitest run packages/client/test/session-projection.test.ts apps/cli/test/session-resume.test.ts`.

  Expected: PASS with the existing CLI semantics preserved.

- [ ] **Step 5: Export public client projection symbols**

  Export only the narrow projection functions/types from `packages/client/src/index.ts`; keep provider/transport internals unchanged.

- [ ] **Step 6: Run package typecheck**

  Run `pnpm --filter @caelush/client typecheck`.

  Expected: PASS with no Node-only dependency in the client bundle.

### Task 2: Build the React-free Web Session Manager

**Files:**

- Create: `apps/web/src/application/session-manager.ts`
- Create: `apps/web/src/application/prompt.ts`
- Modify: `apps/web/src/host/bootstrap.ts`
- Test: `apps/web/test/session-manager.test.ts`
- Test: `apps/web/test/prompt.test.ts`

**Interfaces:**

- `WebSessionManager` accepts a client implementing the existing client Session/Run methods, a canonical `WorkspaceRef`, and `DaemonInfo`.
- `WebSessionSnapshot` contains Session candidates, selected Session, visible Runs, Run-level history, active Run summary, local draft state, submission state, and safe error.
- `getSnapshot(): WebSessionSnapshot`, `subscribe(listener): () => void`, `loadSessions(): Promise<void>`, `beginDraft(): void`, `selectSession(sessionId): Promise<boolean>`, `submitPrompt(prompt): Promise<boolean>`, and `dispose(): void`.
- `validatePrompt(value): { ok: true; value: string } | { ok: false; error: SafeWebError }` trims input and enforces the 32 KiB UTF-8 bound.

- [ ] **Step 1: Write failing prompt tests**

  Cover whitespace rejection, Unicode/emoji byte accounting, multiline preservation, exactly 32 KiB acceptance, and over-limit rejection without client calls.

- [ ] **Step 2: Run prompt tests to verify failure**

  Run `pnpm exec vitest run apps/web/test/prompt.test.ts`.

  Expected: FAIL because the prompt module does not exist.

- [ ] **Step 3: Implement prompt validation**

  Use `TextEncoder().encode(value).byteLength`, trim only for admission, and return fixed safe presentation errors.

- [ ] **Step 4: Run prompt tests to verify green**

  Run `pnpm exec vitest run apps/web/test/prompt.test.ts`.

  Expected: PASS.

- [ ] **Step 5: Write failing Session Manager tests**

  Cover real projection of filtered Sessions, selected Session stability, empty state, local draft, Session creation on first submit, default model/config inheritance, create failure retaining no fake history, one active Run guard, multiple non-terminal Run fail-closed state, and safe stream/getRun failure.

- [ ] **Step 6: Run Session Manager tests to verify failure**

  Run `pnpm exec vitest run apps/web/test/session-manager.test.ts`.

  Expected: FAIL because `WebSessionManager` does not exist.

- [ ] **Step 7: Implement Session loading and selection**

  Use `listMatchingSessionCandidates(client, workspace.path)` for bounded filtering/enrichment. On selection, call `listRuns(session.id, { limit: 100 })`, resolve the Session workspace, hydrate Run-level history, derive non-terminal Runs, and disable composition when one or multiple active Runs are present.

- [ ] **Step 8: Implement lazy draft admission**

  Keep `beginDraft()` local. On the first valid prompt, require `session.defaultModel ?? info.defaultModel`; call `createSession({ title, defaultWorkspace: workspace, defaultModel, metadata: {} })`, then continue with the returned durable Session. Bound the title from the first prompt line without an LLM call.

- [ ] **Step 9: Implement real Run submission and observer ordering**

  Call `createRun(session.id, { goal, workspace, model, ...info.defaultRunConfiguration })`; attach `watchRunEvents(run.id)` and wait for its `onOpen` readiness; only then call `startRun(run.id)`. Set local submission states without adding them to Protocol `RunStatus`.

- [ ] **Step 10: Implement lifecycle refresh and completion projection**

  Consume only lifecycle event types. After lifecycle events, refresh through `getRun(run.id)`. On terminal status, reload the Session Runs, clear the active Run, hydrate history from `run.goal` plus `VerifiedRunFinalResultSchema`, and re-enable the composer only when no non-terminal Run remains. A completed Run with invalid finalResult receives a safe terminal marker.

- [ ] **Step 11: Run Session Manager tests to verify green**

  Run `pnpm exec vitest run apps/web/test/session-manager.test.ts apps/web/test/prompt.test.ts`.

  Expected: PASS, with calls ordered `createRun → watch/onOpen → startRun`.

### Task 3: Render the real Session/Run Web surface

**Files:**

- Create: `apps/web/src/components/session-sidebar.ts`
- Create: `apps/web/src/components/session-workspace.ts`
- Create: `apps/web/src/components/prompt-composer.ts`
- Modify: `apps/web/src/app.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/app.test.ts`

**Interfaces:**

- Components receive snapshots and callbacks from `WebSessionManager`; they do not call `CaelushClient` directly.
- Sidebar renders only real candidates and local New Session draft.
- Workspace renders safe Run-level history, one current status, and the composer.
- Composer emits text submit and preserves text when admission fails; Enter submits and Shift+Enter inserts a newline.

- [ ] **Step 1: Write failing presentation tests**

  Verify real session titles use `latestRun.goal → session.title → 新会话`, current-workspace candidates render, New Session calls `beginDraft`, terminal labels are safe, valid verified final text renders, invalid completed results do not render as answers, and active/multiple-active snapshots disable submission/session switching.

- [ ] **Step 2: Run presentation tests to verify failure**

  Run `pnpm exec vitest run apps/web/test/app.test.ts`.

  Expected: FAIL because the Session/Run presentation does not exist.

- [ ] **Step 3: Implement the minimal layout**

  Replace the Phase 13A placeholder content with top bar + Session sidebar + main workspace. Keep connection/health/info from the 13A bootstrap state. Use `useSyncExternalStore` or an equivalent subscription adapter; do not put orchestration in components.

- [ ] **Step 4: Implement prompt keyboard behavior**

  Use a controlled textarea. Submit on Enter without Shift, insert newline on Shift+Enter, disable while submission/active/multiple-active, show byte count/error only as local presentation state, and do not add attachments or commands.

- [ ] **Step 5: Run presentation tests to verify green**

  Run `pnpm exec vitest run apps/web/test/app.test.ts apps/web/test/session-manager.test.ts apps/web/test/prompt.test.ts`.

  Expected: PASS with no Session/Run/Timeline mock data.

### Task 4: Add real daemon lifecycle integration and browser smoke

**Files:**

- Create: `tests/integration/web-session-lifecycle.test.ts`
- Create: `scripts/web-session-browser-smoke.mjs` only if the existing Playwright command cannot express the smoke without a reusable script.
- Test: `tests/integration/web-session-lifecycle.test.ts`

**Interfaces:**

- Integration uses the real daemon composition, SQLite storage, `@caelush/client`, and a deterministic no-tool LLM provider that reaches Verification and Completion.
- The test may import application source only from test code; no production app-to-app dependency is introduced.

- [ ] **Step 1: Write the failing real lifecycle integration test**

  Start a real daemon with a temporary SQLite path and deterministic fixture provider. Construct `WebSessionManager` over `CaelushClient`, load an empty workspace, submit one goal, wait for the snapshot to become terminal, and assert `COMPLETED` plus exact verified result text.

- [ ] **Step 2: Run integration test to verify failure**

  Run `pnpm exec vitest run tests/integration/web-session-lifecycle.test.ts`.

  Expected: FAIL because the Web Session Manager and lifecycle path are not implemented.

- [ ] **Step 3: Implement only test fixture wiring**

  Reuse the existing daemon fixture-provider pattern. The provider emits one final candidate and a verification PASS; do not add Tool, Approval, or new daemon routes.

- [ ] **Step 4: Run real integration test to verify green**

  Run `pnpm exec vitest run tests/integration/web-session-lifecycle.test.ts`.

  Expected: PASS with one real Session, one real Run, and one validated `VERIFIED_COMPLETION` result.

- [ ] **Step 5: Run a production Web browser smoke**

  Build `apps/web`, start a real daemon with the built static host and deterministic provider, navigate Playwright to `/`, create a draft Session, enter a bounded prompt, click Run, and wait for the verified final result. Record the command and result without committing screenshots or generated release output.

### Task 5: Regression, release, and delivery

**Files:**

- Modify: only files required by focused-test findings; no unrelated formatting sweep.

- [ ] **Step 1: Run focused package/app tests**

  Run `pnpm exec vitest run packages/client/test/session-projection.test.ts apps/cli/test/session-resume.test.ts apps/web/test tests/integration/web-session-lifecycle.test.ts`.

- [ ] **Step 2: Run static checks**

  Run `pnpm lint`, `pnpm typecheck`, and `pnpm exec prettier --check` on every changed file. Run repository `pnpm format:check` and record the known 830-file historical debt without formatting unrelated files.

- [ ] **Step 3: Run full tests and builds**

  Run `pnpm test`, `pnpm build`, `pnpm build:release`, and `pnpm test:release`. Remove only generated release artifacts after verification.

- [ ] **Step 4: Audit scope and security**

  Confirm no `mockSessions`, `mockRuns`, `mockEvents`, `fakeTimeline`, `demoApprovals`, or fake result data exists in Web production source; confirm no new Protocol/API/daemon security boundary; confirm no raw Conversation, Tool args, hidden reasoning, environment, or credentials enter the browser.

- [ ] **Step 5: Commit the implementation**

  ```bash
  git status --short
  git diff --check
  git add -A
  git commit -m "feat(web): add session and run interaction lifecycle"
  ```

- [ ] **Step 6: Push and verify the remote seal**

  ```bash
  git push -u origin codex/phase-13b-session-conversation-prompt-lifecycle
  LOCAL_SHA=$(git rev-parse HEAD)
  REMOTE_SHA=$(git ls-remote --heads origin refs/heads/codex/phase-13b-session-conversation-prompt-lifecycle | awk '{print $1}')
  test "$LOCAL_SHA" = "$REMOTE_SHA"
  ```

  Expected: `LOCAL_SHA == REMOTE_SHA`.
