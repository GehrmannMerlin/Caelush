# Caelush Phase 13C — Live Agent Timeline & Execution Visualization

## Status

Approved in chat on 2026-09-02. This design covers Phase 13C only. Phase 13D and Phase 13E remain deferred.

## Goal

Convert safe, `USER_VISIBLE` `AgentEvent` values from the existing daemon SSE stream into a bounded, deterministic, browser-safe execution timeline shared by CLI and Web hosts. The Web host will render that projection alongside conversation history while daemon `getRun()` remains the authority for lifecycle state.

## Constraints and non-goals

- The existing `@caelush/protocol` `AgentEvent` contract remains the only wire contract; no Timeline-specific protocol entities are added.
- Core, Security, Runtime, Tools, Verification, Storage, and daemon production surfaces are not modified unless a concrete existing public-event blocker is proven.
- React remains a renderer, not a source of Agent state. CLI/Web do not maintain independent Timeline reducers.
- Only `USER_VISIBLE` events for the selected Run are projected.
- Durable identity is validated with `eventId` and `durability.sequence`. Exact replay is ignored; conflicting identity/order fails closed with a safe Timeline error.
- The projection remains bounded: 8 KiB text, 256 settled entries, 32 active entries, and 1024 seen events by default.
- Phase 13C does not implement Approval controls, Cancellation, Reconnect, after-sequence replay orchestration, active-Run reattachment, or Recovery.
- Schema-only events (`plan.updated`, `tool.output`, `shell.output`, `process.output`, `verification.started`, and `verification.completed`) may remain reducer compatibility cases for existing CLI behavior, but Web product behavior must not depend on them.

## Architecture

```text
Agent Runtime
    ↓
Durable AgentEvent
    ↓
daemon SSE
    ↓
@caelush/client CaelushClient
    ↓
shared Timeline reducer / presentation helpers
    ├── CLI lifecycle adapter + Ink presenter
    └── WebSessionManager + React presenter
```

The host-agnostic Timeline model, reducer, and browser-safe presentation helpers move into `@caelush/client`. The existing CLI application files become thin compatibility adapters so current imports and CLI presentation behavior remain stable without retaining a second implementation.

## Shared Timeline projection

### State

The shared state contains the Run identity, immutable limits, bounded settled entries, bounded active Tool/Approval/Process/LLM activity, bounded Retry and Verification groups, the last durable sequence, bounded seen-event identities, an omitted-activity marker, and an optional safe projection error. It never stores raw Tool arguments, credentials, hidden reasoning, provider bodies, shell/process output, or Verification evidence.

Tool entries retain the safe `toolName` in addition to their display title so host presentation can map known Built-in tools without looking up private invocation data. File summaries retain only the public path/change summary fields already present in `AgentEvent`.

### Reduction rules

- `reasoning.summary` creates a bounded reasoning entry and deduplicates repeated adjacent summaries.
- `llm.started`, `llm.completed`, and `llm.failed` form lightweight model activity and expose only model, aggregate usage, or sanitized error fields.
- `tool.requested`, `tool.started`, `tool.completed`, and `tool.failed` upsert one activity by `invocationId`; lifecycle events never render as separate cards.
- File events aggregate into the sole matching Tool activity for the same Step; otherwise they remain standalone safe File entries.
- Shell lifecycle uses its public command label and completion exit code/signal. Shell output is not a Web feature.
- Process lifecycle uses the public process summary and status. Process output is not a Web feature.
- Retry events upsert by stable retry identity derived from Step/attempt.
- Verification plan/check/repair/finalized events update bounded verification groups and expose only counts, labels from payload, status, duration, and final outcome.
- Approval events create a pending/resolved read-only marker. No approval action is exposed.
- Error and budget events become sanitized settled entries.
- Terminal flush settles all remaining active Tool, Process, Approval, Retry, and Verification work as interrupted/terminated entries, so a terminal Run cannot leave stale `RUNNING` UI.

All text sanitation and UTF-8 byte bounding is implemented without Node globals. `TextEncoder` is used for byte measurement, and truncation iterates Unicode code points so multibyte characters, emoji, and surrogate pairs are not split.

## CLI integration

The CLI keeps its current application-facing module names but re-exports shared symbols through aliases such as `CliTimelineState` and `createInitialCliTimelineState`. `event-projector.ts` continues to own CLI Run lifecycle projection and calls the shared reducer/terminal flush. Ink components remain CLI-only. Existing reconnect, recovery, approval-control, and terminal behavior are outside the shared Web projection and remain owned by the CLI controller.

## WebSessionManager integration

`WebSessionSnapshot` gains `timeline: TimelineState`. A new Run starts with `createInitialTimelineState(run.id)`. The same `watchRunEvents()` loop performs both projections:

1. Reduce every incoming `AgentEvent` into the Timeline and publish the updated snapshot.
2. For lifecycle events only, call `getRun()` and publish the daemon-authoritative Run state.
3. When the authoritative Run is terminal, flush the Timeline before retaining it on the current page and performing the existing session settlement refresh.

Non-lifecycle activity events never trigger `getRun()`. The manager opens no second SSE stream. Session switching does not fabricate historical Activity because there is no public Timeline-history API in this phase. Refresh/reconnect behavior remains deferred.

## Web presentation

The current session layout becomes:

```text
Session Header
Conversation History
Current Run Activity
Verified Final Result / terminal history
Composer
```

The Timeline component is React-free in its state inputs and renders only public projection data. It uses Chinese labels for known activity types while preserving model names, paths, IDs, and unknown Tool names as technical values. It has semantic status text, visible focus styles, responsive layout, and reduced-motion behavior.

The Web surface deliberately has no Inspector, Diff Viewer, File Viewer, Terminal, Shell Output, Process Output, Git Panel, Agent Plan, Verification Evidence, Usage Dashboard, Model/Tool Settings, Approval controls, Cancel, Reconnect, or Recovery controls.

## Testing strategy

Tests are added before implementation in these layers:

1. `packages/client`: shared reducer, presentation, event identity, safety, UTF-8 bounds, active/settled/seen bounds, and synthetic 1000+ event bounds.
2. `apps/cli`: existing timeline and event-projector regression tests continue to exercise the shared implementation through adapters.
3. `apps/web`: WebSessionManager proves one SSE drives Timeline plus lifecycle refresh, non-lifecycle events do not call `getRun()`, and terminal flush retains settled activity. React rendering covers each supported production event category and asserts forbidden UI is absent.
4. Real daemon integration: deterministic provider → real Agent → real Tool Dispatcher/runtime → real public Tool/File events → continuation → Verification → verified completion, with no mock Timeline DOM or mock SSE.
5. Browser/build checks: the shared client package and Production Web build are inspected for the absence of `Buffer`, `process`, and `node:*` dependencies; desktop/mobile smoke verifies the real daemon-driven Timeline.

Focused checks run before the repository-wide regression. The final validation includes `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:release`, `pnpm test:release`, `pnpm format:check` for changed files, and `git diff --check`.

## Alternatives considered

- **Duplicate a Web reducer:** rejected because CLI and Web semantics would drift and fixes would need to be applied twice.
- **Add a Timeline-specific Protocol contract:** rejected because existing `AgentEvent` already contains the required safe public data and a second wire model would expand the stable contract unnecessarily.
- **Make React associate Tool/File/Verification state locally:** rejected because it would violate Core/daemon authority and create a second Run state model.

