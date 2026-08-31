# Phase 12A Production Daemon Execution Surface & Shared Client Transport Implementation Plan

> **For the implementing agent:** use `superpowers:executing-plans` and execute this
> plan task by task. Keep the work in
> `D:/Develop/Caelush/.worktrees/phase-12a-production-daemon-client-transport` on
> `codex/phase-12a-production-daemon-client-transport`.

## Global constraints

- Phase 12 contains exactly 12A–12E. Implement only 12A.
- Preserve the sealed Phase 11D baseline at
  `92d93982855569dff416cf5909806379e0685783`.
- Do not add a second AgentLoop, provider registry, runtime, Tool catalog, approval
  state machine, verification executor, or event replay implementation.
- The daemon is the only local composition root. Routes remain thin.
- `RunController` owns Run status, cancellation, timeout, approval, verification, and
  terminal transitions.
- `EventBus.watch()` is the only SSE replay/live source.
- Tools execute only through the existing secure Dispatcher and Batch Coordinator.
- The public model input is `{ provider, model }`; client-supplied `baseUrl`, headers,
  credentials, and arbitrary provider options are rejected.
- `@caelush/client` depends only on Protocol and Web platform APIs; no Node built-ins
  or Caelush runtime/application packages.
- Provider credentials are read only at daemon startup composition and never enter
  Protocol, Storage entities, events, logs, or public errors.
- Use strict TypeScript, ESM, package-root imports, and `apply_patch` for edits.
- Every behavior change starts with a failing test and then the smallest implementation.
- Do not run whole-repository formatting writes. Preserve the known 696-file format
  baseline and run targeted formatting checks for touched files.
- Before completion run `pnpm check`, targeted changed-file formatting checks,
  `git diff --check`, `git status --short`, and a final diff audit.

## Task 1 — Confirm baseline and record current architecture

1. Verify the Phase 11D commit, branch, worktree, and clean starting state.
2. Re-run the narrow daemon/core/storage/runtime/package-boundary characterization
   commands if implementation assumptions change.
3. Keep the design document at
   `docs/superpowers/specs/2026-08-31-caelush-phase-12a-production-daemon-client-transport-design.md`
   synchronized with any discovered public-port detail.

## Task 2 — Add Protocol public transport contracts (TDD)

1. Add failing Protocol tests for strict client model selection, public Session/Run
   response projections, `DaemonInfo`, action dispositions, approval list/resolve,
   and bounded API error codes.
2. Add the smallest schemas/types under `packages/protocol/src/api/`.
3. Change create request bodies to accept only `{ provider, model }` for model choice.
4. Keep internal `ModelRef` available to Core/Storage, but add explicit public
   projection schemas that cannot contain `baseUrl`.
5. Export all new schemas/types only through `packages/protocol/src/index.ts` and the
   API barrel.
6. Add tests proving extra fields are rejected and public schemas do not parse an
   endpoint-bearing model.

## Task 3 — Make existing daemon CRUD use safe public projections (TDD)

1. Add red tests for canonical internal model storage and endpoint-free HTTP responses.
2. Add a daemon-only model canonicalizer that accepts public selection and applies
   server configuration when available; unknown models remain durable but fail safely
   at execution/provider resolution.
3. Update SessionService/RunService and CRUD route response schemas to project
   internal entities to public response shapes.
4. Prove client `baseUrl` input is rejected before any provider transport is invoked.
5. Preserve existing session/run CRUD and PENDING/no-`run.started` behavior.

## Task 4 — Implement `RunExecutionSupervisor` (TDD)

1. Add red unit tests with a fake RunController and RunRepository for:
   * immediate nonblocking scheduling;
   * one active entry per Run ID;
   * terminal no-op;
   * PENDING recover conflict;
   * background rejection capture;
   * token-safe `finally` cleanup;
   * direct cancellation and drain/dispose.
2. Implement the supervisor with an opaque task token per scheduled operation.
3. Keep supervisor outcomes as daemon-internal dispositions; do not expose
   `RunControllerResult` directly.
4. Ensure the supervisor never mutates Run/State rows and never invokes Tools.

## Task 5 — Add daemon action services/routes (TDD)

1. Add failing route tests for start/recover/cancel, approval list/resolve, unknown
   resources, conflicts, idempotent resolution, and terminal no-op.
