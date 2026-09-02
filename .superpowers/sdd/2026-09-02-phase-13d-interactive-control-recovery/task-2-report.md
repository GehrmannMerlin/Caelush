# Task 2 report — Web Approval lifecycle and local control state

## Outcome

Implemented only Task 2 on `codex/phase-13d-approval-cancellation-reconnect-recovery`.

- Commit: `21fb4458b6ed06c72b34fc64bd69e2551bf9d1d4` — `feat(web): add approval control lifecycle`
- No Protocol, Core, Security, Runtime, Verification, daemon route, cancellation, reconnect, recovery, or Approval UI changes were made.

## TDD evidence

### Red

The required command was run first:

```text
pnpm --filter @caelush/web test -- approval-control.test.ts session-manager.test.ts
```

It exited `1` because `@caelush/web` does not define a `test` script. The package exposes only `build` and `typecheck`; this command produced no runner diagnostic.

I then ran the equivalent direct Vitest command to obtain an actionable red baseline:

```text
pnpm --filter @caelush/web exec vitest run test/approval-control.test.ts test/session-manager.test.ts
```

Observed red result after correcting the fixture shape:

```text
Test Files  1 failed | 1 passed (2)
Tests  5 failed | 16 passed (21)
```

The failures were the intended missing behavior:

- `approvalState` was absent after `approval.requested`.
- pending approvals were not loaded or ordered on active-session selection.
- `WebSessionManager.resolveApproval` did not exist.

An additional red test was added after the initial green pass to protect the immutable public snapshot contract. It failed because individual `ApprovalView` objects were not frozen:

```text
AssertionError: expected false to be true
... approvalState?.requests[0]
```

### Green

Final focused test run:

```text
pnpm --filter @caelush/web exec vitest run test/approval-control.test.ts test/session-manager.test.ts

Test Files  2 passed (2)
Tests  21 passed (21)
```

Final typecheck:

```text
pnpm --filter @caelush/web typecheck
$ tsc --noEmit
```

Repository typecheck was also run successfully:

```text
pnpm typecheck
$ pnpm build && tsc -p tsconfig.json --noEmit && pnpm -r --if-present run typecheck
```

All listed workspace build and typecheck tasks completed successfully.

Final scoped lint/format/diff verification:

```text
pnpm exec eslint apps/web/src/app.ts apps/web/src/application/session-manager.ts apps/web/test/approval-control.test.ts
pnpm exec prettier --check apps/web/src/app.ts apps/web/src/application/session-manager.ts apps/web/test/approval-control.test.ts
All matched files use Prettier code style!
git diff --check
```

All completed successfully.

## Changed files

- `apps/web/src/application/session-manager.ts`
  - Extended `WebSessionClient` with the already-existing approval client operations.
  - Added stable presentation snapshot fields: `transportState`, `controlMode`, and immutable `approvalState`.
  - Added `refreshApprovals(runId)` and `resolveApproval(approvalId, resolution)`.
  - Projected `approval.requested` and `approval.resolved` alongside the existing timeline reduction.
  - Hydrated pending approvals on selection of a single active run, sorted by `createdAt` then `approvalId`.
  - Used `createApprovalView` and frozen copies of views/nested data to exclude raw Tool arguments, output, credentials, hidden reasoning, and evidence from Web state.
  - Revalidated the approval identity/status before resolve; stale and failure paths best-effort reconcile `getRun` and `listPendingApprovals` without fabricating an approval error state.

- `apps/web/src/app.ts`
  - Updated the static empty snapshot for the new required stable fields.

- `apps/web/test/approval-control.test.ts`
  - Added coverage for event-driven requested/resolved state, reload hydration/sorting, immutable projection, pre-resolve revalidation, external resolution cleanup, duplicate submission suppression, and failure reconciliation.

## Self-review

- Identity is always the `approvalId`; no array index is used for lookup or mutation.
- Durable API responses are converted by the shared browser-safe `createApprovalView`; raw approval action arguments do not enter snapshot state.
- The approval projection is independent from the Timeline reducer; both consume the same lifecycle event stream.
- The stale and failure branches call `getRun` and `listPendingApprovals` through `Promise.allSettled`, so one refresh failure does not prevent the other reconciliation attempt.
- The public Approval projection and nested user-visible view data are frozen. Submitting IDs use a frozen readonly array, the allowed immutable equivalent of a readonly set.
- The code deliberately leaves successful resolution cleanup event-driven: `approval.resolved` removes the control, while submitting state is cleared after the mutation call. A later Task can layer its UI behavior without changing the manager contract.

## Concerns

