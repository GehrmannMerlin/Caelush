# Caelush V1 Phase 1 Protocol & State Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define Caelush V1's first stable, provider-neutral, runtime-neutral, JSON-serializable Protocol and implement the canonical Core Run State Machine without implementing an Agent runtime.

**Architecture:** `@caelush/protocol` is the Zod 4 source of truth for IDs, JSON values, domain records, tool/observation contracts, and typed AgentEvent discriminated unions. `@caelush/core` receives its first real workspace dependency on protocol and owns only the exhaustive RunStatus transition table and transition API. Protocol values remain plain JSON data; executable tools, providers, Runtime objects, EventBus, Storage, and UI remain outside this phase.

**Tech Stack:** TypeScript 6.0.3, Node.js 24.x, pnpm 11.21.0, Zod 4 in `@caelush/protocol`, `uuid` UUIDv7 factory in `@caelush/protocol`, Vitest, ESLint, Prettier, ESM.

**Spec:** User-provided Phase 1 specification in `C:\Users\韩吉衍\.codex\attachments\b4f57a74-d8b5-4c43-88af-2813906d96a9\pasted-text.txt`.

## Global Constraints

- Preserve the Phase 0 baseline commit `f55dc2a` and do not alter the frozen TypeScript 6.0.3/toolchain decision.
- Install Zod 4 and `uuid` only in `packages/protocol`; do not install AI SDK, Fastify, React, Vite, Ink, Drizzle, SQLite, Pino, node-pty, or other future runtime dependencies.
- Protocol schemas are the source of truth: derive all public types with `z.infer`; do not manually maintain parallel interfaces.
- All protocol values are strict, JSON-safe, provider-neutral, runtime-neutral, UI-neutral, and storage-neutral.
- Do not put `AbortSignal`, `Error` instances, `Map`, `Set`, class state, handles, sockets, streams, SDK types, framework types, or database objects in Protocol schemas.
- Use UUIDv7 with resource prefixes: `ses_`, `run_`, `stp_`, `evt_`, `tinv_`, `obs_`, `apr_`, `ver_`, `plan_`, `wsp_`.
- Durable event order is `durability.sequence`, never timestamp or UUID sorting.
- `ToolDefinition` is data-only and contains JSON Schema data, never `execute()` or a runtime object.
- `AgentStep` is a Runtime iteration; `PlanItem` is a user-visible semantic plan item.
- Terminal RunStatus values have no outgoing transitions; `RUNNING → COMPLETED` is forbidden; `VERIFYING → RUNNING` is allowed.
- Do not implement AgentLoop, RunController, SessionManager, LLMProvider, ToolRegistry/Dispatcher, executable tools, Runtime, Storage, EventBus, API, SSE, CLI, Web, or Web Search.
- Keep public exports explicit; do not export internal schema factories, regex helpers, or test utilities.

## Reference Protocol Notes

- Codex reinforces that Session, Run/Task/Turn, operations, events, approvals, interrupts, and UI consumption are distinct protocol concerns; Caelush keeps these as data contracts and leaves execution orchestration to later phases.
- Pi reinforces an Agent Core event boundary, provider conversion boundary, Tool result/detail separation, and AbortSignal as runtime control; only the serializable Observation/Event seams are defined here.
- OpenCode reinforces schema-as-source-of-truth, branded identifiers, explicit tool contracts, permission separation, and durable sequence rather than timestamps; these principles are implemented in protocol schemas and event durability.
- Goose reinforces formal Session, Permission Request, cancellation, and streaming update contracts; Phase 1 defines their data shapes but not their services.
- Aider reinforces that future file-changing agents must respect repository state and auditable diffs; no file editing behavior enters Phase 1.

---

### Task 1: Add protocol dependencies and organize source boundaries

**Files:**

