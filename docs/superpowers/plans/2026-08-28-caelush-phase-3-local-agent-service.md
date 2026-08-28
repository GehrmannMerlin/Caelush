# Caelush Phase 3 Local Agent Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the single loopback-only Caelush Daemon with validated Session/Run JSON APIs and an EventBus-backed reconnectable SSE stream, without executing an Agent.

**Architecture:** Keep Protocol as the JSON-safe Zod contract source, Daemon as the only HTTP/lifecycle composition root, and inject Storage repositories plus EventBus into buildDaemonApp. Keep startDaemon responsible for Storage, EventBus, listen, and idempotent shutdown. Routes remain thin and Services remain Fastify-independent.

**Tech Stack:** TypeScript ESM, Node 24, pnpm 11, Fastify 5.12.1, @fastify/sse 0.6.0, fastify-type-provider-zod 7.0.0, Zod 4.4.3, existing SQLite Storage/EventBus, Vitest, ESLint, Prettier.

**Spec:** docs/superpowers/specs/2026-08-28-caelush-phase-3-local-agent-service-design.md

## Global Constraints

- Default host is 127.0.0.1, default port is 43120, tests may use port 0, and production port conflicts fail without automatic port drift.
- Do not add CORS, Swagger, React, Vite, Ink, Socket.IO, ws, AI SDK, dotenv, standalone Pino, EventSource, AgentLoop, Runtime execution, fake runtime, cancellation, approval, workspace browsing, or file endpoints.
- All API paths use /api/v1; Protocol Zod schemas are the single request/response source of truth; unknown mutation fields are rejected.
- buildDaemonApp never listens, reads process.env, opens Storage, or calls process.exit. Only main.ts owns signal and exit-code policy.
- Routes never access SQLite directly. SSE consumes EventBus.watch and never reimplements replay.
- Durable SSE id is String(event.durability.sequence). Ephemeral events and heartbeat frames never carry an id or replay.
- Run creation persists PENDING, does not start an Agent, change state, or publish run.started.
- Every behavior change uses RED, GREEN, REFACTOR and an observed failing test before production code.
- Cross-package imports use public entries only; packages never depend on apps/daemon; never push or use destructive Git commands.

---

### Task 1: Protocol API Contracts

Files:
- Create packages/protocol/src/api/common.ts, health.ts, session.ts, run.ts, event-stream.ts, index.ts.
- Modify packages/protocol/src/index.ts.
- Test packages/protocol/test/api.test.ts.

Interfaces:
- Export ApiErrorCodeSchema, ApiErrorSchema, ApiErrorResponseSchema.
- Export HealthResponseSchema.
- Export CreateSessionRequestSchema, SessionListQuerySchema, SessionListResponseSchema.
- Export CreateRunRequestSchema, RunListQuerySchema, RunListResponseSchema.
- Export EventStreamQuerySchema.
- Reuse existing domain schemas; do not duplicate entity shapes.

Steps:
- [ ] Write tests for valid requests, strict rejection of server-owned and unknown fields, list limit default 50/max 100, and non-negative integer cursor validation.
- [ ] Run pnpm exec vitest run packages/protocol/test/api.test.ts. Expected RED because the new exports do not exist.
- [ ] Implement strict schemas. Create Session accepts title, defaultWorkspace, defaultModel, metadata. Create Run accepts goal, workspace, model, runtime, permissionProfile, approvalPolicy, limits. Keep metadata defaulting in the Service boundary.
- [ ] Re-run the focused test and packages/protocol/test. Expected GREEN.
- [ ] Commit with feat(protocol): add local service api contracts.

### Task 2: Daemon Dependencies, Config, and App Factory

Files:
- Modify apps/daemon/package.json and pnpm-lock.yaml.
- Create apps/daemon/src/config.ts and app.ts.
- Modify apps/daemon/src/index.ts.
- Test apps/daemon/test/app.test.ts.

Interfaces:
- DaemonConfig has host, port, and sseHeartbeatIntervalMs; defaults are 127.0.0.1, 43120, and 15000.
- DaemonDependencies has sessions, runs, eventBus, and config.
- buildDaemonApp(dependencies) returns an unlistened Fastify instance.
- Public index exports only the small Daemon API.

