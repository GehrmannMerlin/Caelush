# Phase 13E Production UX, Browser E2E & Release Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Phase 13E Production Web UX, real browser E2E coverage, and release integration without changing the existing daemon-backed business model.

**Architecture:** Keep `WebSessionManager` as the presentation orchestration boundary and keep React components presentational. Refine the existing two-column Web surface, add a focused timeline scroll controller at the Web boundary, and verify the same client/daemon/SQLite/AgentLoop/Tool/Security/Verification path in browser and release tests.

**Tech Stack:** TypeScript 6, React 19, Vite 8, existing CSS, Vitest 4, Node release scripts, Playwright Chromium only if no existing browser harness can cover the required scenarios.

**Spec:** `docs/superpowers/specs/2026-09-03-phase-13e-production-ux-design.md`

## Global Constraints

- Phase 13E is the final Phase 13 round; do not add Phase 13E-1, Phase 13E-2, Phase 13E-extra, or Phase 13F.
- Preserve the approved Two-column layout: Top Bar + Session Sidebar + Main Agent Workspace + Composer.
- Session Row visible content is exactly status icon + title; status text is accessible metadata only.
- Do not add Right Inspector, Bottom Status Bar, Terminal, stdout/stderr, Diff Viewer, Context Inspector, Usage, Settings, MCP, RAG, Attachments, File Browser, or other unsupported UI.
- UI must remain driven by `WebSessionManager`, `@caelush/client`, real daemon APIs, and real `TimelineState`/`VerifiedRunFinalResult`; no mock product data.
- Do not modify Protocol, Core, Security, Runtime, Verification, Storage, Tool, EventBus, or daemon business APIs for UI convenience.
- Use existing React/CSS architecture; do not migrate to Tailwind or add a component framework.
- New browser E2E must use one Playwright system and Chromium only; deterministic provider HTTP fixtures may stand in for a remote model, but daemon/SSE/SQLite/AgentLoop/Tool/Security/Verification remain real.
- Run changed-file Prettier, lint, typecheck, tests, build, browser E2E, `build:release`, `test:release`, and `git diff --check` before claiming completion.

---

### Task 1: Baseline and verification debt cleanup

**Files:**
- Modify: `apps/web/test/approval-control.test.ts`
- Modify: `apps/web/test/cancellation-control.test.ts`
- Modify: `apps/web/test/reconnect.test.ts`
- Modify: `apps/web/test/recovery.test.ts`
- Modify: `scripts/build-release.mjs`
- Modify: `scripts/build-release.test.ts`
- Modify: `eslint.config.js`
- Modify: `.prettierignore`

**Interfaces:**
- `WebSessionManager.submitPrompt()` receives a `PENDING` create response and a started Run response from `startRun()`.
- `resolvePackageSource(packagePath: string): Promise<string | undefined>` returns the canonical realpath for regular directories, symlinks, and Windows junctions.

- [x] **Step 1: Reproduce the three stale fixture failures**

Run `pnpm exec vitest run apps/web/test/approval-control.test.ts apps/web/test/cancellation-control.test.ts --reporter=verbose`. Confirm the two approval fixtures assume a `RUNNING` create response and the cancellation fixture assumes `NONE` for a PENDING recovery boundary.

- [x] **Step 2: Align fixtures with the reviewed production contract**

Make approval creation fixtures return `PENDING`, make `startRun()` return the same Run as `RUNNING`, and expect `PENDING_RUN_CONFIRMATION` for the non-cancellable PENDING recovery Run. Do not alter manager behavior.

- [x] **Step 3: Exclude deterministic generated artifacts from source checks**

Add `release-artifacts/**` to ESLint ignores and `release-artifacts` to Prettier ignores. Keep `src`, `test`, and `scripts` included.

- [x] **Step 4: Characterize and fix the release dependency traversal**

Test Windows junction resolution through the exported script helper, then resolve every package path with `realpath()` before registering or recursively materializing it. This prevents junction aliases from creating an unbounded dependency path while preserving the portable artifact graph.

- [x] **Step 5: Verify Task 1**

