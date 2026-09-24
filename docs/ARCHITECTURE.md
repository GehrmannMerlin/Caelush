# Caelush Architecture

This document is the high-level architecture source of truth for the current
repository. It describes the code that is present in the canonical `main`
line, not an aspirational product design. When this document conflicts with an
older report, the source code, package manifests, architecture gates, and
tests win in that order.

## System overview

Caelush is a local-first, durable coding-agent runtime. A user-facing host
submits a Session or Run request to the local daemon. The daemon composes one
shared Agent Kernel with the AI, Context, Coding Agent, Runtime, Security,
Storage, Events, and Verification packages. The Kernel owns execution
semantics; CLI and Web render projections of the resulting Protocol contracts
and the migration-compatible AgentEvent/RunEvent stream.

```text
CLI / Web / future hosts
          │  HTTP + SSE through @caelush/client
          ▼
Local daemon (the only production composition root)
          │
          ├── @caelush/core + @caelush/agent
          ├── @caelush/ai + @caelush/context
          ├── @caelush/coding-agent + @caelush/runtime
          ├── @caelush/security
          ├── @caelush/storage + @caelush/events
          └── @caelush/verification
```

The daemon binds to loopback by default. HTTP routes remain transport adapters:
they validate DTOs, call an application port, and project safe Protocol data.
They do not create another AgentLoop, execute a Tool, or maintain a second Run
state machine.

## Applications

| Application     | Responsibility                                                                                  | Explicitly not its authority                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/daemon`   | Local service lifecycle, dependency composition, HTTP routes, SSE, and public projections       | A second Agent implementation, provider registry, Tool executor, or UI state machine |
| `apps/cli`      | Interactive terminal presentation, input routing, reconnect/recovery UX, and typed client calls | Core, Runtime, Storage, Security, Provider, or Tool execution                        |
| `apps/web`      | Browser presentation, session UI, timeline projections, and typed HTTP/SSE client usage         | Node Runtime, Agent execution, persistence, or permission decisions                  |
| `apps/launcher` | Product startup, daemon discovery, version checks, leases, and process hand-off                 | Agent semantics, Tool execution, Storage ownership, or Provider work                 |

The daemon owns one process-scoped composition. The CLI and Web may have
different presentation models, but their execution facts come from the same
durable Run and AgentEvent contracts.

## Package responsibilities

| Package                  | Current authority                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@caelush/protocol`      | JSON-safe IDs, entities, schemas, API DTOs, Run/Tool/Approval/Verification contracts, and the canonical JSON-safe RunEvent domain, version-aware registry, and static event catalog. It is a low-level contract package.                                                                                                       |
| `@caelush/ai`            | Provider-independent model domain, model descriptors, AI messages/tools, gateway lifecycle, adapters, stream validation, usage, and secret-safe AI errors. It does not know Runs or local Tools.                                                                                                                               |
| `@caelush/agent`         | General Agent Kernel contracts and implementation: AgentLoop, decisions, durable message domain, Tool registry/batch pipeline, Run execution ports, Agent-owned DurableRunEventDraft/RunEventNotifierPort contracts, continuations, and recovery-facing data structures. It does not know concrete filesystem Tools or SQLite. |
| `@caelush/core`          | RunController and canonical lifecycle coordination: state transitions, durable Run/State/Step/Continuation commits, model-turn and Tool-turn boundaries, resource governance, and completion authority.                                                                                                                        |
| `@caelush/context`       | Workspace/project discovery, instructions, relevant-file planning, memory/context runtime coordination, and bounded model-input construction. It does not own provider invocation.                                                                                                                                             |
| `@caelush/coding-agent`  | Coding composition layer and the single source of truth for built-in coding Tool definitions, operations adapters, Tool metadata, effects, output bounds, and coding prompt guidance.                                                                                                                                          |
| `@caelush/runtime`       | Replaceable execution substrate. The current `LocalRuntime` owns workspace containment, bounded filesystem access, verified patching, shell/process sessions, and read-only Git operations.                                                                                                                                    |
| `@caelush/security`      | Permission/capability policy, Tool execution gate, approval identity, sensitive-path and command policy, secret detection/redaction, and safe Tool-result presentation. It does not execute commands.                                                                                                                          |
| `@caelush/storage`       | SQLite opening/migrations and repositories for Protocol entities, Run execution snapshots, durable messages, Tool lifecycle, Verification, budgets, and durable events. Database rows do not become a second public state model.                                                                                               |
| `@caelush/events`        | Transitional compatibility/runtime package for the existing durable event aliases and EventBus replay/live-watch behavior. It is not the Phase 6A RunEvent domain authority.                                                                                                                                                   |
| `@caelush/verification`  | Verification planning, bounded evidence, project checks, change/task review, repair workflow, freshness/integrity checks, and Verification results. It can provide evidence but cannot complete a Run.                                                                                                                         |
| `@caelush/client`        | Browser/host-safe HTTP and SSE transport plus client-side projections.                                                                                                                                                                                                                                                         |
| `@caelush/memory`        | Provider-independent memory records, sensitivity validation, and memory-store contracts used by Context composition.                                                                                                                                                                                                           |
| `@caelush/shared`        | Small dependency-free shared boundary utilities such as path containment and project exclusions.                                                                                                                                                                                                                               |
| `@caelush/observability` | Reserved observability package boundary; it currently exports no production API.                                                                                                                                                                                                                                               |

