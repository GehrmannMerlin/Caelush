# Task 4 Report — Reconnect, replay, and one-stream lifecycle

## Scope and outcome

Implemented Task 4 only in the Web application. The implementation uses the shared `@caelush/client` `ReconnectScheduler`; it does not add a Web-specific delay schedule or modify Protocol, Core, Security, Runtime, Verification, daemon routes, or persistence.

- A live Web Run keeps its Timeline and durable replay cursor through stream loss.
- Replacement streams use `afterSequence: 0` initially and the retained `timeline.lastDurableSequence` thereafter.
- The old stream is aborted before a replacement controller is installed. A monotonic stream generation protects callbacks, event handling, lifecycle refreshes, and recovery responses from stale streams.
- Open success marks the transport connected, clears transient transport failure presentation, and resets the shared scheduler. Reconnect-open admits one `recoverRun` call only for that stream generation.
- Genuine stream loss schedules the shared frozen retry sequence `[250, 500, 1000, 2000, 4000, 5000]`; only exhaustion exposes a manual reconnect state. Manual reconnect only delegates to the exhausted scheduler and never creates a Run.
- Timeline integrity failure and known client HTTP/protocol/compatibility failures become local terminal transport errors and do not enter the retry scheduler.
- `app.ts` now renders the existing transport state/attempt and shows a reconnect button only when the state is disconnected.

## Changed files

- `apps/web/src/application/session-manager.ts`
  - Added one-stream lifecycle ownership, shared scheduler integration, replay cursor selection, generation guards, recovery-on-open, local terminal stream error classification, and `reconnectActiveRun()`.
  - Added a presentation-only `transportAttempt` snapshot field and safe exhausted reconnect text.
- `apps/web/src/app.ts`
  - Displays connected/reconnecting/disconnected state and exposes the manager's existing manual reconnect action when appropriate.
- `apps/web/test/reconnect.test.ts`
  - New focused tests for durable replay, abort-before-replace, stale-generation recovery isolation, all six retry delays/exhaustion, and manual retry without Run creation.
- `apps/web/test/session-manager.test.ts`
  - Updated the old stream-loss expectation: a genuine loss now enters `RECONNECTING` without exposing raw stream details rather than immediately becoming a terminal error.

## TDD evidence

### RED

Command:

```text
pnpm exec vitest run apps/web/test/reconnect.test.ts
```

After correcting the new test fixture's missing `WorkspaceRef.id`, the initial run failed as intended because no reconnect behavior existed. All three tests timed out waiting for the first scheduled retry (`timer.delays.length === 1`), demonstrating the missing lifecycle behavior.

```text
Test Files  1 failed (1)
Tests       3 failed (3)
```

The stale-generation test was additionally mutation-checked after implementation: temporarily removing the generation check made the old recovery response overwrite the new lifecycle with `RUNNING`.

```text
FAIL discards a late recovery result from a replaced stream generation
Expected: "PENDING"
Received: "RUNNING"
```

The guard was immediately restored.

### GREEN

Focused Web tests:

```text
pnpm exec vitest run apps/web/test/reconnect.test.ts apps/web/test/session-manager.test.ts

Test Files  2 passed (2)
Tests       20 passed (20)
```

Formatting for changed Web files:

```text
pnpm exec prettier --write apps/web/src/application/session-manager.ts apps/web/src/app.ts apps/web/test/reconnect.test.ts apps/web/test/session-manager.test.ts
```

Full workspace typecheck:

```text
pnpm typecheck

Scope: 17 of 18 workspace projects
... all build and typecheck tasks completed successfully ...
```

Diff integrity:

```text
git diff --check
exit 0
```

## Self-review

- Confirmed that `ReconnectScheduler` is imported from the shared client package and Web introduces no delay constants or duplicate scheduler.
- Confirmed every `watchRunEvents` call includes `afterSequence`, `signal`, and `onOpen`.
- Confirmed `attachStream()` aborts the old controller before creating the new controller and increments generation before consumption.
- Confirmed all async paths which may publish after a stream change revalidate the active lifecycle and generation.
- Confirmed durable event ordering/deduplication remains exclusively in `reduceTimelineEvent`; no Web-only dedup map was added.
- Confirmed scheduler disposal happens when the active lifecycle is cancelled or the manager is disposed.
- Confirmed manual reconnect has no `createRun` call path.

## Commit

- `2f1654d20617dfdf634ac7d45bc377afd8be1305` — `feat(web): reconnect live runs from durable sequence`

## Concerns

- No browser end-to-end test was added; the app wiring is intentionally minimal and the lifecycle behavior is tested at the manager boundary with injected timers and controlled streams.
- The existing client error classes are treated as non-retryable protocol/business failures. Unknown errors and normal premature stream completion are conservatively treated as genuine transport loss, which is the retryable boundary required by this task.
