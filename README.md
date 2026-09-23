<div align="center">

# Caelush

**A local-first, durable coding-agent runtime with a shared CLI/Web kernel.**

Build coding agents around durable Runs, explicit Tool boundaries, replaceable
Runtime execution, recovery, security policy, and verification.

</div>

Caelush is a TypeScript/Node.js monorepo for a local coding-agent runtime. It
is designed around one shared Agent Kernel: CLI, Web, and future hosts are
clients of the same execution authority rather than separate Agent
implementations.

The project is in active Architecture V2 development. The current Message
System migration is complete through Phase 5E. The daemon now owns the
server-side Transcript projection and CLI/Web consume the Protocol Transcript;
Phase 5F legacy retirement remains future work.

## What Caelush provides

- A durable Session/Run lifecycle with explicit state transitions and recovery
  boundaries.
- A provider-neutral AI layer with one gateway-owned model-turn boundary.
- A shared Agent Kernel for CLI, Web, and future hosts.
- A single immutable Tool catalog and Dispatcher path for schema validation,
  security admission, execution, observation, and settlement.
- A replaceable local Runtime for workspace-relative filesystem access, verified
  patching, managed shell/process sessions, and read-only Git operations.
- Separate Security and Runtime boundaries for permissions, approvals,
  capability policy, command policy, secret-safe presentation, and containment.
- Durable events with ordered replay and live watching for host projections.
- Verification and Completion Authority so a model's final text is a candidate,
  not proof that a task is complete.

## Why this architecture

Coding agents combine model calls, context, tools, local processes, user
approval, persistence, and UI state. If those responsibilities are placed in
one application service, the result is difficult to test, recover, or replace.

Caelush keeps the authority graph explicit:

```text
CLI / Web / future hosts
            │
            ▼
Local daemon — the only production composition root
            │
            ├── Agent Kernel + RunController
            ├── AI + Context + Coding Agent
            ├── Security + replaceable Runtime
            ├── SQLite Storage + ordered Events
            └── Verification + Completion Authority
```

The daemon owns execution. The CLI and Web render safe Protocol projections
and AgentEvent streams. They do not construct their own AgentLoop, invoke a
provider directly, or execute local Tools.

## Architecture at a glance

The current high-level architecture is documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). It is based on the current
package manifests, production composition, source contracts, architecture
guards, and tests.

```text
Host
  ↓ HTTP / SSE through @caelush/client
Daemon
  ↓ dependency injection
Core / Agent Kernel
  ├── one model turn → AI gateway → provider adapter
  ├── Tool decision → Registry → Security gate → Dispatcher → Runtime
  ├── durable records/events → SQLite + EventBus
  └── final candidate → Verification → Completion Authority
```

### Durable conversation

Phase 5D makes the durable conversation the production Context and replay
input at the Run execution boundary:

```text
AgentMessageFactory
  → AgentMessageRecordDraft
  → atomic RunExecutionStore commit
  → SQLite durable record
```

The production ledger contains user, assistant, and normalized Tool-result
records. System prompts, project instructions, relevant-file context, and
other synthetic model input are assembled for a turn but are not written as
ordinary conversation history. The production input path is:

```text
AgentMessageRecord[]
  → AgentConversationSnapshot
  → AgentConversationValidator
  → ConversationSelector
  → AgentMessageProjectorRegistry
  → PreparedModelContext
  → AIMessage[]
  → ModelTurnExecutor
```

`AgentTurnInput` carries durable message IDs and execution-unit references, not
provider-shaped AI message arrays. Historical Tool messages replay their
stored projection and projection version; a missing model-visible codec or
projector fails closed. Selection reports selected/dropped IDs, token estimate,
and compaction pressure without rewriting or deleting durable records.

Compatibility readers, physical columns, and the `@caelush/llm` schema surface
remain intentionally after the Phase 5E cutover. The normal client path is
`GET /api/v1/sessions/:sessionId/transcript`; Phase 5F will retire the
remaining legacy readers and physical schema only after a separate cutover.

The public conversation surfaces are deliberately separate:

```text
AgentMessageRecord[] → AgentMessage → AI projector → model input
AgentMessageRecord[] → AgentMessage → Transcript projector → Protocol TranscriptEntry[]
AgentEvent[]         → CLI/Web event reducer → Timeline
```

Transcript projection is audience-controlled: standard Tool results remain
model-visible but are not transcript-visible by default. Unknown historical
transcript-visible message types degrade to a fixed safe placeholder rather
than exposing stored payloads.

## Coding Tool surface

The current built-in coding catalog is composed by
`@caelush/coding-agent` and executed through the shared Tool pipeline:

```text
read_file       list_directory    find_files       search_text
apply_patch     exec_command      write_stdin
git_status      git_diff
```

Tool definitions are data-only. The registry derives the model catalog and
runtime resolution from the same registrations. The Dispatcher persists the
invocation lifecycle before the handler runs, and uncertain side effects fail
closed rather than being silently retried.

## Security and verification boundaries

Security policy and Runtime execution are separate concerns. The local Runtime
enforces workspace containment, bounded I/O, patch guards, process/session
ownership, and read-only Git behavior. Security evaluates capabilities,
permission profiles, approval policy, sensitive paths, command policy, and
secret-safe output. The current local boundary is a logical policy boundary,
not an OS-level hard sandbox.

Verification collects bounded evidence and checks the candidate against the
workspace and, where applicable, Git freshness. Only Core/RunController owns
the final `COMPLETED` transition.

## Quick start

Requirements:

- Node.js 24.x
- pnpm 11.x

```bash
git clone https://github.com/GehrmannMerlin/Caelush.git
cd Caelush
pnpm install --frozen-lockfile
pnpm build
```

