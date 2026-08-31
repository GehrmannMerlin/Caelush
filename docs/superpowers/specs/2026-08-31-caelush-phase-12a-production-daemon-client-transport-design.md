# Caelush V1 Phase 12A — Production Daemon Execution Surface & Shared Client Transport Design

## Status and scope

This document records the approved Phase 12A design for Caelush V1. Phase 12A is the
production execution and transport surface only. It does not implement Phase 12B UI
or Ink, 12C remote/Docker runtime, 12D MCP/browser/computer-use, or 12E packaging and
release automation.

Phase 12 remains fixed to exactly 12A, 12B, 12C, 12D, and 12E. No additional Phase 12
round is introduced by this change.

The implementation starts from the sealed Phase 11D commit
`92d93982855569dff416cf5909806379e0685783` on
`codex/phase-11d-completion-authority-verification-recovery-finalization`, in the
dedicated worktree:

`D:/Develop/Caelush/.worktrees/phase-12a-production-daemon-client-transport`

The Phase 11D preflight was completed before this worktree was created. The remote
branch was fetched and verified as a normal descendant of the Phase 11C baseline,
the exact Phase 11D changed-file set was audited, the targeted Prettier repair was
applied only to the reported files, all Phase 11D regression checks passed, and the
sealed commit was pushed without force. The repository-wide formatting baseline at
the beginning of Phase 12A is 696 existing files reported by `pnpm format:check`.
Phase 12A must not increase that debt.

## Problem statement

The repository already has the durable Core execution authority and the local runtime
capabilities required for a V1 agent run, but the daemon currently exposes only
session/run CRUD and event streaming. Its factory does not compose the real Kernel,
Tool, Security, Runtime, Budget, Approval, Verification, and Provider layers. There
is also no shared typed client for CLI or future Web surfaces.

Phase 12A closes that gap while preserving the existing architecture:

* the daemon is the only local composition root;
* `RunController` remains the canonical run lifecycle authority;
* `EventBus.watch()` remains the only replay/live event source;
* Tools still execute only through Dispatcher and Batch Coordinator;
* the Local Runtime remains a replaceable execution substrate;
* providers receive only gateway-owned calls and credentials stay at the runtime
  boundary;
* the public API exposes provider/model selection, never provider endpoint details;
* the client validates all public responses and parses SSE incrementally without
  introducing a Node-only dependency.

## Existing architecture characterization

### Current daemon surface

`apps/daemon/src/app.ts` currently constructs Fastify, installs the loopback request
guard, error handler, health/session/run routes, and the existing event stream route.
It receives repositories and an `EventBus` through `DaemonDependencies`; it does not
create an `AgentLoop`, `RunController`, Tool Dispatcher, Runtime, Provider Registry,
or Verification runner.

`apps/daemon/src/daemon.ts` opens one `CaelushStorage`, creates one `EventBus`, starts
Fastify, and closes active SSE streams before closing the app and storage. Its logger
option is currently unused.

### Existing Core authority

`packages/core/src/run-controller.ts` already owns:

* canonical start/recover/approval/cancel orchestration;
* the normal per-run execution lock;
* the Phase 10A cancellation intent and abort ordering;
* Phase 10B deadline and timeout settlement;
* durable Run/State/Step/Conversation/Continuation/event commits;
* Tool batch and Verification boundaries;
* terminal status authority, including `VERIFYING` and completion verification.

The daemon must call these methods and must not mutate Run status or storage rows to
simulate execution.

### Existing durable infrastructure

`openCaelushStorage()` already creates one lifecycle containing session/run/state/
conversation/continuation/event/execution/tool/approval/cancellation/budget/
verification repositories. `EventBus.watch()` subscribes before replay, replays using
exclusive per-run durable sequence cursors, then drains buffered live events. The SSE
route already maps durable sequence to SSE `id` and omits `id` for ephemeral events.

### Existing runtime and security infrastructure