- `pnpm check` was run and remains non-zero because the repository lints pre-existing generated files under `release-artifacts/caelush-v0.1.0-windows-x64/web/assets/`. After removing the one Task 2 lint issue, the remaining reported lint failures are in those generated bundles (for example browser globals such as `document`, `window`, and `fetch`). The modified Task 2 files pass scoped ESLint, Prettier, focused tests, workspace build/typecheck, and `git diff --check`.
- The required `pnpm --filter @caelush/web test -- ...` command cannot execute tests until the Web package gains a `test` script. I used the direct equivalent `pnpm --filter @caelush/web exec vitest run ...` for the mandatory red/green observations and did not alter package scripts outside Task 2.

## Fix round 1 — approval control hardening

### Commit

- `897b818c879251b2e2742a43fd4f72bbc571afb3` — `fix(web): harden approval control reconciliation`

### Changed files

- `apps/web/src/application/session-manager.ts`
  - Reserves an approval ID synchronously in a private in-flight set and immediately publishes submitting state before asynchronous preflight begins.
  - Releases the reservation in `finally`, preserving duplicate suppression even when state changes during preflight.
  - Clears an affected approval when reconciliation cannot positively confirm that exact ID remains `PENDING`; `getRun` and `listPendingApprovals` still execute best-effort through `Promise.allSettled`.
  - Clears Approval controls at draft, session selection, selected-session projection, terminal settlement, and terminal reconciliation boundaries.
  - Makes durable approval hydration single-run scoped: `publishApprovals` replaces the projection rather than retaining unrelated-run controls.
  - Routes a terminal `getRun` reconciliation through a dedicated terminal session projection that clears active run state, restores composer availability, preserves durable session history, and clears Approval controls.

- `apps/web/test/approval-control.test.ts`
  - Added regression coverage for concurrent preflight resolution reservation, preflight and mutation reconciliation list failures, cross-run/session/draft control clearing, and terminal reconciliation projection.

### Red evidence

Before the fix, the focused test run showed the reviewed failures:

```text
pnpm --filter @caelush/web exec vitest run test/approval-control.test.ts test/session-manager.test.ts

Test Files  1 failed | 1 passed (2)
Tests  5 failed | 21 passed (26)
```

Observed failures included the unreserved concurrent preflight timing out, stale controls remaining after failed reconciliation, controls retained across an unrelated run, and terminal reconciliation following the active-run path.

### Green evidence

```text
pnpm --filter @caelush/web exec vitest run test/approval-control.test.ts test/session-manager.test.ts

Test Files  2 passed (2)
Tests  26 passed (26)
```

```text
pnpm typecheck
$ pnpm build && tsc -p tsconfig.json --noEmit && pnpm -r --if-present run typecheck
```

All workspace build and typecheck tasks completed successfully. `git diff --check` completed successfully as well.

### Self-review

- The reservation occurs before the first `await`, and both the private set and immutable submitted IDs protect re-entrancy.
- A rejected reconciliation list now fails closed for the affected control; a successful list is the only path that retains it.
- Boundary clearing does not alter Timeline state, cancellation, reconnect/recovery behavior, daemon APIs, or UI.
- Terminal reconciliation no longer calls `publishActiveRun` for a terminal Run. Its explicit session projection leaves `activeRuns` empty, clears `activeRun`, enables the composer, and uses durable run data to rebuild history.

### Concerns

- The prior repository-wide `pnpm check` concern remains unchanged: generated `release-artifacts` bundles are linted and fail on browser globals. This fix round ran the user-requested focused Web tests and workspace `pnpm typecheck`; both passed.

## Fix round 2 — approval context and terminal reconciliation

### Changed files

- `apps/web/src/application/session-manager.ts`
  - Added a private approval context generation bound to the selected session and Run. Approval refresh, resolve preflight/result, reconciliation, and terminal list refresh publish only while that captured context remains current.
  - `clearApprovals()` now advances the generation but deliberately retains in-flight resolution reservations until their original promises unwind, preventing a boundary from admitting a duplicate resolve for the same approval ID.
  - Draft entry invalidates approval work through the same boundary mechanism.
  - Terminal reconciliation now re-derives `activeRuns`, `activeRun`, composer state, timeline, and `MULTIPLE_ACTIVE_RUNS` from the refreshed session run list. It clears only the terminal source Run's control projection and does not cancel an unrelated lifecycle.

- `apps/web/test/approval-control.test.ts`
  - Added delayed-response coverage for refresh crossing a draft boundary, a retained in-flight reservation across that boundary, and terminal reconciliation preserving a sibling nonterminal Run.

### Red / green evidence

Red command:

```text
pnpm --filter @caelush/web exec vitest run test/approval-control.test.ts test/session-manager.test.ts
```

Observed before the implementation:

```text
Test Files  1 failed | 1 passed (2)
Tests  2 failed | 26 passed (28)
```