Configure a provider in the daemon environment. Provider credentials remain on
the daemon host and are never passed through CLI/Web request payloads.

```powershell
$env:CAELUSH_PROVIDER_ID = "openai-compatible"
$env:CAELUSH_PROVIDER_BASE_URL = "https://your-provider.example/v1"
$env:CAELUSH_PROVIDER_API_KEY = "<your-api-key>"
$env:CAELUSH_DEFAULT_PROVIDER = "openai-compatible"
$env:CAELUSH_DEFAULT_MODEL = "<your-model>"
```

Start the local service in one terminal:

```bash
pnpm --filter @caelush/daemon start
```

Then start the terminal client in another:

```bash
pnpm --filter @caelush/cli start
```

The daemon uses the current working directory as the default workspace. Set
`CAELUSH_WORKSPACE_PATH` when the service should operate on a different
workspace. `CAELUSH_DAEMON_URL` selects a non-default daemon endpoint for a
client host.

The Web package can be built with:

```bash
pnpm --filter @caelush/web build
```

The daemon can serve a built Web bundle when `CAELUSH_WEB_BUILD_ROOT` points to
that output directory.

## Host behavior

The production host layers are deliberately thin:

- The daemon is the Local Agent Service and the only composition root.
- The launcher handles local discovery, startup leases, diagnostics, and
  process hand-off.
- The CLI provides interactive prompts, Session selection, Run recovery,
  approvals, and a bounded live timeline.
- The Web client consumes the same Session, Run, context-usage, and event
  projections.
- `Ctrl+D` detaches the CLI host; it does not erase durable Session or Run
  state.

The CLI timeline keeps settled history in `displayHistory` and renders
`WAITING_APPROVAL` as a control state. Transport recovery uses durable event
`afterSequence` cursors; presentation code does not invent execution facts.

## Repository structure

```text
Caelush/
├── apps/
│   ├── daemon/       Local Agent Service and composition root
│   ├── cli/          Ink terminal client
│   ├── launcher/     Product startup and daemon discovery
│   └── web/          React/Vite browser client
├── packages/
│   ├── agent/        General Agent Kernel and Tool orchestration
│   ├── ai/           Provider-neutral AI domain and gateway
│   ├── client/       HTTP/SSE client and host projections
│   ├── coding-agent/ Coding Tools and coding composition
│   ├── context/      Workspace intelligence and context building
│   ├── core/         Run lifecycle and Completion Authority
│   ├── events/       Durable event contract and EventBus
│   ├── llm/          Message/turn compatibility boundary
│   ├── memory/       Memory records and store contracts
│   ├── observability/Observability package boundary
│   ├── protocol/     Stable JSON-safe cross-package contracts
│   ├── runtime/      Local execution substrate
│   ├── security/     Policy, approval, and secret-safe presentation
│   ├── shared/       Small dependency-free utilities
│   ├── storage/      SQLite repositories and durable adapters
│   └── verification/ Evidence and completion checks
├── docs/
│   └── ARCHITECTURE.md
├── scripts/          Architecture, release, and integration checks
├── tests/            Architecture guards and integration tests
├── AGENTS.md         Repository coding-agent contract
├── package.json
├── pnpm-lock.yaml
└── pnpm-workspace.yaml
```

Cross-package production imports use public package entry points. The
architecture gates reject private `src` imports, reverse app dependencies, and
other boundary violations.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm check:architecture:ci
pnpm check
```

`pnpm check` is the full repository check and includes build, typecheck, lint,
tests, and formatting. For a documentation-only change, start with
`pnpm check:architecture:ci`, targeted tests, `git diff --check`, and the
relevant Prettier check.

## Architecture V2 status

The repository also records the completed host-boundary work that remains relevant to the current
runtime: Phase 9C sanitizer injection, Phase 9D — V1 Security Integration, Phase 11B — Verification Execution: **COMPLETED**, and Phase 11D — Completion Authority & Finalization: **COMPLETED**.

| Migration boundary                                      | Status      |
| ------------------------------------------------------- | ----------- |
| Phase 1 — architecture foundation and public boundaries | Complete    |
| Phase 2 — AI domain and provider migration              | Complete    |
| Phase 3 — Agent Kernel and durable Run boundaries       | Complete    |
| Phase 4 — Tool System and Coding Agent composition      | Complete    |
| Phase 5A — Message domain foundation                    | Complete    |
| Phase 5B — Message storage foundation                   | Complete    |
| Phase 5C — durable conversation runtime cutover         | Complete    |
| Phase 5D — Context & replay cutover                     | Complete    |
| Phase 5E — transcript/client projection migration       | COMPLETE    |
| Phase 5F — legacy Message V2 retirement                 | NOT STARTED |

The status table is specifically the Message System migration boundary. The
repository also contains the current Runtime, Security, Verification, daemon,
CLI, and Web layers described above; this page does not claim that future
Message V2 phases have begun.

## Current limitations and roadmap

Caelush is not presented as a frozen public SDK or a universal sandbox. The
following remain future boundaries or explicit limitations:

- Message V2 Phase 5F legacy schema/reader retirement.
- Production MCP integration, Skills, Browser Agent, Computer Use, and Web
  Search.
- Multi-Agent/Sub-Agent orchestration and true parallel Tool execution.
- OS-level hard sandboxing and universal process-tree termination.
- A stabilized public SDK and compatibility promise across releases.

Future work must preserve the shared Kernel, daemon composition root, durable
first ordering, Protocol-only public contracts, and verification-gated
completion model.

## Documentation

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the current system
truth. `AGENTS.md` contains the repository development contract. Temporary
plans, task reports, blocked evidence, and coding-session notes are not part of
the public documentation surface.