`LocalRuntime` owns one `LocalProcessManager` when constructed with an injected
manager, and exposes filesystem, patch, exec, and Git scopes from a workspace. The
Phase 8 built-in catalog is produced by
`createDefaultBuiltinToolRegistrations(runtimeResolver)`. The security package's
`createV1SecureToolDispatcher()` supplies the real execution gate and result
sanitizer, while the dispatcher remains the single invocation boundary.

The production composition therefore constructs exactly one `LocalProcessManager`,
injects it into exactly one `LocalRuntime`, derives one `RuntimeResolver`, builds one
immutable Tool Registry from that resolver, and wraps one Dispatcher with the real
security composition. Tool and Verification execution both receive scopes from that
same Local Runtime.

### Existing Provider and context infrastructure

`LLMProviderRegistry` is mutable only during composition, rejects duplicate provider
IDs, and resolves providers by ID. `LLMGateway` owns `LLMCallId` creation, semantic
validation, abort/timeout mapping, and validated provider stream handling. The
OpenAI-compatible adapter already accepts server-side `baseURL`, credentials, and
model allowlists. `AgentLoop` accepts only a narrow provider-independent
`AgentLLMClient` port plus injected ProjectInspector, RelevantFilePlanner,
ContextBuilder, clock, and Step ID factory.

Production composition uses these public ports and does not let AI SDK types escape
the provider adapter.

## External implementation research

Research was performed against official primary sources on 2026-08-31. These sources
were used for implementation patterns, not as a reason to copy another product's
protocol.