## Dependency direction

The repository uses a monorepo package graph, not a single flat application.
Applications depend on packages. Packages do not depend on application
internals, and cross-package imports use each package's public `src/index.ts`
entry point rather than `@caelush/*/src/...` or private relative paths.

The current manifest graph is intentionally explicit:

```text
apps/launcher ──▶ apps/cli, apps/web/client boundary, apps/daemon, protocol
apps/cli     ──▶ client, protocol
apps/web     ──▶ client, protocol
apps/daemon  ──▶ all production composition packages

agent        ──▶ ai, protocol
coding-agent ──▶ agent, ai, runtime, protocol
context      ──▶ ai, protocol, security, shared
core         ──▶ agent, ai, context, protocol, verification
runtime      ──▶ protocol, shared
security     ──▶ agent, coding-agent, protocol, runtime
storage      ──▶ agent, core, events, memory, protocol, runtime, verification
events       ──▶ protocol
verification ──▶ protocol
```

`@caelush/protocol` and `@caelush/ai` remain independent contract roots in
their respective domains. Protocol values stay JSON-safe and must not leak
Provider SDK, database, Runtime, or UI types.

## Agent Kernel and Run lifecycle

`@caelush/agent` owns the general decision boundary. A settled model turn
produces either a Tool-call decision or a final candidate. The Agent Kernel
does not call a concrete Tool, Runtime, Storage service, or Verification
executor. Tool execution is coordinated outside the loop through the canonical
Tool pipeline.

`@caelush/core` owns Run lifecycle orchestration. A Run moves through the
canonical Run State Machine, and Run/State/Step/Continuation/Conversation
changes plus durable lifecycle events are committed as one durable boundary.
Creating a `PENDING` Run is not execution and does not publish `run.started`.
The final model answer is a candidate and enters verification; it is not a
direct `COMPLETED` transition.

The normal execution shape is:

```text
create or recover Run
        ↓
prepare bounded Context
        ↓
one provider turn → Agent decision
        ├── Tool calls → registry → admission/security → Dispatcher/runtime
        │                  → observation → durable Tool result → next turn
        └── final candidate → Verification boundary
                                      → Completion Authority
```

Recovery resumes only from durable recovery boundaries. Stale in-flight work
fails closed where its side-effect boundary cannot be proven; it is not
silently resent.

## AI and provider boundary

`@caelush/ai` is the single model invocation authority. The gateway owns the
Caelush call identity and receives the Run-owned abort context. A provider
adapter performs one provider turn, validates every stream event, drops raw
reasoning content, and returns provider-independent AI contracts.

Provider credentials are runtime-only. Provider SDK types, raw SSE, prompts,
credentials, and hidden chain-of-thought do not cross public Caelush
contracts. Gateway retry, Tool execution, and Run policy are owned elsewhere.

The legacy model-invocation and conversation package has been retired. The AI
package owns provider-neutral model messages and invocation; historical Message
V2 parsing is private to the Storage migration finalizer and is not a runtime
package boundary.

## Tool and Coding Agent boundary

