# Project

Caelush is a TypeScript/Node.js local-first coding-agent runtime. CLI, Web,
and future hosts share one Agent Kernel and one daemon composition root; they
do not own separate Agent implementations.

The current source-of-truth branch is `main`. The Message System migration is
complete through Architecture V2 Phase 5F. The Event System migration is
complete through Phase 6B: the canonical RunEvent domain and Protocol foundation
plus the daemon-owned asynchronous observation runtime are present, while the
public projection and control-plane phases remain pending. Phase 5: COMPLETE.
Phase 6A: COMPLETE. Phase 6B: COMPLETE. Phase 6C–6H: NOT STARTED.
Phase 5F owns the final historical
backfill, physical `agent_messages` rebuild, legacy reader/package retirement,
and daemon/client final cutover.
Phase 5E previously completed the daemon Transcript projection and client
cutover that Phase 5F now treats as the canonical path.
Phase 5D established durable conversation authority for Context and replay.

## Architecture contract

- Applications depend on packages. Packages never depend on app internals.
- `apps/daemon` is the only production composition root. CLI and Web are thin
  client/presentation hosts and must not construct an AgentLoop, Runtime,
  Provider, Tool executor, Storage service, or second Run state machine.
- `@caelush/protocol` is the low-level JSON-safe contract package. It must not
  depend on Caelush feature packages, apps, Provider SDKs, database rows,
  Runtime objects, or UI types.
- Cross-package imports use the package public entry point. Do not import
  `@caelush/*/src/...` or private cross-package relative paths.
- Keep dependency direction explicit and acyclic. Run
  `pnpm check:architecture:ci` after package-boundary changes.

## Authority boundaries

- `@caelush/agent` owns the general Agent Kernel, AgentLoop decisions,
  durable message contracts, Tool registry/batch coordination, and execution
  ports. It must not know concrete filesystem Tools, SQLite, daemon routes, or
  UI concerns.
- `@caelush/core` and `RunController` own canonical Run lifecycle
  transitions, durable Run/State/Step/Continuation commits, and Completion
  Authority. A final model answer is a verification candidate, never direct
  `COMPLETED`.
- `@caelush/ai` owns the provider-neutral model domain and the single gateway
  model-turn boundary. One gateway invocation is one provider turn. Providers
  do not execute local Tools, generate Caelush call IDs, retry, or expose SDK
  types through public contracts. Provider credentials are runtime-only.
- `@caelush/coding-agent` owns the built-in coding catalog and operations
  adapters. The model-visible Tool definitions and executable handlers must be
  derived from one immutable registry.
- Tool execution always goes through the Dispatcher and its durable
  invocation lifecycle. Tool definitions are data-only; handlers, permission
  decisions, and Runtime objects do not leak into Protocol or model messages.
- `@caelush/runtime` is an execution substrate. It owns local workspace
  containment, bounded filesystem reads/search, verified patching,
  shell/process sessions, and read-only Git. Runtime must not depend on Tools,
  Core, Storage, Events, Security, LLM, Context, or Verification.
- `@caelush/security` owns policy, capabilities, approvals, command/path
  checks, secret detection/redaction, and safe presentation. It does not spawn
  processes, execute Tools, write Storage, or publish Events. Logical policy
  containment is not an OS-level hard sandbox.
- `@caelush/storage` owns SQLite initialization, migrations, repositories,
  codecs, and durable adapters. Public APIs expose Protocol entities and
  records, not `DatabaseSync`, Drizzle clients, or raw database rows.
- `@caelush/protocol` owns the canonical JSON-safe `RunEvent` domain, including
  `DurableRunEventMeta`, ordered/coalescible transient metadata, the static
  schema registry, and the static event catalog.
- `@caelush/agent` owns `DurableRunEventDraft`, `RunEventNotifierPort`, and the
  read-only `DurableRunEventReaderPort` contracts. Agent has no Storage or
  daemon write authority.
- `apps/daemon` owns the process-scoped `RunEventHub`, bounded per-subscriber
  queues, independent observer workers, observer error isolation, and the
  replay/live bridge. The Hub has no durable write authority.
- `@caelush/storage` exposes a read-only durable event reader with inclusive
  `throughSequence` replay while retaining the legacy append writer.
- `@caelush/events` remains the transitional EventBus compatibility package
  during Phase 6B. Durable events are persisted before publication; sequence
  is the authoritative order. Durable SSE events use sequence as `id`;
  ephemeral events never receive an SSE id.
- `@caelush/verification` can produce bounded evidence and verification
  results but cannot transition a Run to `COMPLETED`. Only Core/RunController
  owns that transition.

## Event V2 / Phase 6B

- `RunEvent` is the target Event domain name; `AgentEvent` is migration
  compatibility naming only.
- Durable sequence belongs to the authoritative Storage transaction. A
  `DurableRunEventDraft` has no sequence until Storage commits it.
- Every new Event type requires explicit type, schema version, visibility, and
  delivery classification in the static Protocol catalog.
- Do not make `@caelush/ai` or `@caelush/runtime` depend on RunEvent.
- Do not introduce new `EventBus` durable `publish()` call sites.
- `RunEventHub` belongs to the daemon, depends on the read-only reader port,
  and must not append durable events or import SQLite implementation details.
