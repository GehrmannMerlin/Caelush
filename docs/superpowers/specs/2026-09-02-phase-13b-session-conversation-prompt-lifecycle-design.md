# Caelush Phase 13B Session / Conversation / Prompt Lifecycle

## Goal

Extend the Phase 13A Production Web Host with a real Session sidebar, Run-level safe history, bounded prompt submission, and one active Run lifecycle, while keeping daemon/Protocol/Verification authoritative.

## Boundaries

- Browser state is a local projection, not a source of truth for Session, Run, or Completion.
- All daemon requests enter through one `@caelush/client` instance.
- Session filtering, activity ordering, terminal detection, and Run-level history use browser-safe semantics shared with the CLI.
- A new Session is a local draft until the first valid prompt is submitted.
- Prompt admission creates a real Session, then a real Run; the Run observer is attached and opened before `startRun()`.
- Only one Web-owned non-terminal Run may be active. Multiple historical non-terminal Runs fail closed and disable the composer.
- Run lifecycle SSE is used only for status refresh. Timeline, Tool, Approval, Cancellation, Reconnect, and Recovery UI remain deferred.
- A completed Run displays only a `VerifiedRunFinalResultSchema`-validated final result.

## Data Flow

```text
@caelush/client
        ↓
browser-safe session projection
        ↓
WebSessionManager (getSnapshot / subscribe)
        ↓
React presentation
```

The manager loads up to 100 Sessions and bounded latest-Run summaries, filters by the daemon-provided canonical `WorkspaceRef.path`, and uses the existing daemon `defaultModel` and `defaultRunConfiguration` for Run creation. The browser never calls `realpath`, reads workspace files, reads Conversation storage, or reconstructs hidden model/tool messages.

## Browser-safe shared semantics

`@caelush/client` will expose a narrow `session-projection` module containing Session candidate enrichment, activity sorting, workspace path comparison, non-terminal detection, and Run-level history hydration. It will not import Node APIs. The CLI keeps its public relative-path behavior through a small Node adapter and reuses the shared projection functions and types.

## Web presentation

The page becomes a simple top bar, Session sidebar, and main workspace. It shows real Sessions, a local New Session draft, Run status, user goals, safe terminal markers, validated final results, and a text-only composer. It does not show a right Inspector, timeline, Tool activity, Approval controls, cancellation controls, recovery controls, or fabricated metrics/data.

## Error policy

Transport, Session, Run, stream, and configuration failures become fixed safe Web messages. A failed Session/Run admission retains the user's input and leaves no fabricated history entry. Missing default model, ambiguous multiple active Runs, invalid final result, and unsupported Session workspace fail closed.

## Verification

Focused tests cover shared projection, Web model state transitions, draft admission, prompt UTF-8 bounds, listener-before-start ordering, terminal refresh, verified result projection, and failure paths. A real daemon/SQLite/deterministic-provider integration test exercises create Session → create Run → watch → start → VERIFYING → COMPLETED → verified result. A Playwright smoke uses the production Web assets and real daemon to submit one prompt and observe the verified result. Existing full regression and release gates remain required.