The immutable Tool registry is the source of truth for both model-visible
definitions and executable handlers. A registration binds one data-only Tool
definition to one handler. Schema validation is compiled at registry build
time; Tool execution is always reached through the Dispatcher and its durable
invocation lifecycle.

`@caelush/coding-agent` owns the current built-in coding catalog and the
operation adapters for `read_file`, `list_directory`, `find_files`,
`search_text`, `apply_patch`, `exec_command`, `write_stdin`, `git_status`, and
`git_diff`. It does not create a second AgentLoop or bypass the Dispatcher.

The Runtime implementation is injected behind data-only workspace/runtime
references. Tool output is split into model-facing bounded content and
structured runtime/UI details. An uncertain side-effect boundary is durable
and fail-closed; later Tool calls in that batch are skipped rather than
pretending execution is known.

## Runtime and Security

Runtime is an execution substrate, not an authorization layer. The local
Runtime enforces workspace-relative paths, lexical and realpath containment,
bounded UTF-8 reads, deterministic discovery/search, verified patch commit,
managed process sessions, and read-only Git operations.

Security evaluates capabilities, permission profiles, risk, approvals, command
policy, sensitive paths, and secret-safe presentation before execution. It
does not execute files, spawn processes, write Storage, or publish Events.
Logical policy containment must not be described as an OS-level hard sandbox.

## Durable storage and events

Storage is initialized through an explicit SQLite path and committed migrations.
Repositories expose Protocol entities and codecs rather than database rows.
The event contract uses a durable monotonic sequence as the authoritative
order. Durable events are persisted before live subscribers are notified;
replay uses an exclusive cursor and joins live watch without duplication or
loss.

SSE maps durable event sequence to the SSE id. Ephemeral updates never receive
an SSE id. The daemon closes stream consumers before closing Storage during
shutdown. During Phase 6A the EventBus, SSE mapper, replay behavior, and
client Timeline remain the current runtime path.

## Phase 6A Event domain foundation

Phase 6A establishes the canonical event vocabulary without changing the
production delivery path:

```text
@caelush/protocol
  RunEvent / DurableRunEvent / TransientRunEvent
  version-aware static schema registry + event catalog
          │
          └── @caelush/agent
                DurableRunEventDraft
                RunEventNotifierPort
                DurableRunEventReaderPort

@caelush/events
  transitional EventBus + current replay/live runtime
```

`AgentEvent` remains a deprecated compatibility name while v1 event fixtures
continue to decode, including historical durable output events and the old
empty ephemeral metadata shape. New canonical transient metadata requires its
delivery class and stream identity. Durable sequence allocation remains a
Storage transaction responsibility.

`RunEventHub`, bounded subscriber queues and observer workers,
`PublicEventProjector`, SSE or Client migration, durable writer cleanup,
transient output/model signal wiring, and Control Hook pipelines are not part
of Phase 6A; they remain Phase 6B–6H work.

## Phase 5D Context and replay authority

The current Message V2 runtime cutover uses `AgentMessageRecord[]` as the
durable conversation representation at the Run execution boundary. Phase 5D
cuts the production Context and replay path over to semantic Agent-domain
snapshots:

```text
AgentMessageFactory
  → AgentMessageRecordDraft
  → RunExecutionStore atomic commit
  → SqliteAgentMessageRecordStore
```

Durable records are projected into model-facing AI messages only when Context
and the model-turn boundary need them. Synthetic system instructions, project
instructions, relevant-file context, and other prompt assembly data are not
written as ordinary durable conversation records. User, assistant, and
normalized Tool-result records are the durable conversation ledger.

The production input path is:

```text
AgentMessageRecord[]
  → Agent Conversation Repository/loader
  → AgentConversationSnapshot
  → AgentConversationValidator
  → ConversationSelector
  → AgentMessageProjectorRegistry
  → AIConversationMessage[] + Context material
  → PreparedModelContext
  → AIMessage[]
  → ModelTurnExecutor
```

`AgentTurnInput` is a durable-reference protocol: `USER_INPUT` carries a
`userMessageId`, `TOOL_RESULTS` carries `sourceStepId`, the pending decision,
and ordered `toolResultMessageIds`, and `CONTINUATION` carries only its reason
and optional durable message IDs. Execution units use durable IDs and source
step IDs rather than array positions. Only closed units are eligible for
selection compaction.

