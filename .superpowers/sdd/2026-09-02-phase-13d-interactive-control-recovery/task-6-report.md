# Phase 13D Task 6 Report

## Scope

- Baseline: `a218e9e` (`fix(web): revoke recovery when approval is pending`), task branch `codex/phase-13d-approval-cancellation-reconnect-recovery`.
- Implemented only Web control presentation and rendering safety. No Protocol, Core, Security, Runtime, Verification, Daemon, or Storage files were changed.
- Added inline Approval, reconnect, and recovery controls in the existing top-bar/session-sidebar/main-workspace layout. No right Inspector, global Approval Center, Terminal, usage panel, or Phase 13E styling was added.

## Behavior delivered

- `ApprovalCard` accepts only `ApprovalView` and the `(approvalId, resolution)` callback. It renders the bounded public title, risk, reason, summary/tool name, capabilities, and scope-gated Chinese actions. It never renders raw arguments, secrets, tool output, hidden reasoning, evidence, or diffs.
- `SessionWorkspace` uses the shared `canCancelRunStatus` predicate, so exactly one cancel control is available for `RUNNING`, `WAITING_APPROVAL`, and `VERIFYING`. `CANCELLING` renders `正在取消` and does not add a second button.
- `ReconnectBanner` renders technical states `CONNECTED`, `RECONNECTING` with `第 N / 6 次`, and `DISCONNECTED` with one `重新连接` callback.
- `RecoveryPanel` renders bounded goal, technical status, created time, and run ID for pending confirmation and multi-run recovery selection. Goal output is UTF-8 bounded to 2 KiB.
- `WebHostApp` wires controls to the existing `WebSessionManager` methods. Prompt composition is disabled while active/cancelling/recovery state requires it.

## TDD evidence

1. Added `apps/web/test/control-presentation.test.tsx` before production components.
2. Observed RED: Vitest failed because `../src/components/approval-card.js` was missing.
3. Added the minimal components and wiring; observed GREEN: focused rendering tests passed.
4. Added a bounded-goal regression assertion; observed RED because the full goal was rendered; added browser-safe `TextEncoder`/`TextDecoder` truncation; observed GREEN.

## Verification

- `pnpm --filter @caelush/web exec vitest run test/control-presentation.test.tsx test/presentation.test.tsx test/timeline.test.tsx`: PASS, 3 files / 12 tests.
- `pnpm typecheck`: PASS, including workspace build and all package/app typechecks.
- `git diff --check`: PASS, with normal Git LF/CRLF conversion warnings only.
- Changed-file Prettier check: PASS (`All matched files use Prettier code style!`).
- Full `pnpm test`: 1304 passed, 5 skipped, 5 failed in 3 files. The failures are outside Task 6 presentation code: two existing Web approval-control tests, one existing Web cancellation-control expectation, and two Runtime process-manager timing/output tests. They were recorded rather than changed because Task 6 is strictly UI/rendering and must not modify Manager/runtime behavior.

## Changed files

- `apps/web/src/app.ts`
- `apps/web/src/components/session-workspace.ts`
- `apps/web/src/components/prompt-composer.ts`
- `apps/web/src/components/approval-card.ts`
- `apps/web/src/components/reconnect-banner.ts`
- `apps/web/src/components/recovery-panel.ts`
- `apps/web/src/styles.css`
- `apps/web/test/control-presentation.test.tsx`