| Source | Observed pattern | Adopted in Caelush | Rejected or constrained |
| --- | --- | --- | --- |
| [OpenAI Codex app-server client README](https://github.com/openai/codex/blob/main/codex-rs/app-server-client/README.md) | A shared client centralizes bootstrap, typed transport, caller identity, and graceful shutdown; callers should not duplicate request plumbing. | `@caelush/client` owns typed HTTP, response validation, SSE parsing, abort handling, and compatibility checks. | Codex's in-process typed channels and JSON-RPC envelope are not copied because Caelush's V1 boundary is HTTP + SSE and must remain usable by browser-like clients. |
| [OpenAI Codex app-server turn-start tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/turn_start.rs) | A start request returns an immediate acknowledgement while richer lifecycle notifications continue asynchronously; active-turn behavior is tested separately from request acknowledgement. | `POST .../start` returns 202 and a disposition; background execution is observed through durable Run state and SSE. | Codex-specific thread/turn/item method names and notifications are not imported into the Caelush protocol. |
| [OpenAI Codex app-server thread-resume tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/thread_resume.rs) | Resume is an explicit lifecycle operation and must reconcile persisted history/metadata before a later turn. | `POST .../recover` calls `RunController.recover()` and never invents a second recovery state machine. | File-rollout and Codex-specific thread metadata are outside the Caelush V1 contract. |
| [Anthropic Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage) | Public CLI surfaces distinguish continue/resume, background execution, model selection, permission mode, and structured streaming output. | Daemon actions distinguish start/recover/cancel/approval; model selection is public data and permissions remain server-enforced. | CLI flags, Claude session IDs, and product-specific permission names are not part of Caelush's protocol. |

The references support the separation of daemon lifecycle authority from client
presentation and transport. They do not establish compatibility with Codex or Claude
internals, and this implementation makes no claim to have inspected private source
code of those products.

## Design decisions

### 1. Composition boundary

Add a daemon-only composition module, separate from route registration. It builds:

1. one storage lifecycle;
2. one EventBus over the storage event store;
3. one `RunExecutionScopeRegistry`, one `RunDeadlineRegistry`, and one
   `RunRetryRegistry` injected into one `RunController`;
4. one `LocalProcessManager`, one `LocalRuntime`, and one runtime resolver;
5. one immutable built-in Tool Registry;
6. one secure Tool Dispatcher and one Tool Batch Coordinator;
7. one Provider Registry and one Gateway-backed `AgentLLMClient`;
8. one AgentLoop using the existing Context ports;
9. one real Verification planner/runner/profile/command/security/evidence wiring;
10. one `RunExecutionSupervisor` used by the daemon action routes;
11. one Fastify app and one lifecycle handle.

`buildDaemonApp()` remains dependency-injected for focused route tests. It receives
the already-composed execution surface rather than constructing Core objects itself.
The old minimal test fixture remains valid when no execution surface is supplied;
the production `startDaemon()` path always supplies the real composition.

### 2. Provider credential and model boundary

Public create-session/create-run input is a strict `{ provider, model }` selection.
It has no `baseUrl`, credentials, headers, or arbitrary provider settings. The daemon
may canonicalize that selection to an internal `ModelRef` containing a configured
server-side endpoint, but public responses project it back to `{ provider, model }`.

Provider configuration is accepted only at the daemon startup boundary. Environment
variables are read by the command startup adapter, not by routes, Protocol, Core,
Client, or the LLM provider registry. Programmatic configuration is available for
tests. `/api/v1/info` reports provider IDs and a public default model only; it never
returns endpoint URLs, API keys, headers, or raw configuration.

An unconfigured model may be durably created for compatibility with the existing CRUD
surface, but starting it fails safely through the normal provider resolution path. A
client-supplied endpoint is rejected by strict schema validation before any provider
fetch can occur.

### 3. RunExecutionSupervisor

`RunExecutionSupervisor` is a small daemon-owned adapter around `RunController`:

* it tracks at most one background task per Run ID;
* it preflights current durable Run status before scheduling;
* it registers ownership before launching the promise;
* it invokes `RunController.start()` or `RunController.recover()` without awaiting it
  in the HTTP handler;
* it catches and logs background rejection using safe metadata;
* it removes the entry only if the map still contains the same task token;
* it exposes drain/dispose for lifecycle shutdown;
* it never writes Run status and never bypasses Core locks.

Start returns `SCHEDULED`, `ALREADY_ACTIVE`, or a terminal no-op disposition. Recover
rejects PENDING with 409, returns a terminal no-op for terminal Runs, and otherwise
uses the same deduplicated background path. Cancel is deliberately not queued behind
the supervisor: the route calls `RunController.cancel()` directly so Phase 10A's
durable first-writer-wins cancellation intent has priority over the active execution.

Approval resolution routes call `RunController.resolveApproval()` through the same
supervisor boundary. The route never edits an approval row directly. The existing
repository's same-resolution idempotency and conflict behavior is preserved.

### 4. HTTP routes

The existing CRUD and event paths remain intact. Add:

* `GET /api/v1/info`
* `POST /api/v1/runs/:runId/start`
* `POST /api/v1/runs/:runId/recover`
* `POST /api/v1/runs/:runId/cancel`
* `GET /api/v1/runs/:runId/approvals`
* `POST /api/v1/runs/:runId/approvals/:approvalId/resolve`

All action response bodies use strict Protocol schemas. Internal
`RunControllerResult` values are mapped to safe public dispositions and never
serialized directly. Every route preserves request IDs in sanitized API errors.

The daemon remains loopback-only. It does not add CORS or a network auth server.
The Host/Origin guard continues to reject non-loopback requests and does not trust
forwarded headers.

### 5. SSE and shared client

The daemon's event route continues to consume only `EventBus.watch()`. A durable SSE
event uses its per-run durable sequence as `id`; ephemeral events have no `id`. The
cursor is exclusive and `Last-Event-ID` plus `afterSequence` must agree when both are
present.

`@caelush/client` depends only on `@caelush/protocol` (and compile-time standard Web
types). It has no imports from Core, Runtime, Storage, Security, Tools, Context,
Verification, LLM, `node:*`, Fastify, or EventSource.

The client uses injected/global `fetch`, `Response.body`, `ReadableStream`, and
`TextDecoder`. Its parser handles LF, CRLF, CR split across chunks, UTF-8 split across
chunks, emoji, comments, multiline `data`, and event/id field ordering. It validates
each JSON payload with `AgentEventSchema`, rejects a mismatched run ID, rejects an
invalid/missing durable sequence identity, rejects an ephemeral SSE ID, and stops on
abort. It does not auto-reconnect; callers explicitly reuse the last durable sequence
with a new watch request.

HTTP responses, error envelopes, and `/info` compatibility fields are validated with
Protocol schemas. The client rejects a daemon with an unsupported API or protocol
version before exposing it to a caller.

### 6. Lifecycle order

Startup order is storage → EventBus → runtime/provider/tool/verification/Core
composition → supervisor → HTTP app → listener. If any step fails, already-open
resources are closed before the error is rethrown.

Shutdown is idempotent and ordered:

1. stop accepting new supervisor work;
2. abort active SSE streams;
3. stop/drain background RunController tasks;
4. dispose Core deadline/retry registries and Runtime-owned resources;
5. close Fastify;
6. close the single Storage lifecycle last.

No background task may continue writing after Storage closes.

## Error and security policy

The public error set is bounded and intentionally omits provider SDK text, raw SSE,
credentials, prompts, tool arguments, approval action secrets, and stack traces.
Unknown failures become `INTERNAL_ERROR`; missing rows become `NOT_FOUND`; conflicts
become `CONFLICT`; malformed public requests and cursors become `INVALID_REQUEST` or
`INVALID_EVENT_CURSOR`.

The `/info` payload is an allowlisted capability summary. Public Run and Session
projections never leak internal provider endpoints. Approval action data is returned
only through the existing bounded Protocol entity and is passed through the daemon's
public response schema; resolution is delegated to Core and the durable Approval
repository.

## Test strategy

Implementation follows red → green → refactor:

* Protocol tests first cover strict public model selection, public projections,
  `DaemonInfo`, action dispositions, approval list/resolve, and API errors.
* Supervisor tests cover immediate nonblocking start, per-run deduplication, terminal
  no-op, PENDING recover conflict, background rejection cleanup, token-safe cleanup,
  direct cancel, and drain.
* Daemon route tests cover all action status codes, unknown IDs, loopback/origin
  rejection, no provider fetch on client `baseUrl`, canonical model projection, and
  `/info` secret absence.
* Client tests cover every JSON method, error mapping, compatibility rejection,
  chunk-split UTF-8/SSE parsing, comments/multiline data, durable/ephemeral identity,
  run identity, abort, and no reconnect.
* Integration tests compose the real daemon with injected/fake provider transport and
  verify the request → background Kernel → durable status/event → client observation
  path without reimplementing Core transitions in the daemon.
* Architecture tests enforce package dependencies and the no-Node/no-runtime-import
  boundary for `@caelush/client`.

The full repository verification remains `pnpm check`. Because the repository already
has a 696-file format baseline, changed-file Prettier checks are also run separately
and the baseline is recorded rather than silently reformatted across the workspace.

## Non-goals and deferred work

This change does not add UI, Ink, WebSocket, remote runtime, Docker sandbox, MCP,
browser automation, computer use, process persistence, auth, CORS, retry policy,
secret redaction, new timeout/cancellation semantics, parallel tool execution,
Verification execution semantics, or a direct `COMPLETED` transition. It does not add
a new database table or event side channel for the supervisor or client.

## Self-review checklist

* Does the daemon own composition? Yes; app/CLI/Web receive ports and do not create an
  AgentLoop.
* Does Core remain the status authority? Yes; action routes call RunController only.
* Is provider credential access server-only? Yes; only startup composition creates
  provider adapters and public schemas omit endpoints.
* Is event replay authoritative? Yes; the route consumes EventBus.watch() and the
  client validates durable identities.
* Is shutdown storage-safe? Yes; supervisor/SSE consumers are stopped before Storage.
* Is the client transport-only? Yes; it imports Protocol only and uses Web APIs.
* Are future phases avoided? Yes; this design ends at the Phase 12A daemon/client
  boundary.