Steps:
- [ ] Write a test that constructs the factory with repository doubles and an EventBus, verifies no listener is opened, and checks exact dependency versions and absence of forbidden dependencies.
- [ ] Run the test. Expected RED because the factory and dependencies are absent.
- [ ] Add fastify 5.12.1, @fastify/sse 0.6.0, and fastify-type-provider-zod 7.0.0. Configure the Zod validator/serializer compilers, register the plugin and route registration hooks, and keep listen out of app.ts.
- [ ] Run pnpm install --frozen-lockfile, the focused test, and pnpm --filter @caelush/daemon typecheck. Expected GREEN.
- [ ] Commit with feat(daemon): add fastify service foundation.

### Task 3: Local Host/Origin Guard and Error Mapping

Files:
- Create apps/daemon/src/transport/local-request-guard.ts and error-handler.ts.
- Modify apps/daemon/src/app.ts.
- Test apps/daemon/test/local-request-guard.test.ts and errors.test.ts.

Interfaces:
- assertLoopbackRequest(request) rejects non-loopback Host or Origin.
- toApiErrorResponse(error, requestId) returns statusCode and the safe ApiErrorResponse body.

Steps:
- [ ] Write inject tests for 127.0.0.1, localhost, [::1], attacker Host, missing Origin, loopback Origin, attacker Origin, all error mappings, requestId presence, and sensitive-data absence.
- [ ] Run both focused test files. Expected RED.
- [ ] Implement optional-port Host parsing and URL-based Origin parsing; allow only loopback names and HTTP(S), with no CORS.
- [ ] Map validation to 400 INVALID_REQUEST, cursor errors to 400 INVALID_EVENT_CURSOR, NotFound to 404, Conflict to 409, Storage errors to 500 STORAGE_ERROR, and unknown errors to 500 INTERNAL_ERROR. Add a JSON not-found handler.
- [ ] Re-run both test files. Expected GREEN.
- [ ] Commit with feat(daemon): add local request security and errors.

### Task 4: Health API

Files:
- Create apps/daemon/src/routes/health.ts.
- Modify apps/daemon/src/app.ts.
- Test apps/daemon/test/health.test.ts.

Interface:
- registerHealthRoute(app) registers GET /api/v1/health with HealthResponseSchema.

Steps:
- [ ] Write an inject test asserting status 200, exact service/status/apiVersion/protocolVersion fields, and no database path or environment data. Run it and observe RED.
- [ ] Implement the thin route and response schema registration. Run the test and observe GREEN.
- [ ] Commit with feat(daemon): add health endpoint.

### Task 5: SessionService and Session Routes

Files:
- Create apps/daemon/src/services/session-service.ts and routes/sessions.ts.
- Modify apps/daemon/src/app.ts.
- Test apps/daemon/test/sessions.test.ts.

Interfaces:
- SessionService accepts repository, clock, and id factory and exposes createSession, getSession, and listSessions.
- createSession generates id/timestamps, fills metadata with {}, validates AgentSessionSchema, inserts through SessionRepository, and returns AgentSession.
- Routes are POST/GET /api/v1/sessions and GET /api/v1/sessions/:sessionId.

Steps:
- [ ] Write tests for 201 create, round-trip get, { items } list, metadata default, strict request rejection, 404, and repository conflict 409. Use a temporary SQLite-backed repository for the integration path.
- [ ] Run the focused file and observe RED.
- [ ] Implement the Service with injected clock/id factory; keep all domain construction out of routes and publish no events.
- [ ] Implement schema-bound thin routes and status codes. Re-run and observe GREEN.
- [ ] Commit with feat(daemon): add session service and api.

### Task 6: RunService and Run Routes

Files:
- Create apps/daemon/src/services/run-service.ts and routes/runs.ts.
- Modify apps/daemon/src/app.ts.
- Test apps/daemon/test/runs.test.ts.

Interfaces:
- RunService accepts SessionRepository, RunRepository, clock, and id factory and exposes createRun, getRun, and listRuns.
- createRun validates parent Session, constructs AgentRun with status PENDING, parses AgentRunSchema, inserts, and returns it.
- Routes are nested POST/GET /api/v1/sessions/:sessionId/runs and GET /api/v1/runs/:runId.

Steps:
- [ ] Write tests for PENDING creation, durable get/list, missing parent 404, strict rejection of id/status/body sessionId, restart persistence, and no run.started observation.
- [ ] Run the focused file and observe RED.
- [ ] Implement parent validation and server-owned fields in the Service; do not call Core or add fake transitions.
- [ ] Implement thin schema-bound routes, re-run, and observe GREEN.
- [ ] Commit with feat(daemon): add session and run services.

