# Project

Caelush is a TypeScript/Node.js local-first coding-agent runtime. CLI, Web,
and future hosts share one Agent Kernel and one daemon composition root; they
do not own separate Agent implementations.

The current source-of-truth branch is `main`. The Message System migration is
complete through Architecture V2 Phase 5F. The Event System migration is
complete through Phase 6G: the canonical RunEvent domain and Protocol
foundation, daemon-owned asynchronous observation runtime, public projection,
authoritative durable-event transactions, transient signal/streaming cutover,
and the Control Hook/Context Contribution path are present. Phase 5: COMPLETE.
Phase 6A: COMPLETE. Phase 6B: COMPLETE. Phase 6C: COMPLETE. Phase 6D:
COMPLETE. Phase 6E: COMPLETE. Phase 6F: COMPLETE. Phase 6G: COMPLETE.
Phase 6H: NOT STARTED.
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
  ports. It also owns generic Control Hook contracts, immutable registration,
  serial invocation, safe receipts, and bounded Context Contribution
  validation. It must not know concrete filesystem Tools, SQLite, daemon
  routes, UI concerns, Context, Storage, Runtime, Security, Core, or provider
  SDK types.
- `@caelush/context` owns Context item mapping, contribution redaction and
  host-path rejection, contribution rendering, and budget accounting. It does
  not own Hook execution or durable conversation history.
- `@caelush/core` and `RunController` own canonical Run lifecycle
  transitions, durable Run/State/Step/Continuation commits, and Completion
  Authority. Core is the integration boundary for Context Contributions:
  durable Run mode is passed into the Hook context, validated contributions are
  mapped into Context items, and `SNAPSHOT` artifacts are persisted and
  integrity-checked before a model turn. A final model answer is a
  verification candidate, never direct `COMPLETED`.
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
  `throughSequence` replay; it exposes no writable event surface.
- `@caelush/events` remains the transitional EventBus observation compatibility
  package. It has no standalone durable writer or durable `publish` authority.
  Durable SSE events use sequence as `id`; ephemeral events never receive an
  SSE id.
- `@caelush/verification` can produce bounded evidence and verification
  results but cannot transition a Run to `COMPLETED`. Only Core/RunController
  owns that transition.

## Event V2 / Phase 6A–6G

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
- Phase 6C owns the safe public projection, SSE, and client cutover. Phase 6D
  makes Run and Tool authority transactions the only durable event writers:
  durable drafts and their underlying truth commit together, then
  `RunEventNotifierPort.notifyCommitted` is called with post-commit events.
  `RunEventHub` has no write authority. Phase 6E owns non-persistent transient
  model/Tool/Runtime signals. Phase 6F owns generic Control Hooks and bounded
  Context Contributions. Phase 6G owns Coding Tool Guard and observation-backed
  Tool Feedback control pipelines; Phase 6H package retirement is not started.

## Control Hooks / Phase 6F

- The daemon is the only production composition root. It constructs an empty
  immutable Control Hook registry and Context Contribution pipeline by default,
  and accepts typed host registrations without creating another Agent or Run
  state machine.
- Hook execution is serial, cancellable, timeout-bounded, reentrancy-protected,
  and receipt-producing. Required failures fail closed according to the
  operation policy; optional failures continue with safe bounded diagnostics.
- Agent `ContextContribution` values are generic and bounded. Core maps them
  into Context items; Context redacts secrets and rejects host paths before
  rendering a dedicated `<context_contributions>` system block included in the
  existing budget. Contributions are not durable conversation records, events,
  provider-native messages, or a second prompt authority.
- `EXECUTE`/`RECOVER` is the durable Run mode and must remain distinct from
  Context's `NORMAL`/`FORCED_RECOVERY` preparation mode. Recovery reuses a
  validated `SNAPSHOT` artifact and fails closed if it is missing, mismatched,
  or corrupt; it never silently reruns a non-replayable Hook. `RECOMPUTE` is
  allowed only through explicit host policy.

## Tool Control / Phase 6G

- `@caelush/coding-agent` owns the specialized `BeforeToolDispatch` Guard and
  `ToolFeedbackContribution` pipelines. Both reuse the generic Agent
  `ControlHookRunner`; they do not create a plugin registry, HTTP hook API, or
  second Tool lifecycle.
- `ToolAdmissionRequest` remains the exact five-field closed contract. Guard
  mode and cancellation use the separate transient
  `ToolAdmissionEvaluationContext`; raw arguments never enter a Guard hook.
- Guard input uses a SHA-256 fingerprint of prepared canonical arguments and
  a dedicated bounded safe-facts projection. Guard restrictions combine as
  `PASS < REQUIRE_APPROVAL < BLOCK`, while Core Security still evaluates every
  non-blocking result. Guard approval restrictions enter the existing opaque
  approval identity; empty/PASS-only Guard behavior preserves the legacy key.
- Fresh `REQUESTED` admission uses `EXECUTE`; approved `WAITING_APPROVAL`
  recovery re-enters admission with `RECOVER`; durable `RUNNING` and terminal
  invocations never rerun Guard or Tool execution.
- Tool Feedback runs only for real `OBSERVATION` outcomes, after the built-in
  bounded model-feedback projector and before the existing batch normalizer.
  Rejected, skipped, synthetic, external, and legacy results retain built-in
  feedback. Contributions have independent byte/count budgets and pass the
  daemon's existing secret-redaction and terminal-output sanitizers.
- Feedback hooks may change only model-visible content. Tool identity,
  observation provenance, ToolInvocation/ToolObservation truth, and effects
  remain unchanged; `fingerprintProjection` is recomputed for final content.
  Required failures reuse the existing Tool infrastructure-failure path, while
  optional failures skip safely. Receipts are diagnostics, not RunEvents.

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
- `conversation.message.committed` is a durable metadata-only commit fact with
  exactly `messageId`, `conversationTurnId`, and `messageType`; it never copies
  `AgentMessageRecord` content and is committed atomically with the record.

## Durable execution rules

- Run creation is not Run execution. Do not publish `run.started` for a
  `PENDING` Run.
- Durable events may be written only inside the authoritative Run or Tool state
  transaction. Do not add standalone durable event append APIs or write a
  state change and its event in a second transaction.
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
