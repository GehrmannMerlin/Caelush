# Production Daemon Composition

Phase 12A turns the daemon from a CRUD/event service into the Caelush Local Agent
Service. It owns the process-scoped composition root and exposes the existing Agent
Kernel through a small HTTP control plane and the durable AgentEvent stream. The
daemon is an application adapter; it does not become a second implementation of
Core, Tools, Runtime, LLM, Approval, or Verification.

## Why the daemon owns the Kernel

There is one AgentLoop and one RunController for a daemon process. Core owns Run
state transitions, durable checkpoints, cancellation, retry, timeout, budget,
approval, verification, and terminal completion. HTTP routes only validate transport
input, call a daemon-owned port, and serialize a public Protocol projection.

This keeps the authority graph explicit:

```text
CLI / Web / other clients
          │ typed HTTP + SSE
          ▼
     Fastify daemon
          │ actions and event watch
          ▼
 RunExecutionSupervisor ───────┐
          │ one driver per Run  │
          ▼                     │
     RunController              │
          │                     │
          ├─ AgentLoop → LLMGateway → ProviderRegistry
          ├─ ToolBatchCoordinator → secure Dispatcher → ToolRegistry
          ├─ Verification planner/runner and Completion Authority
          ├─ shared LocalRuntime / RuntimeResolver
          └─ shared SQLite Storage + EventBus
```

Clients never import `@caelush/core`, `@caelush/runtime`, `@caelush/storage`,
`@caelush/security`, or Tool internals. They observe the Protocol entities and
events that the daemon has already validated and committed.

## Process-scoped singleton composition

`composeDaemon()` creates one graph for the lifetime of a daemon handle:

- one opened `CaelushStorage` lifecycle and one `EventBus` over its durable event
  store;
- one `LocalProcessManager` held by one `LocalRuntime`, plus one runtime resolver;
- one immutable built-in `ToolRegistry`, one secure Dispatcher, and one
  `ToolBatchCoordinator`;
- one `LLMProviderRegistry`, one `LLMGateway`, and one narrow provider-independent
  `AgentLLMClient` passed into Core;
- one Context inspector, relevant-file planner, ContextBuilder, and `AgentLoop`;
- one set of Core scope, deadline, and retry registries;
- one real Approval/Budget/Verification composition wired to the same Storage and
  Runtime ports;
- one `RunController` and one `RunExecutionSupervisor`;
- one Fastify app and one lifecycle handle.

The daemon app remains dependency-injected so route and transport tests can use
small fakes. The production `startDaemon()` path supplies the complete graph. A
route never constructs `RunController`, `AgentLoop`, `LocalRuntime`,
`ToolDispatcher`, or `LLMGateway`.

## Run creation is separate from execution

`POST /api/v1/sessions/:sessionId/runs` only validates and persists a `PENDING`
Run. It does not create an AgentState, call a provider, execute a Tool, or publish
`run.started`.

Execution begins only after an explicit action:

- `POST /api/v1/runs/:runId/start` accepts a pending Run and schedules
  `RunController.start()` in the background. It returns `202` with `SCHEDULED` and
  never holds the HTTP request open for the complete Agent lifecycle.
- `POST /api/v1/runs/:runId/recover` schedules `RunController.recover()` for a
  non-pending, non-terminal durable boundary. A pending Run is a conflict; a
  terminal Run is a safe no-op.
- `POST /api/v1/runs/:runId/cancel` calls `RunController.cancel()` directly. It
  does not wait behind the normal execution driver, preserving Phase 10A's
  durable first-writer-wins cancellation intent and abort semantics.

The response disposition is daemon transport metadata, not a second Run state
machine: `SCHEDULED`, `ALREADY_ACTIVE`, `NOOP_TERMINAL`, or `SETTLED`. The returned
Run is reloaded/projected from durable state and never serializes an internal
`RunControllerResult`.

## RunExecutionSupervisor

The supervisor is process-local coordination only. SQLite remains the source of
truth. It maintains at most one opaque, token-protected background driver per Run
ID, registers ownership before starting the promise, catches background rejection,
and removes only the matching task token. It never changes Run status and never
executes a Tool or Verification check itself.

Start, recovery, and post-approval continuation are background operations. A
duplicate action for an already active Run is deduplicated. Approval resolution
first validates Run state, Approval ownership, and scope; then it delegates to
`RunController.resolveApproval()`. The HTTP route never edits an Approval row.

## Provider and credential boundary

The public model selection is exactly `{ provider, model }`. `baseUrl`, headers,
API keys, query parameters, and arbitrary provider settings are not Protocol client
input. The daemon startup adapter may read provider configuration from environment
variables or programmatic test options and creates the configured adapter in the
composition root. The internal `ModelRef` may contain the server-owned endpoint,
but all Session/Run responses and `/api/v1/info` use endpoint-free public
projections.

The daemon reports only configured provider IDs and an optional public default
model. Credentials, endpoint URLs, raw provider errors, and provider request data
never enter Protocol entities, events, logs, or API error messages. A client-supplied
endpoint is rejected by the strict request schema before provider transport can run.
Unknown providers and disallowed models fail as a bounded
`MODEL_PROVIDER_UNAVAILABLE` error; a no-provider daemon remains inspectable but
cannot silently invent a provider.

V1 is loopback-only. `startDaemon()` accepts only `127.0.0.1`, `localhost`, or
`::1`, and the request guard does not trust forwarded headers. Phase 12A does not
add CORS, network authentication, provider CRUD, or remote runtime configuration.

## Event observation

The event route consumes `EventBus.watch()` for both exclusive durable replay and
the live tail. It does not reconstruct state from HTTP polling or maintain another
replay implementation. Durable event sequence is the SSE `id` and ephemeral events
have no SSE ID. `afterSequence` and `Last-Event-ID` must agree when both are sent.

This means the client can observe the same committed lifecycle that Core settled:
Run start, provider attempts, Tool and file effects, approval transitions,
verification checks, cancellation, retry, timeout, and final completion. Durable
events are persisted before notification, so closing and reopening the daemon does
not replace the SQLite chronology with timestamps or process memory.

## Lifecycle and disposal

Startup is ordered as storage/migrations, EventBus, Runtime/provider/Tool/security/
Verification/Core composition, supervisor, Fastify app, and listener. A failed
startup closes already-open resources before rethrowing.

Shutdown is idempotent. The handle first aborts active SSE streams and closes the
HTTP app, then cancels active RunController scopes through the Phase 10A path,
drains the supervisor, disposes Core deadline/retry registries and Runtime-owned
resources, and closes Storage last. No background driver is allowed to continue
writing after Storage closes. The implementation is cooperative and process-local;
it does not claim universal OS process-tree termination or a hard sandbox.

## Research boundary

The action/event separation is consistent with public agent-service patterns such as
the [OpenAI Codex app-server client README](https://github.com/openai/codex/blob/main/codex-rs/app-server-client/README.md)
and its [public V2 turn-start tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/turn_start.rs).
The distinction between foreground control and explicit resume/background behavior
was also compared with the [Anthropic Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage).
These are public semantic references only. Caelush copied no private protocol,
session ID, CLI flag, UI, or provider implementation from them.

## Phase 12A boundary

This document stops at the production daemon execution surface and shared client
transport. It does not introduce Ink/React UI, a conversation composer, approval
prompts, resume pickers, timeline/diff renderers, Web UI, WebSocket, MCP, Browser or
Computer Use, remote/Docker Runtime, auth, CORS, automatic client reconnect, or a
new Core/Tool/Runtime/Provider state machine. Those remain later Phase 12 work.