The validator is the production authority for record ordering, turn
boundaries, pending Tool agreement, and model-visible replay support. Unknown
model-visible schema or projection versions fail closed; there is no current
projector fallback. Historical Tool replay uses the stored projected content
and projection version, never a fresh raw observation projection. The selector
reports selected/dropped IDs, an AI-projection token estimate, and
`requiresCompaction`; it does not rewrite, summarize, or delete durable
records. Context owns materialization and has no Storage dependency.

The Phase 5F final cutover is complete: historical rows are deterministically
backfilled and validated before an atomic physical rebuild removes the
transitional columns. The daemon projects `AgentMessageRecord[]` into Protocol
`TranscriptEntry[]` through the server-side Agent projector registry at
`GET /api/v1/sessions/:sessionId/transcript`. CLI and Web require the additive
`sessionTranscript` capability and raise an explicit compatibility error when a
daemon cannot provide it. Legacy parsing and the old migration remain only as
upgrade history, never as a runtime read path.

Transcript and Timeline are separate projections:

```text
AgentMessageRecord[] → AgentMessage → AI projector        → model input
AgentMessageRecord[] → AgentMessage → Transcript projector → TranscriptEntry[]
AgentEvent[]         → host event reducer                  → Timeline
```

Transcript projection honors `audience.transcript`, emits only safe public
fields, and degrades unknown historical transcript-visible messages to a fixed
placeholder. It never serializes raw durable records or provider state.

## Verification and completion authority

Verification plans and bounded evidence are separate from model output. The
Verification subsystem may run deterministic project checks, inspect workspace
and Git freshness, review a change, and request bounded repair. A `PASS` is
necessary but not sufficient for completion.

Only Core/RunController may transition a Run to `COMPLETED`. Completion binds
the candidate, verification identity, evidence digest, workspace freshness,
optional Git freshness, and completion seal in one guarded durable commit.
VerificationRunner, the AgentLoop, Providers, Tools, Runtime, and UI may
produce evidence but never own final completion.

## Architecture V2 status

| Area                                            | Current status                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Architecture foundation and public boundaries   | Complete                                                          |
| AI domain and provider migration                | Complete in the current composition                               |
| Agent Kernel and durable Run boundaries         | Complete in the current composition                               |
| Tool System and Coding Agent composition        | Complete in the current composition                               |
| Message domain and storage foundation (5A/5B)   | Complete                                                          |
| Durable conversation runtime cutover (5C)       | Complete; `AgentMessageRecord` is the Run boundary authority      |
| Context and replay cutover (5D)                 | Complete                                                          |
| Phase 5E transcript/client projection migration | COMPLETE; daemon-owned Protocol Transcript projection             |
| Legacy Message V2 retirement (5F)               | COMPLETE; final schema, backfill, and runtime cutover             |
| Event domain and Protocol foundation (6A)       | COMPLETE; canonical contracts, registry, catalog, and Agent ports |
| Event runtime/control-plane migration (6B–6H)   | NOT STARTED; current EventBus/SSE path remains transitional       |

The phase table records the current Architecture V2 migration lines. Existing
Runtime, Security, Verification, CLI, Web, and daemon layers are documented as
current code above; they are not an invitation to reopen completed phases or
to implement the pending Event System phases in this task.

## Explicit non-goals and future boundaries

The current architecture must not be described as already providing:

- production MCP, Skills, Browser Agent, Computer Use, Web Search, or Multi-Agent;
- true parallel Tool execution;
- an OS-level hard sandbox or universal process-tree termination;
- a provider-specific public SDK or raw model chain-of-thought surface.

Those capabilities require new contracts and deliberate future work. The Event
runtime fan-out, public projection, transient signal cutover, and Control Hook
work likewise remain outside the completed Phase 6A foundation.

## Reference material

`README.md` is the project-facing introduction and quickstart. This file is
the high-level architecture authority. The smaller `docs/architecture/*.md`
pages retained in this repository are detailed references used by current
architecture checks and host documentation; they must agree with this file and
the source tree. Temporary plans, task reports, blocked evidence, and
Superpowers working artifacts are not repository documentation.