- Every subscriber queue is bounded by both pending item count and UTF-8 byte
  count. Durable and ordered-transient overflow closes the slow subscription;
  coalescible pending signals use same-stream latest-wins replacement.
- Observer callbacks execute outside the producer stack on independent workers;
  synchronous throws and rejected Promises are reported and isolated.
- Replay subscribes before reading a fixed high watermark, rejects a cursor
  ahead of that watermark, validates strict sequence order, deduplicates
  buffered durable events, and discards catch-up transient events.
- Phase 6B does not cut over PublicEventProjector, USER_VISIBLE-only public
  projection, durable writer retirement, transient producers, model streaming,
  or Control Hooks; those remain 6C–6G work. Package retirement remains 6H.

## Message V2 / Phase 5F

- `AgentMessageRecord[]` is the durable conversation authority at the Run
  execution boundary.
- User, assistant, and normalized Tool-result records are durable history.
  System prompts, project instructions, relevant-file context, and other
  synthetic prompt input are not ordinary durable-history appends.
- `RunExecutionStore` and `SqliteAgentMessageRecordStore` are the durable
  record path. Project records through the Agent Conversation Repository,
  validator, selector, and projector registry at the Context/model-input
  boundary.
- `AgentTurnInput` carries durable message IDs and source step IDs, never
  provider-shaped AI message arrays or array-index references.
- Historical Tool replay uses stored projected content and projection version;
  unknown model-visible schema or projection versions fail closed.
- Context selection reports IDs, AI-projection token estimates, and compaction
  pressure without rewriting, summarizing, or deleting durable records.
- The finalizer deterministically backfills historical rows, rejects malformed,
  unsupported, mismatched, or ambiguous data, verifies zero legacy-only rows,
  and atomically rebuilds `agent_messages` to the final schema. The old
  migration and strict parser are migration-only; runtime storage has no
  legacy reader, dual-read path, transitional columns, or `@caelush/llm`
  package.
- The daemon projects safe Protocol Transcript entries and CLI/Web require the
  additive `sessionTranscript` capability. A missing capability is an explicit
  protocol compatibility error, not a client-side run hydration fallback.
- `AgentMessageRecord[]` has separate server-side AI and Transcript projector
  paths. `AgentEvent[]` remains the Timeline authority. Transcript-visible
  output must never serialize raw record data, provider state, hidden
  reasoning, or unbounded custom payloads.

## Durable execution rules

- Run creation is not Run execution. Do not publish `run.started` for a
  `PENDING` Run.
- Persist durable state and events before notifying live subscribers.
- Use the canonical Run State Machine; callers must not copy transition rules.
- Recovery resumes only from explicit durable boundaries. Stale in-flight work
  with an unknown side-effect boundary fails closed and is never silently
  resent.
- Do not put credentials, raw hidden reasoning, raw provider SSE, unbounded
  Tool arguments, or exception text in public contracts/events/errors.
- Tool result batches must preserve assistant source order and contain exactly
  one result per requested call before the next provider turn.
- Verification evidence is not completion. Require the current Completion
  Authority guards before claiming a task is complete.

Phase 11B rules:

- Verification command execution is a host adapter over typed argv and Runtime `executeArgv()`; the Verification package does not spawn processes or read the workspace.
- Keep verification output bounded and treat evidence as input to Completion Authority, never as a direct `COMPLETED` transition.

## Development rules

- Make the smallest change that satisfies the request and preserve existing
  architecture decisions. Do not implement a future phase early.
- For behavior changes, write or update a focused test first, observe the
  failure, then implement the smallest fix. Pure Markdown/configuration
  changes do not need artificial tests.
- Keep files focused, TypeScript strict, ESM-compatible, and free of circular
  dependencies. Add internal dependencies as `@caelush/*` with `workspace:*`.
- Do not edit `node_modules`, use `pnpm patch`, or upgrade pinned AI SDK
  dependencies without a demonstrated pinned regression and verified fix.
- Keep provider adapters narrow. AI SDK runtime imports belong only in the
  provider adapter implementation boundary.
- Do not add a second Tool catalog, Provider registry, Runtime API, database
  state model, event side channel, or UI-owned execution state.
- Temporary plans, specs, task reports, blocked evidence, characterization
  output, and coding-session notes belong outside the repository. Do not commit
  `.superpowers/`, `docs/superpowers/`, `docs/reports/`, or
  `docs/characterization/`.

## Validation

For normal source changes, use the narrowest relevant checks first and finish
with the repository checks appropriate to the change:

```bash
pnpm check:architecture:ci
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm check
```

For documentation-only governance work, do not expand validation merely out of
habit. Run the task's specified architecture gate, hygiene guard, targeted
Phase 5C tests, targeted Prettier, and `git diff --check`; record any full
suite intentionally not run.

Before handing off any change, inspect:

```bash
git status --short
git diff --check
git diff
```

## Git and safety

- Preserve unrelated user changes. Never use `git reset --hard` or
  `git checkout --` unless explicitly requested.
- Before deleting branches or material files, resolve and verify exact targets
  and create a recoverable backup when history is involved.
- Do not force-push or rewrite unrelated history. Keep the canonical branch
  rooted at the latest verified Architecture V2 source.
- Report uncertainty and blockers plainly. Never claim a remote, metadata,
  test, or deployment action succeeded without checking its result.