### Task 7: SSE Event Mapper

Files:
- Create apps/daemon/src/transport/sse-event-mapper.ts.
- Test apps/daemon/test/sse-event-mapper.test.ts.

Interface:
- mapAgentEventToSse(event) returns event, JSON data, and an id only for Durable events.

Steps:
- [ ] Write Durable sequence 10 and Ephemeral event tests. Run and observe RED.
- [ ] Implement a branch on durability.kind; preserve full event JSON and never synthesize an Ephemeral id.
- [ ] Re-run and observe GREEN.
- [ ] Commit with feat(daemon): map agent events to sse frames.

### Task 8: Event Stream Route

Files:
- Create apps/daemon/src/routes/events.ts.
- Modify apps/daemon/src/app.ts.
- Test apps/daemon/test/events-sse.test.ts.

Interface:
- registerEventStreamRoute(app, runs, eventBus, heartbeatIntervalMs, activeStreams) registers GET /api/v1/runs/:runId/events.

Steps:
- [ ] Write an inject test for missing Run returning 404 JSON and a real listen(0)/fetch test for text/event-stream, Durable frame id/data, and Ephemeral frame without id. Run and observe RED.
- [ ] Register @fastify/sse once in the factory. Confirm Run before headers, call EventBus.watch with an AbortSignal, map the AsyncIterable, use plugin heartbeat, and bind socket close to stream abort.
- [ ] Re-run and observe GREEN with real HTTP bytes.
- [ ] Commit with feat(daemon): stream agent events over sse.

### Task 9: Cursor Parsing and Reconnection

Files:
- Modify apps/daemon/src/routes/events.ts and transport/error-handler.ts.
- Create apps/daemon/test/sse-reconnect.test.ts.

Interface:
- resolveEventCursor(lastEventId, queryAfterSequence) returns a non-negative integer or throws InvalidEventCursorError.

Steps:
- [ ] Write real-socket tests for sequences 1, 2, 3, disconnect after 1, reconnect with Last-Event-ID 1 receiving exactly 2/3, then live 4; repeat query cursor; assert Ephemeral is not replayed; assert abc, -1, 1.5, and conflicting cursors return the required 400 code.
- [ ] Run and observe RED.
- [ ] Implement strict decimal integer parsing, omission as 0, equal duplicate values accepted, conflicts rejected, and pass only the resolved cursor to EventBus.watch.
- [ ] Re-run and observe GREEN with no duplicate or gap.
- [ ] Commit with feat(daemon): add durable sse cursor reconnect.

### Task 10: Multi-client SSE

Files:
- Create apps/daemon/test/sse-multiclient.test.ts.
- Modify production code only if an observable test exposes a defect.

Steps:
- [ ] Connect two real fetch clients to one Run, publish Durable and Ephemeral events through the test-owned EventBus, and assert both clients receive each event exactly once with only Durable carrying id.
- [ ] Run the test and record the observed result. If it fails, implement only the smallest transport correction and re-run.
- [ ] Commit changed code/tests with test(daemon): cover multi-client event streams.

### Task 11: Disconnect Cleanup

Files:
- Create apps/daemon/test/sse-disconnect.test.ts.
- Modify packages/events/src/event-stream.ts or event-bus.ts only if the observable test proves current cancellation insufficient.

Steps:
- [ ] Abort a real SSE client, await body close, publish another event, and assert no write-after-end/unhandled error and completed watch. Run and observe the existing behavior.
- [ ] If RED, preserve finally cleanup, queue close, signal listener removal, and iterator return; add the regression test. Re-run daemon cleanup plus packages/events/test.
- [ ] Commit only if production events code changed, using fix(events): clean up aborted stream consumers.

### Task 12: Daemon Lifecycle and Graceful Shutdown

Files:
- Create apps/daemon/src/daemon.ts.
- Modify apps/daemon/src/app.ts.
- Test apps/daemon/test/shutdown.test.ts.

Interfaces:
- DaemonOptions has databasePath plus optional host, port, sseHeartbeatIntervalMs, and logger.
- DaemonHandle has url and idempotent close().
- startDaemon(options) opens Storage, composes the App, listens, and owns closing.