- Modify: `packages/protocol/package.json`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/primitives/ids.ts`
- Create: `packages/protocol/src/primitives/json.ts`
- Create: `packages/protocol/src/primitives/time.ts`
- Create: `packages/protocol/src/error.ts`
- Create: `packages/protocol/src/policy.ts`
- Create: `packages/protocol/src/workspace.ts`
- Create: `packages/protocol/src/model.ts`
- Create: `packages/protocol/src/runtime.ts`
- Create: `packages/protocol/src/limits.ts`

**Interfaces:**

- `packages/protocol` gains runtime dependencies `zod` (Zod 4) and `uuid`.
- `packages/protocol/src/index.ts` explicitly exports only public schemas, types, and ID factories from the focused modules.
- Primitive exports include `JsonValueSchema`, `JsonObjectSchema`, `TimestampMsSchema`, all ten prefixed ID schemas/types/factories, `PermissionProfileSchema`, `ApprovalPolicySchema`, `CapabilitySchema`, `RiskLevelSchema`, `WorkspaceRefSchema`, `ModelRefSchema`, `RuntimeRefSchema`, `RunLimitsSchema`, and `AgentErrorSchema`.

- [ ] **Step 1: Query compatible dependency versions without changing the repository**

Run `pnpm view zod@4 version` and `pnpm view uuid version`, confirm the versions support Node 24/TypeScript 6, and choose concrete versions.

- [ ] **Step 2: Write primitive and policy tests first**

Create `packages/protocol/test/ids.test.ts` and `packages/protocol/test/primitives.test.ts` covering valid JSON/timestamps/IDs plus invalid prefixes, UUIDs, UUID versions, negative timestamps, non-JSON values, and unknown keys. Import schemas from the intended public entry where possible.

- [ ] **Step 3: Run the focused tests to verify Red**

Run `pnpm vitest run packages/protocol/test/ids.test.ts packages/protocol/test/primitives.test.ts`. Expect failure because the schemas and public exports do not yet exist; fix test harness errors before implementing.

- [ ] **Step 4: Add Zod 4 and uuid to the protocol manifest**

Use `pnpm --filter @caelush/protocol add zod@<chosen-zod-4-version> uuid@<chosen-uuid-version>` so the dependencies are recorded only in the protocol package and lockfile.

- [ ] **Step 5: Implement the minimal primitive schemas and factories**

Define recursive JSON schemas for string/finite number/boolean/null/array/object, nonnegative integer millisecond timestamps, and independent prefixed UUIDv7 ID schemas/factories using `uuid.v7`, `uuid.validate`, and `uuid.version`. Use strict Zod objects and derive types with `z.infer`.

- [ ] **Step 6: Implement policy/reference/error schemas and explicit exports**

Define the exact V1 enums and JSON-safe records from the specification. Keep `ModelRef` free of credentials, `RuntimeRef` free of runtime objects, and `AgentError` free of raw `Error` instances.

- [ ] **Step 7: Run the focused tests to verify Green**

Run the same focused Vitest command and then `pnpm typecheck`. Expect all primitive tests to pass with no explicit `any` in protocol source.

### Task 2: Define Session, Run, Step, Plan, and AgentState domain contracts

**Files:**

- Create: `packages/protocol/src/session.ts`
- Create: `packages/protocol/src/run.ts`
- Create: `packages/protocol/src/step.ts`
- Create: `packages/protocol/src/plan.ts`
- Create: `packages/protocol/src/state.ts`
- Create: `packages/protocol/src/file.ts`
- Create: `packages/protocol/src/process.ts`
- Create: `packages/protocol/src/usage.ts`
- Create: `packages/protocol/test/domain.test.ts`

**Interfaces:**

- `AgentSessionSchema` models a multi-Run conversation container with defaults and metadata.
- `AgentRunSchema` captures session, goal, status, workspace/model/runtime/permission/approval/limits snapshots and lifecycle timestamps.
- `AgentStepSchema` models a positive Run-local iteration sequence; `PlanItemSchema` separately models user-visible plan semantics.
- `AgentStateSchema` is a bounded serializable current projection containing plan, recent observations, changed files, process summaries, errors, verification state, and usage counters, never an event/history store.

- [ ] **Step 1: Write domain valid, strictness, and round-trip tests**

In `domain.test.ts`, parse representative session/run/step/plan/state fixtures, assert unknown fields fail, assert negative limits/sequences/counters fail, and verify `schema.parse(JSON.parse(JSON.stringify(value)))` succeeds for each core fixture.

- [ ] **Step 2: Run domain tests to verify Red**

Run `pnpm vitest run packages/protocol/test/domain.test.ts`. Expect failure because domain schemas are absent.

- [ ] **Step 3: Implement focused domain schemas**

Use strict Zod objects, `RunStatusSchema`, `RunLimitsSchema`, and the primitive/reference schemas. Keep all optional values JSON-safe and do not add Runtime handles, Error objects, or unbounded history.

- [ ] **Step 4: Export the domain contracts and verify Green**

Explicitly export schemas/types from `packages/protocol/src/index.ts`; run the focused domain tests and `pnpm typecheck`.

### Task 3: Define Tool, Invocation, Observation, Approval, and Verification contracts

**Files:**

- Create: `packages/protocol/src/tool.ts`
- Create: `packages/protocol/src/observation.ts`
- Create: `packages/protocol/src/approval.ts`
- Create: `packages/protocol/src/verification.ts`
- Create: `packages/protocol/test/tool.test.ts`
- Create: `packages/protocol/test/observation.test.ts`

**Interfaces:**

- `ToolDefinitionSchema` is a strict data-only contract with name, description, JSON Schema input/output, risk, capabilities, and runtime requirements.
- `ToolInvocationSchema` records args as `JsonObject`, status, IDs, timestamps, and structured `AgentError`, without embedding results or executable functions.
- `ObservationSchema` is a discriminated union for Tool, Verification, and System observations, separating compact `content` from JSON-safe `details`.
- `ApprovalRequestSchema` and `VerificationResultSchema` define explicit status/scope/result protocols.

- [ ] **Step 1: Write valid and negative Tool/Observation tests**

Test tool-name regex, strict rejection of `execute`, rejection of non-object args, status enums, Observation discriminants, JSON round trips, approval scopes/statuses, and verification statuses.

- [ ] **Step 2: Run focused tests to verify Red**

Run `pnpm vitest run packages/protocol/test/tool.test.ts packages/protocol/test/observation.test.ts`; expect failures caused by missing schemas.

- [ ] **Step 3: Implement data-only contracts**

Use JSON object schemas for input/output/action/details/evidence. Do not import Runtime, provider, SDK, or framework types. Keep `execute` absent by construction through strict schemas.

- [ ] **Step 4: Export and verify Green**

Run the focused tests, `pnpm typecheck`, and search `packages/protocol` for `execute`, provider names, `AI SDK`, and explicit `any`; only the negative test string may mention `execute`.

### Task 4: Define the typed AgentEvent protocol

**Files:**

- Create: `packages/protocol/src/events/base.ts`
- Create: `packages/protocol/src/events/run.ts`
- Create: `packages/protocol/src/events/reasoning.ts`
- Create: `packages/protocol/src/events/tool.ts`
- Create: `packages/protocol/src/events/file.ts`
- Create: `packages/protocol/src/events/shell.ts`
- Create: `packages/protocol/src/events/process.ts`
- Create: `packages/protocol/src/events/verification.ts`
- Create: `packages/protocol/src/events/approval.ts`
- Create: `packages/protocol/src/events/llm.ts`
- Create: `packages/protocol/src/events/error.ts`
- Create: `packages/protocol/src/events/index.ts`
- Create: `packages/protocol/test/event.test.ts`
- Create: `packages/protocol/test/public-api.test.ts`

**Interfaces:**

- Every event has `eventId`, `schemaVersion: 1`, `runId`, `sessionId`, optional `stepId`, `type`, `timestamp`, `visibility`, `durability`, optional title/summary, and a typed payload.
- `AgentEventSchema` is a Zod discriminated union covering all 28 specified event types.
- Durable metadata is `{ kind: "DURABLE", version: 1, sequence: positive integer }`; ephemeral metadata is `{ kind: "EPHEMERAL" }` with no sequence.
- Public API test imports every required schema and corresponding type from `@caelush/protocol`; no internal helper is exported.

- [ ] **Step 1: Write event and public API tests to verify Red**

Test durable/ephemeral validation, sequence positivity, schema version, event/payload mismatch, unknown fields, JSON round trip, all event discriminants, and a compile-time narrowing helper using `switch (event.type)` without `any`.

- [ ] **Step 2: Implement typed event payload modules and envelope**

Use explicit payload schemas for run/status/plan/reasoning/tool/file/shell/process/verification/approval/LLM/error events. Avoid secret fields and provider SDK types. Define the union explicitly in `events/index.ts` and export only public event contracts.

- [ ] **Step 3: Run event/public API tests and typecheck**

Run `pnpm vitest run packages/protocol/test/event.test.ts packages/protocol/test/public-api.test.ts` and `pnpm typecheck`; fix any public export or discriminated narrowing issue at the source.

### Task 5: Add the first real Core → Protocol dependency and Run State Machine

**Files:**

- Modify: `packages/core/package.json`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/run-state-machine.ts`
- Create: `packages/core/test/run-state-machine.test.ts`