2. Add the route-level execution surface ports and safe outcome mapper.
3. Register `/api/v1/info` with strict `DaemonInfoSchema`.
4. Register the five action/approval routes with strict body/query/response schemas.
5. Ensure start returns 202 without awaiting Core execution, recover returns 409 for
   PENDING, cancel calls `RunController.cancel()` directly, and approval resolution
   calls `RunController.resolveApproval()` rather than editing rows.
6. Extend error mapping only with bounded public codes/messages.

## Task 6 — Compose the production daemon (TDD/integration)

1. Add a failing composition test that asserts singleton lifecycle identity for
   Storage/EventBus/RunController/LocalRuntime/LocalProcessManager/RuntimeResolver.
2. Add programmatic provider configuration and a startup-only environment adapter in
   `apps/daemon`.
3. Compose Provider Registry → Gateway → narrow AgentLLMClient.
4. Compose Context inspector/planner/builder and AgentLoop.
5. Compose one LocalProcessManager → LocalRuntime → resolver, immutable default Tool
   Registry, secure Dispatcher, and ToolBatchCoordinator.
6. Compose real Approval, Budget, Verification planner/runner/profile/runtime ports,
   resolver registry, security/evidence sanitizer, and shared Core registries.
7. Inject all composed ports into one RunController and one Supervisor.
8. Add startup failure cleanup and ordered, idempotent shutdown. Preserve existing
   `startDaemon` CRUD/replay tests when provider configuration is empty.

## Task 7 — Improve/verify daemon SSE invariants (TDD)

1. Add red tests for unsafe/overflowing cursor strings and durable/ephemeral identity.
2. Tighten cursor validation to safe integer bounds without changing exclusive replay.
3. Preserve `EventBus.watch()` as the sole source and keep SSE shutdown abort-safe.
4. Add a test that graceful close drains/ends active streams before Storage closes.

## Task 8 — Add `@caelush/client` package (TDD)

1. Add package manifest/tsconfig and a red package-boundary test proving no forbidden
   imports or Node built-ins.
2. Implement typed JSON client methods for info, sessions, runs, start/recover/cancel,
   and approval list/resolve.
3. Implement bounded API error parsing and compatibility validation for `/info`.
4. Implement an incremental Web Streams SSE parser using `TextDecoder` with streaming
   UTF-8 decode. Cover LF/CRLF/CR, chunk-split delimiters, comments, field ordering,
   multiline data, emoji, durable sequence IDs, ephemeral no-ID, run ID mismatch,
   malformed JSON/schema, and abort.
5. Do not use EventSource and do not implement automatic reconnect. Expose the last
   validated durable sequence through the yielded event identity only; callers pass a
   new `afterSequence` explicitly.
6. Export only from `packages/client/src/index.ts` and add workspace dependencies with
   `workspace:*`.

## Task 9 — Full integration and documentation

1. Add an integration test for create → start 202 → background Kernel → durable state/
   event → client observation, using a controlled provider response.
2. Add cancellation and approval integration tests that prove Core remains the
   authority and that late results cannot reopen a terminal Run.
3. Add architecture tests for daemon composition and client boundaries.
4. Add/update:
   * `docs/architecture/daemon-production-composition.md`
   * `docs/architecture/client-transport.md`
   * daemon/security architecture docs
   * README usage and lifecycle documentation
   * AGENTS Phase 12A completion boundary and non-goals.
5. Include official research links and explicitly record what was not copied.

## Task 10 — Verification, audit, and delivery

1. Run targeted tests after each task and fix failures with systematic debugging.
2. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check`.
3. Run Prettier check only on changed files; compare full format output to the recorded
   696-file baseline and do not broaden formatting changes.
4. Run `git diff --check`, inspect `git diff`, inspect `git status --short`, and verify
   no credentials/secrets or forbidden Phase 12B+ code entered the diff.
5. Use coherent commits, at minimum:
   * `docs: specify phase 12a daemon and client transport`
   * `feat(protocol): add phase 12a transport contracts`
   * `feat(daemon): compose production execution surface`
   * `feat(client): add typed http and sse transport`
   * `docs: document phase 12a daemon and client boundaries`
6. Push the branch normally to `origin` and record the final commit SHA. Never force
   push or modify the sealed Phase 11D branch.