Steps:
- [ ] Write real-server tests for temporary SQLite, active SSE, close twice, bounded completion, migration/open failure, and occupied explicit port without port drift. Run and observe RED.
- [ ] Implement open Storage first, create EventBus from storage.events, construct Services, build App, listen on exact host/port, cache close Promise, abort active streams, close Fastify, then close Storage, and clean partially opened resources on startup failure.
- [ ] Re-run and observe GREEN with no leaked listener or stream.
- [ ] Commit with feat(daemon): add graceful lifecycle handling.

### Task 13: Command Entry and Startup Behavior

Files:
- Create apps/daemon/src/main.ts and test/startup.test.ts.
- Modify apps/daemon/package.json and src/index.ts.

Steps:
- [ ] Write tests for cross-platform default database path construction, explicit start options, no import-time listen, startup rejection, and signal policy without terminating Vitest. Run and observe RED.
- [ ] Implement main as the only signal/exit-code owner; use os.homedir and path.join for the CLI default, await close, and set process.exitCode on fatal startup/shutdown errors. Add a start script only if the real process smoke test requires it.
- [ ] Re-run and observe GREEN.
- [ ] Commit with feat(daemon): add explicit daemon startup entry.

### Task 14: Full HTTP/SSE E2E and Restart Recovery

Files:
- Create apps/daemon/test/daemon-e2e.test.ts and test/support/sse-client.ts.
- Modify production code only for defects found by this test, with a regression test first.

Steps:
- [ ] Write one real-socket scenario: temporary SQLite, real server port 0, health, Session, PENDING Run, clients A/B, Durable 1, disconnect A, Durable 2/3, Last-Event-ID 1 reconnect, live Durable 4, live Ephemeral without id, close, both streams close, restart same DB, recover Session/Run/history.
- [ ] Run and observe RED for missing behavior, correcting parser/fixture errors before production code.
- [ ] Implement the smallest tested corrections and re-run until GREEN.
- [ ] Verify no duplicate/gap, process, port, stream, or temporary DB leak.
- [ ] Commit with test(daemon): add local service http and sse e2e.

### Task 15: Architecture Documentation and Guards

Files:
- Create docs/architecture/local-agent-service.md.
- Modify README.md, AGENTS.md, docs/architecture/package-boundaries.md, and tests/architecture/package-boundaries.test.ts.

Steps:
- [ ] Add failing architecture assertions for daemon → protocol/storage/events, package → daemon rejection, public daemon entry, and deep-import rejection. Run tests and observe RED.
- [ ] Update docs with the architecture diagram, App Factory vs startDaemon, lifecycle order, Host/Origin/no-CORS, PENDING semantics, deferred cancellation/approval, durable cursor and Ephemeral rules. Update README to Phase 3 and AGENTS with the hard rules.
- [ ] Re-run tests and observe GREEN.
- [ ] Commit with docs: document local agent service architecture.

### Task 16: Clean Build, Full Verification, and Completion Report

Files:
- Inspect all generated artifact paths, Git status, diff, and recent history.
- Modify source only if a fresh regression test proves a defect.

Steps:
- [ ] Identify only repository-generated dist directories and tsbuildinfo files, remove those artifacts with path-explicit cross-platform commands, and preserve source/user files.
- [ ] Run pnpm install --frozen-lockfile and confirm no lockfile change.
- [ ] Run focused Protocol API, daemon, SSE, and architecture suites and record Test Files, Tests, and Failures.
- [ ] Run a real HTTP health smoke against a started daemon on port 0 and close it; if checking 43120 and it is occupied, do not kill the owner and record the result.
- [ ] Run node --version, pnpm --version, pnpm install --frozen-lockfile, pnpm lint, pnpm typecheck, pnpm test, pnpm build, pnpm format:check, and pnpm check. Record each exit code.
- [ ] Confirm no daemon process, leaked port, active SSE, temporary DB, or tsbuildinfo remains beyond expected build artifacts. Run git diff --check, git status --short, and git log --oneline --decorate -15.
- [ ] Write the requested Completion Report with baseline, dependencies, architecture, lifecycle, security, contracts, APIs, SSE/reconnect/multi-client/shutdown/restart evidence, validation/errors, TDD RED → GREEN evidence, architecture guards, verification counts, smoke/cleanup, Git history, risks, and the explicit Phase 4 handoff without implementing Phase 4.