**Interfaces:**

- `@caelush/core` depends on `@caelush/protocol: workspace:*` and imports `RunStatus` through the public package entry only.
- Export `isTerminalRunStatus(status: RunStatus): boolean`, `canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean`, `assertRunStatusTransition(from: RunStatus, to: RunStatus): void`, and `InvalidRunStatusTransitionError`.
- The transition table is exhaustive via `satisfies Record<RunStatus, readonly RunStatus[]>`.

- [ ] **Step 1: Write state-machine tests first**

Cover all allowed transitions from the specification, explicit rejection of `RUNNING → COMPLETED`, `VERIFYING → RUNNING` acceptance, all terminal statuses having no outgoing transitions, and error instances containing `from`/`to`.

- [ ] **Step 2: Run state-machine tests to verify Red**

Run `pnpm vitest run packages/core/test/run-state-machine.test.ts`; expect failure because the Core implementation and dependency are absent.

- [ ] **Step 3: Add the workspace dependency and implement the minimal state machine**

Add exactly `"@caelush/protocol": "workspace:*"`, import the public `RunStatus` type, define the exhaustive immutable transition table, and implement the three functions plus the focused error class. Do not implement RunController or status mutation elsewhere.

- [ ] **Step 4: Run state-machine and architecture tests to verify Green**