The two intended failures were the delayed refresh republishing an approval after a draft boundary and terminal reconciliation clearing a sibling active Run.

Green command:

```text
pnpm --filter @caelush/web exec vitest run --no-cache test/approval-control.test.ts test/session-manager.test.ts
```

Observed:

```text
Test Files  2 passed (2)
Tests  29 passed (29)
```

Typecheck command:

```text
pnpm typecheck
```

Observed: exit `0`; all workspace build and typecheck tasks completed.

### Self-review

- A stale asynchronous approval response cannot publish because every post-await publication checks the captured generation, selected session, and current active Run identity.
- `clearApprovals()` no longer empties `resolvingApprovals`, so an old in-flight resolve cannot be displaced by a context transition. Its later completion also cannot republish submission or approval state.
- Terminal reconciliation performs the same nonterminal-run projection as normal settlement and preserves a single sibling active Run; multiple sibling runs retain the canonical `MULTIPLE_ACTIVE_RUNS` error.
- No raw approval data is introduced into Web state, and the existing shared approval projection remains the only projection path.

### Commit

- `2671758c413eb215fa034a18a032cca05ac5a4aa` — `fix(web): guard approval reconciliation context`

### Concerns

- The mandated Web package test-script command remains unavailable because `@caelush/web` has no `test` script. The direct `pnpm --filter @caelush/web exec vitest run ...` command remains the equivalent focused runner and was used for red/green evidence.
- Repository-wide `pnpm check` continues to be outside this scoped fix because it reports pre-existing generated `release-artifacts` browser-global lint failures. Focused Web tests, `pnpm typecheck`, and `git diff --check` were run for this fix.

## Fix round 3 — terminal approval authority and ambiguous timeline reconciliation

### Changed files

- `apps/web/src/application/session-manager.ts`
  - Normal lifecycle settlement now clears Approval controls through `clearApprovals()`, advancing the context generation before `activeRun` is cleared.
  - Approval async continuations now require the captured Run to remain the exact current `activeRun`; an absent active Run no longer authorizes a stale refresh, resolve, or reconciliation publication.
  - Both normal settlement and terminal approval reconciliation create an unbound initial timeline when the refreshed session has multiple active sibling Runs, while retaining those siblings and the canonical `MULTIPLE_ACTIVE_RUNS` error.
- `apps/web/test/approval-control.test.ts`
  - Added a delayed refresh regression that crosses a normal event-stream terminal settlement and proves the stale response cannot restore Approval controls.
  - Added multiple-active terminal reconciliation coverage for sibling preservation, unbound timeline identity, and `MULTIPLE_ACTIVE_RUNS`.
  - Updated the inactive-run projection case to enforce the exact-current-authority contract.

### Red / green evidence

Red command:

```text
pnpm --filter @caelush/web exec vitest run --no-cache test/approval-control.test.ts test/session-manager.test.ts
```

Observed before the implementation:

```text
Test Files  1 failed | 1 passed (2)
Tests  2 failed | 29 passed (31)
```

The intended failures showed a delayed approval refresh republishing after normal terminal settlement and a terminal source Run ID retained in the timeline with two active siblings.

Green command:

```text
pnpm --filter @caelush/web exec vitest run --no-cache test/approval-control.test.ts test/session-manager.test.ts
```

Observed:

```text
Test Files  2 passed (2)
Tests  30 passed (30)
```

Typecheck command:

```text
pnpm typecheck
```

Observed: exit `0`; all workspace build and typecheck tasks completed.

### Self-review

- Context invalidation occurs before the settlement snapshot removes `activeRun`, so a captured context cannot use the former permissive no-active-run case.
- The new exact-authority comparison protects delayed refresh, resolve preflight/result, and reconciliation because they all use `isCurrentApprovalContext()` after awaits.
- Multi-active reconciliation does not cancel an unrelated lifecycle (only a lifecycle owned by the terminal source Run is cancelled), retains every refreshed sibling, and intentionally exposes no selected active timeline.
- The change preserves approval ID-based resolution, synchronous reservation, rejected-list fail-closed behavior, shared bounded approval projection, and raw-data exclusion.

### Commit

- `e598c0329bd49beac69803b89cb0e42752bf1712` — `fix(web): guard terminal approval authority`

### Concerns

- The Web package still has no `test` script, so the direct `pnpm --filter @caelush/web exec vitest run ...` command remains the focused test runner.
- `pnpm check` was run and exited `1` before typecheck/tests because `eslint .` reports 247 pre-existing errors in generated `release-artifacts/caelush-v0.1.0-windows-x64/web/assets/` bundles (for example undefined browser globals such as `document`, `window`, and `fetch`). The scoped Web tests and `pnpm typecheck` pass.