Run `pnpm exec vitest run apps/web/test/approval-control.test.ts apps/web/test/cancellation-control.test.ts apps/web/test/reconnect.test.ts apps/web/test/recovery.test.ts`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:release`, `pnpm exec prettier --check scripts/build-release.test.ts scripts/build-release.mjs apps/web/test/approval-control.test.ts apps/web/test/cancellation-control.test.ts apps/web/test/reconnect.test.ts apps/web/test/recovery.test.ts`, and `git diff --check`. Record exact pass/fail counts.

### Task 2: Final UX information architecture

**Files:**
- Create: `docs/superpowers/specs/2026-09-03-phase-13e-production-ux-design.md`
- Create: `docs/superpowers/plans/2026-09-03-phase-13e-production-ux-browser-e2e-release.md`
- Inspect/modify only when needed: `apps/web/src/app.ts`, `apps/web/src/components/*.ts`, `apps/web/src/application/*.ts`, `apps/web/src/styles.css`

**Interfaces:**
- `WebHostApp` remains the composition root.
- `WebSessionManager` remains the only Web state/orchestration owner.
- Components consume bounded public projections and callbacks.

- [x] **Step 1: Record the user-approved architecture**

Document Two-column only, icon-only Session Rows, inline Timeline/Approval/Cancel/Reconnect/Recovery, Composer, responsive behavior, and prohibited product surfaces in the spec above.

- [x] **Step 2: Map current files to one responsibility each**

Keep `app.ts` for host composition, `session-sidebar.ts` for navigation rows, `session-workspace.ts` for layout composition, `timeline.ts` for public timeline rendering, control components for their respective inline interactions, and CSS for tokens/layout/responsive rules. Add a helper only when a responsibility cannot remain testable in its current file.

- [x] **Step 3: Self-review the design and plan**

Check that no plan task calls a new backend API, no unsupported panel is introduced, all later task interfaces match these names, and no placeholder terms remain.

### Task 3: Production desktop UI

**Files:**
- Modify: `apps/web/src/app.ts`
- Modify: `apps/web/src/components/session-sidebar.ts`
- Modify: `apps/web/src/components/session-workspace.ts`
- Modify: `apps/web/src/components/timeline.ts`
- Modify: `apps/web/src/components/approval-card.ts`
- Modify: `apps/web/src/components/reconnect-banner.ts`
- Modify: `apps/web/src/components/recovery-panel.ts`
- Modify: `apps/web/src/components/prompt-composer.ts`
- Modify: `apps/web/src/components/run-status.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/presentation.test.tsx`
- Test: `apps/web/test/control-presentation.test.tsx`

**Interfaces:**
- `SessionSidebar` receives existing `SessionCandidate[]`, selection, draft state, and callbacks.
- `SessionWorkspace` receives existing `SessionHistoryEntry[]`, `TimelineState`, approval/recovery projections, active Run, and callbacks.
- `Timeline` continues to receive only `TimelineState`.

- [ ] **Step 1: Write failing presentation tests**

Add assertions that RUNNING/WAITING_APPROVAL/COMPLETED/FAILED rows contain a status mark and accessible label but no visible Chinese status subtitle; add selected/empty/draft assertions; assert only one new-session action, one cancel action, and no inspector/status-bar/terminal markers.

- [ ] **Step 2: Run the focused presentation tests and observe RED**

Run `pnpm exec vitest run apps/web/test/presentation.test.tsx apps/web/test/control-presentation.test.tsx --reporter=verbose`. The new icon-only and no-subtitle assertions must fail against the current markup.

- [ ] **Step 3: Implement the minimum desktop markup change**

Render a semantic status icon before each bounded title, attach `aria-label`/`title` from `run-status.ts`, remove `.session-list-meta`, preserve candidate selection callbacks, and arrange the workspace so history, Timeline, inline controls, and Composer remain one flow. Do not move orchestration into React.

- [ ] **Step 4: Replace generic decoration with production tokens**

Use CSS variables for ink, muted ink, surface, border, accent, semantic states, spacing, and control heights. Keep the dense analyst workspace direction: small marks, compact rows, thin dividers, readable body text, visible focus, and no card explosion.

- [ ] **Step 5: Verify desktop UI tests and build**

Run the two focused test files, `pnpm --filter @caelush/web typecheck`, `pnpm --filter @caelush/web build`, `pnpm exec prettier --check` on every changed file, and `git diff --check`.

### Task 4: Long-running Timeline UX

**Files:**
- Create if needed: `apps/web/src/components/timeline-scroll.ts` or a focused hook file under `apps/web/src/components/`
- Modify: `apps/web/src/components/timeline.ts`
- Modify: `apps/web/src/components/session-workspace.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/timeline.test.tsx`

**Interfaces:**
- Scroll controller consumes a timeline container ref, a bounded activity count, and an injectable frame/timer boundary only if needed for deterministic tests.
- It exposes `isFollowing`, `newActivityCount`, `onScroll`, and `jumpToLatest()` without touching SessionManager state.

- [ ] **Step 1: Write failing scroll behavior tests**

Test that a near-bottom container follows new entries, an upward user scroll detaches follow and increments `N 条新活动`, clicking the indicator calls `scrollTo({ top: scrollHeight })` and resumes follow, and later entries auto-follow again. Assert focus remains on the active control.

- [ ] **Step 2: Run the focused timeline tests and observe RED**

Run `pnpm exec vitest run apps/web/test/timeline.test.tsx --reporter=verbose` and confirm the new scroll assertions fail because current Timeline has no owned scroll container/controller.

- [ ] **Step 3: Implement near-bottom detection and detached follow**

Use a small threshold such as 48 CSS pixels; update follow state from `scrollTop + clientHeight >= scrollHeight - threshold`; when detached, count newly rendered activity keys; when following, schedule one post-render bottom alignment with `requestAnimationFrame` or the injected deterministic scheduler.

- [ ] **Step 4: Add the bounded jump indicator and motion policy**

Render one semantic button with `aria-label="跳转到最新活动"`, bounded count text, and a visible focus style. Keep Timeline out of assertive live regions. Add reduced-motion CSS so the indicator and active marks become static when requested.

- [ ] **Step 5: Verify long-run behavior**

Run `pnpm exec vitest run apps/web/test/timeline.test.tsx apps/web/test/presentation.test.tsx`, Web typecheck/build, changed-file Prettier, and `git diff --check`.

### Task 5: Responsive, keyboard, and accessibility hardening

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/app.ts`
- Modify: `apps/web/src/components/session-sidebar.ts`
- Modify: `apps/web/src/components/session-workspace.ts`
- Modify: `apps/web/src/components/approval-card.ts`
- Modify: `apps/web/src/components/reconnect-banner.ts`
- Modify: `apps/web/src/components/recovery-panel.ts`
- Modify: `apps/web/src/components/prompt-composer.ts`
- Test: `apps/web/test/presentation.test.tsx`
- Test: `apps/web/test/control-presentation.test.tsx`
- Test: `apps/web/test/prompt.test.ts`

**Interfaces:**
- Preserve all existing callback contracts and `shouldSubmitPrompt({ key, shiftKey, isComposing })` semantics.
- Tablet may collapse the sidebar; narrow screens may use an overlay/drawer, but it must not create a second product column or a second source of session state.

- [ ] **Step 1: Write failing keyboard and accessibility tests**

Cover Enter submit, Shift+Enter newline, IME composing Enter no-submit, semantic button/tab order, visible focus classes, icon-only labels, approval/recovery keyboard operability, and a non-assertive timeline. Add markup checks for dialog/overlay roles where used.

- [ ] **Step 2: Run focused tests and observe RED**

Run `pnpm exec vitest run apps/web/test/presentation.test.tsx apps/web/test/control-presentation.test.tsx apps/web/test/prompt.test.ts --reporter=verbose` and confirm missing labels/responsive hooks fail.

- [ ] **Step 3: Implement responsive layout and focus behavior**

Keep full two-column layout at desktop, collapse sidebar controls at tablet, and turn the sidebar into a keyboard-operable drawer/overlay at narrow widths. Ensure main content and Composer remain usable at 320px, 768px, 1024px, and 1440px widths.

- [ ] **Step 4: Implement ARIA and reduced-motion details**

Use `role="status"` only for important connection/terminal transitions, `aria-live="polite"` for reconnect/approval/terminal announcements, visible `:focus-visible` styles, labels for icon-only actions, and `prefers-reduced-motion: reduce` to disable pulses/transitions. Do not make the full Timeline assertive.

- [ ] **Step 5: Verify desktop/tablet/narrow render contracts**

Run focused tests, `pnpm --filter @caelush/web typecheck`, `pnpm --filter @caelush/web build`, changed-file Prettier, and `git diff --check`; then inspect the production Web at 1440×900, 1280×800, 1024×768, 768×1024, and a 320px-wide viewport for overflow and operability.

### Task 6: Full real browser E2E

**Files:**
- Create: `playwright.config.ts` only if no existing browser runner is sufficient
- Modify: `package.json` and `pnpm-lock.yaml` only if `@playwright/test` is genuinely required
- Create: `tests/browser/phase-13e-production.spec.ts` or the repository's established equivalent
- Modify: `.gitignore` for `test-results/` and `playwright-report/` if needed
- Reuse: `apps/web/test/phase-13d-integration.test.ts`, `apps/web/test/daemon-timeline-e2e.test.ts`, `apps/daemon/test/*`, `scripts/web-session-browser-smoke.mjs`

**Interfaces:**
- Browser launches the production Web build/static host and talks to a real daemon with real SQLite and real client APIs.
- Deterministic provider fixture is an HTTP LLM fixture only; the browser never injects fake DOM/state.

- [ ] **Step 1: Inventory existing browser capability**

Search `package.json`, lockfile, scripts, and test files for Playwright/browser runners. Reuse one existing harness; if absent, add only `@playwright/test`, Chromium, `playwright.config.ts`, and a `test:web:e2e` script.

- [ ] **Step 2: Write real browser scenarios before implementation wiring**

Cover A basic Session→Prompt→Run→Tool/File→Verification→Verified Result; B Approval Once; C Reject; D daemon-confirmed Cancellation; E reconnect/replay without duplicates; F browser reload recovery; G PENDING Recovery; H WAITING_APPROVAL reload; I daemon restart if harness permits; J icon + title sidebar rows for Running/Waiting Approval/Completed/Failed.

- [ ] **Step 3: Run the browser suite and observe failures**

Run `pnpm test:web:e2e` (or the established script) against the production build. Failures must be real route/markup/lifecycle failures, never solved with `page.evaluate` fake data or mocked SSE/daemon.

- [ ] **Step 4: Wire only the missing production markup/test harness pieces**

Add stable semantic labels and test IDs only where the user-visible contract needs deterministic targeting. Start/stop real daemon and SQLite fixtures in the test lifecycle; preserve the same RunId across reload/recovery and assert no duplicate activity.

- [ ] **Step 5: Verify browser artifacts and security**

Run the complete browser suite with screenshots/trace-on-failure, keep artifacts ignored, and assert the DOM contains no raw tool args, secrets, hidden reasoning, stdout/stderr, or unsupported panels.

### Task 7: Release integration and final delivery seal

**Files:**
- Modify only if Task 1 diagnosis requires: `scripts/build-release.mjs`, `scripts/test-release.mjs`, `scripts/artifact-e2e.mjs`
- Modify: `docs/reports/2026-09-03-phase-13e-completion-report.md`
- Review: `apps/launcher/src/web.ts`, `apps/daemon/src/web/static-host.ts`, `scripts/build-release.mjs`

**Interfaces:**
- `pnpm build:release` produces the platform artifact containing `web/index.html`, `web/assets/*`, launcher, daemon, and portable dependencies.
- `pnpm test:release` consumes that artifact and must report `artifact-e2e passed: <version>`.

- [ ] **Step 1: Verify production Web assets**

Run `pnpm --filter @caelush/web build`; inspect `apps/web/dist/index.html` and `assets/*` for missing assets, source-map secrets, development-only dependencies, and mock product data.

- [ ] **Step 2: Run release build and artifact E2E with exit codes**

Run `pnpm build:release` and wait for its actual exit code; then run `pnpm test:release` and record its exact output. Do not infer success from a silent wait.

- [ ] **Step 3: Run production smoke**

Use `caelush web`/launcher against a real workspace and daemon. Confirm the production page has no Vite overlay, fatal console error, missing assets, CORS error, browser Node-polyfill error, hydration/render error, or secret/raw output exposure.

- [ ] **Step 4: Run final verification in the required order**

Run `git diff --check`, changed-file Prettier, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, browser E2E, `pnpm build:release`, `pnpm test:release`, and production smoke. Count tests and failures exactly; report repository-wide `format:check` separately if historical debt remains.

- [ ] **Step 5: Complete the delivery report and seals**

Record baseline SHA, task branch SHA, remote task SHA, final master SHA, `origin/master` SHA, Phase 13A–13E verdicts, security boundary answers, browser scenario matrix, release evidence, and any intentional deviations. Push `codex/phase-13e-production-ux-browser-e2e-release-integration`, verify remote SHA, fast-forward `master`, push `master`, verify local/remote equality, delete only the local task branch with `git branch -d`, and finish with clean `master` and no worktrees.