Run `pnpm vitest run packages/core/test/run-state-machine.test.ts tests/architecture` and `pnpm typecheck`. Confirm the existing protocol boundary test accepts Core → Protocol.

### Task 6: Update documentation and architecture guards

**Files:**

- Create: `docs/architecture/protocol-v1.md`
- Modify: `docs/architecture/package-boundaries.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `tests/architecture/package-boundaries.test.ts`
- Create or modify: `tests/architecture/public-api.test.ts` only if a root-level public API guard is needed

**Interfaces:**

- Documentation describes Session → Run → Step/Plan → ToolInvocation/Observation → Approval/Verification → Event relationships, Step vs PlanItem, Tool contract split, and durable sequence semantics.
- Boundary tests accept Core → Protocol, reject Protocol → Core, continue rejecting deep imports and app dependencies, and validate the protocol public API surface.

- [ ] **Step 1: Extend architecture tests before documentation changes**

Add assertions that Core's dependency is exactly `workspace:*`, protocol remains free of feature-package dependencies, and the required public contract names are reachable from the protocol package entry.

- [ ] **Step 2: Run architecture tests to verify the new guard Red/Green behavior**

Run the focused suite, fix only implementation/configuration issues, and retain the earlier temporary illegal protocol → core failure demonstration in the final evidence.

- [ ] **Step 3: Write the Phase 1 architecture document and update existing guidance**

Document the finalized contracts and invariants without duplicating the full TAD. Update package boundaries, AGENTS.md hard rules, and README phase/status language from Phase 0 to Phase 1.

- [ ] **Step 4: Run formatting and architecture tests**

Run `pnpm prettier --write` only on changed project files and then `pnpm vitest run tests/architecture`.

### Task 7: Clean artifact and cross-package resolution verification

**Files:**

- No intended source changes; inspect generated paths only.

**Interfaces:**

- A clean workspace without `dist` or `*.tsbuildinfo` must pass install, typecheck, test, build, and check.

- [ ] **Step 1: Confirm generated targets and ignore rules**

Resolve the exact `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` paths, verify they are generated and ignored, then remove only those exact generated paths with PowerShell `Remove-Item` after validation.

- [ ] **Step 2: Run clean resolution checks**

Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check`. Confirm Core resolves Protocol through the package name/public entry rather than a deep source path or stale dist.

- [ ] **Step 3: Re-run targeted API and architecture checks**

Run protocol tests, state-machine tests, public API tests, and architecture tests after the clean build.

### Task 8: Verify Git safety and complete the Phase 1 report

**Files:**

- No intended source changes.

**Interfaces:**

- The final report includes baseline commit, commits made during Phase 1, final status, tests/counts/failures, TDD Red → Green evidence, clean-build evidence, architecture guard failure demonstration, and non-implemented capabilities.

- [ ] **Step 1: Run every required verification command independently**

Run `node --version`, `pnpm --version`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`, recording exit codes and test counts.

- [ ] **Step 2: Verify Git state**

Run `git status --short`, `git log --oneline --decorate -10`, `git diff --check`, and `git diff --stat`; ensure no secrets, generated artifacts, or unrelated files are staged or committed.

- [ ] **Step 3: Apply verification-before-completion**

Use `superpowers:verification-before-completion` immediately before the completion report. Claim Phase 1 only if all Phase 1 completion conditions and fresh command outputs are satisfied; otherwise report the exact blocker.
