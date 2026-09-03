# Agent Runtime Resource Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the low fixed lifetime Tool-call guard with durable adaptive resource governance while preserving exact accounting, hard enterprise limits, recovery, security, Approval, and Verification authority.

**Architecture:** Keep `RunBudgetLedger` and `RunBudgetPort` as the financial accounting boundary. Add a protocol-owned `RunResourcePolicy`, a Storage-owned durable `RunResourceState`, and a Core-owned deterministic `ResourceGovernor` that evaluates turn/batch boundaries, renews healthy operational leases, detects no-progress loops, and creates a durable `WAITING_RESOURCE` boundary. Client, CLI, Web, and daemon consume the same protocol semantics; none owns governance decisions.

**Tech Stack:** TypeScript, Zod, Node.js, SQLite/Drizzle migrations, Vitest, React, Fastify routes, existing `@caelush/*` public package APIs, canonical JSON/hash utilities, and the existing RunController/ToolDispatcher/Runtime boundaries.

**Spec:** `docs/superpowers/specs/2026-09-03-agent-runtime-resource-governance-design.md`

## Global Constraints

- Do not introduce Phase 14 or any new Phase 8–13 round; this milestone has exactly Internal Tasks 1–8.
- The daemon owns `DEFAULT_ADAPTIVE_RESOURCE_POLICY`; Web and CLI must not duplicate policy defaults.
- `RunBudgetLedger` remains exact financial accounting; Operational Lease state is separate and never increases money reservations or hard cost limits.
- Agent Turn means one settled provider response cycle; Tool calls in one response do not become multiple turns.
- `maxToolCallsPerTurn` is a per-response batch bound; it is not a lifetime Tool-call ceiling.
- Adaptive soft boundaries never emit `budget.exceeded` and never directly transition a Run to a terminal failure.
- Replan preflights the complete batch, executes zero handlers, and returns one safe synthetic Tool result per requested Tool call in source order.
- AgentLoop remains unaware of Dispatcher, Storage, Runtime, concrete Tools, Approval resolution, and Verification execution.
- Public contracts and events never contain raw Tool arguments, raw Tool output, provider payloads, credentials, hidden reasoning, internal revisions, or secrets.
- Existing Phase 10 accounting, cancellation, timeout, security, Approval, and Phase 11D Completion Authority tests remain intact.
- All behavior changes follow TDD: failing focused test first, observed failure, minimum implementation, focused green suite, then refactor.
- No sub-agent is required. If one is created, the model must be exactly `gpt-5.6-luna`; never silently fall back to another model.

---

### Task 1: Baseline Audit and Current Accident Characterization

**Files:**
- Create: `docs/superpowers/characterization/2026-09-03-agent-runtime-resource-governance-baseline.md`
- Create: `packages/core/test/resource-baseline.test.ts`
- Modify: none in production code

**Interfaces:**
- Consumes: current `BudgetManager.admitToolCalls()`, `AgentLoop`, `ToolBatchCoordinator`, `RunController`, `SqliteRunBudgetPort`, and deadline registry behavior.
- Produces: a reviewed execution graph, a deterministic fixed-budget failure fixture, a healthy 12–20-operation workload fixture, and a timeout ownership table used by later tasks.

- [ ] **Step 1: Write the fixed-budget characterization test.**

  Add a test that constructs the current legacy `RunLimits` with `maxToolCalls: 8`, a snapshot with four consumed calls, and requests five calls. Assert the current admission is `{ kind: "EXCEEDED", dimension: "TOOL_CALLS", accounted: 4, limit: 8 }`. Add a second test describing the desired adaptive contract through a test-local pending-policy expectation so the missing canonical policy fails for the expected reason once implementation begins.

- [ ] **Step 2: Run the focused test and capture the baseline.**

  Run:

  ```bash
  pnpm exec vitest run packages/core/test/resource-baseline.test.ts
  ```

  Expected: the fixed legacy characterization passes and the pending adaptive expectation fails because no adaptive resource policy/governor exists yet. Record the exact output in the characterization document.

- [ ] **Step 3: Trace the production call graph.**

  Read the current implementations and record function-level ownership for `evaluateAgentStepGate`, `AgentLoop.run`, `AgentLoop.resumeWithToolResults`, `RunController.drive`, Tool batch preflight, `BudgetManager.admitToolCalls`, `SqliteRunBudgetPort.admitLLM`, Tool Dispatcher settlement, `RunController.recover`, `reconcileState`, and `deriveRunDeadline`. Include where Tool reservation, Tool commit, LLM settlement, cost settlement, recovery, and status transition occur.

- [ ] **Step 4: Add deterministic healthy workload data.**

  Define a test-local fixture that emits at least twelve ordered operations (`list_directory`, `find_files`, `read_file`, and `search_text`) with distinct result fingerprints. Assert it is bounded, deterministic, and represents multiple Agent Turns rather than one Tool-call count.

- [ ] **Step 5: Document timeout ownership and audit findings.**

  Write the observed timeout table and the current default path into the characterization document. Do not claim a timeout semantic based only on a name; cite the actual call sites and tests.

- [ ] **Step 6: Commit the characterization.**

  ```bash
  git add docs/superpowers/characterization/2026-09-03-agent-runtime-resource-governance-baseline.md packages/core/test/resource-baseline.test.ts
  git diff --cached --check
  git commit -m "test(runtime): characterize fixed resource budget failure"
  ```

### Task 2: Canonical Resource Policy and Protocol Compatibility

**Files:**
- Create: `packages/protocol/src/resource-policy.ts`
- Create: `packages/protocol/test/resource-policy.test.ts`
- Modify: `packages/protocol/src/run.ts`
- Modify: `packages/protocol/src/api/run.ts`
- Modify: `packages/protocol/src/api/daemon-info.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/api.test.ts`
- Modify: `packages/protocol/test/daemon-info.test.ts`
- Modify: `apps/daemon/src/services/run-service.ts`
- Modify: `apps/daemon/test/runs.test.ts`

**Interfaces:**
- Produces `RunResourcePolicySchema`, `RunResourcePolicy`, `DEFAULT_ADAPTIVE_RESOURCE_POLICY` only in the daemon, `normalizeCreateRunResourcePolicy(input)`, and a safe policy intersection helper.
- `CreateRunRequest` accepts either canonical `resourcePolicy` or legacy `limits`, with explicit normalization and no silent ambiguity.
- `AgentRun` can decode legacy stored rows without a policy and exposes the normalized policy to new execution code.

- [ ] **Step 1: Write failing schema and compatibility tests.**

  Cover: valid Adaptive policy; rejection of zero, negative, unsafe, `NaN`, `Infinity`, oversized durations, and invalid micro-USD values; `resourcePolicy` payload normalization; legacy `limits` normalization to `LEGACY_FIXED`; rejection when neither or both incompatible policy forms are present; Enterprise intersection preventing a request from increasing `maxCost` or `maxToolCalls`.

- [ ] **Step 2: Run the protocol tests and observe missing symbols.**

  ```bash
  pnpm exec vitest run packages/protocol/test/resource-policy.test.ts packages/protocol/test/api.test.ts packages/protocol/test/daemon-info.test.ts
  ```

  Expected: failure because the new schemas and normalization functions do not exist.

- [ ] **Step 3: Implement the additive policy contract.**

  Define strict Zod objects with positive safe integer validation. Keep existing `RunLimitsSchema` unchanged. Add optional `resourcePolicy` to stored/API contracts only where compatibility requires it, and implement one normalizer that maps legacy limits to hard limits plus a legacy deadline.

- [ ] **Step 4: Update daemon/run creation wiring.**

  Make the Run service normalize the request before persistence. New daemon-created Runs use the canonical Adaptive default. Existing requests containing only `limits` preserve legacy behavior. Ensure `DaemonInfo.defaultRunConfiguration` publishes the policy and retains the legacy `limits` compatibility projection where the current public contract requires it.

- [ ] **Step 5: Run the focused protocol and daemon tests.**

  ```bash
  pnpm exec vitest run packages/protocol/test/resource-policy.test.ts packages/protocol/test/api.test.ts packages/protocol/test/daemon-info.test.ts apps/daemon/test/runs.test.ts
  ```

- [ ] **Step 6: Commit the protocol migration.**

  ```bash
  git add packages/protocol apps/daemon/src/services/run-service.ts apps/daemon/test/runs.test.ts
  git diff --cached --check
  git commit -m "feat(protocol): add adaptive run resource policy"
  ```

### Task 3: Durable Resource State and Renewable Operational Lease

**Files:**
- Create: `packages/storage/drizzle/20260903120000_resource_governance/migration.sql`
- Create: `packages/storage/src/resource-governance-repository.ts`
- Create: `packages/storage/test/resource-governance-repository.test.ts`
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/storage.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/core/src/budget-ports.ts`
- Modify: `packages/storage/src/run-budget-port.ts`
- Modify: `packages/storage/test/migrations.test.ts`
- Modify: `packages/storage/test/run-budget-port.test.ts`

**Interfaces:**
- `ResourceGovernanceState` is a public package-neutral data contract with bounded progress summary and no raw args/output.
- `ResourceGovernanceRepository.get(runId)`, `createOrGet(runId, policy)`, `compareAndSwap(runId, expectedRevision, next)`, and `recover(runId, now)` are the only storage operations needed by Core.
- `RunBudgetPort.recover()` remains responsible for accounting recovery; governance recovery composes with it rather than replacing it.

- [ ] **Step 1: Add migration and repository tests first.**

  Test creation, durable lease epoch increments, CAS conflict rejection, bounded summary size, persistence across reopening SQLite, no raw Tool data in serialized state, and migration of an old database with an existing non-terminal Run.

- [ ] **Step 2: Run the storage tests to verify the new boundary is absent.**

  ```bash
  pnpm exec vitest run packages/storage/test/resource-governance-repository.test.ts packages/storage/test/migrations.test.ts
  ```

  Expected: failure because the migration/table/repository are not available.

- [ ] **Step 3: Implement the committed SQLite migration and Drizzle table.**

  Add a single row per Run keyed by `run_id`, indexed for recovery, with numeric fields for lease and escalation state, JSON for a bounded hashed summary, and revision/CAS support. Keep migration ordering compatible with the existing migration folder.

- [ ] **Step 4: Implement repository codecs and CAS.**

  Clone/validate protocol-safe state at boundaries, bound every summary collection, and translate SQLite conflicts to existing Storage errors. The public repository API must not expose `DatabaseSync`, Drizzle rows, or SQL clients.

- [ ] **Step 5: Compose storage and budget recovery.**

  Expose the repository through `CaelushStorage`, add the narrow Core port, and ensure reopening a database restores both exact accounting and the resource epoch/progress state without double counting reservations.

- [ ] **Step 6: Run focused and existing accounting suites.**

  ```bash
  pnpm exec vitest run packages/storage/test/resource-governance-repository.test.ts packages/storage/test/migrations.test.ts packages/storage/test/run-budget-port.test.ts packages/storage/test/recovery.test.ts
  ```

- [ ] **Step 7: Commit durable governance state.**

  ```bash
  git add packages/storage packages/core/src/budget-ports.ts
  git diff --cached --check
  git commit -m "feat(storage): persist resource governance state"
  ```

### Task 4: Progress Ledger and Deterministic Loop Detection

**Files:**
- Create: `packages/core/src/progress-ledger.ts`
- Create: `packages/core/src/resource-fingerprint.ts`
- Create: `packages/core/src/resource-loop-detector.ts`
- Create: `packages/core/test/resource-progress.test.ts`
- Create: `packages/core/test/resource-loop-detector.test.ts`
- Modify: `packages/tools/src/batch-types.ts`
- Modify: `packages/tools/src/dispatcher-types.ts`
- Modify: `packages/tools/src/dispatcher.ts`
- Modify: `packages/tools/test/dispatcher-execution.test.ts`
- Modify: `packages/tools/test/batch-coordinator.test.ts`

**Interfaces:**
- `ResourceFingerprintVersion = "v1"` and `fingerprintToolRequest(toolName, args)` / `fingerprintToolResult(resultIdentity)` return only bounded hash strings.
- `ProgressLedger.record(signal)` updates a bounded incremental summary and returns a deterministic `ProgressObservation`.
- `ResourceLoopDetector.evaluate(input)` returns `HEALTHY | OBSERVE | NUDGE | FORCED_REPLAN | WAITING_RESOURCE` based on policy thresholds and recent hashes.

- [ ] **Step 1: Write failing fingerprint and escalation tests.**

  Assert canonical key-order independence; same request plus same result repeats; same request plus changed result counts as new observation; different equivalent-looking search strings do not trigger rejection by themselves; three exact repeats produce NUDGE; four no-progress turns produce FORCED_REPLAN; two unsuccessful replans produce WAITING_RESOURCE; bounded state never grows beyond its configured window.

- [ ] **Step 2: Run the focused tests and observe missing implementations.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-progress.test.ts packages/core/test/resource-loop-detector.test.ts
  ```

  Expected: failure because the fingerprint and detector modules do not yet exist.

- [ ] **Step 3: Implement versioned hashing and bounded progress state.**

  Reuse the repository’s canonical JSON/hash utility through a Core-facing narrow adapter. Store only hashes and typed signal metadata. Update counters incrementally; never rescan full conversation or Tool history.

- [ ] **Step 4: Connect safe observation metadata from the Tool boundary.**

  Add internal, non-public observation identity data to the injected boundary without changing model-facing Tool results or public lifecycle events. Ensure dispatcher settlement and existing Tool Effects behavior remain unchanged.

- [ ] **Step 5: Implement deterministic escalation.**

  Make thresholds policy-driven. NUDGE is non-blocking; FORCED_REPLAN is a batch decision; WAITING_RESOURCE is a durable guard request. Do not emit `budget.exceeded` for any soft state.

- [ ] **Step 6: Run focused and Tool suites.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-progress.test.ts packages/core/test/resource-loop-detector.test.ts packages/tools/test/dispatcher-execution.test.ts packages/tools/test/batch-coordinator.test.ts
  ```

- [ ] **Step 7: Commit progress detection.**

  ```bash
  git add packages/core packages/tools/src packages/tools/test
  git diff --cached --check
  git commit -m "feat(core): detect no-progress execution loops"
  ```

### Task 5: Resource-aware AgentLoop and Replan Admission

**Files:**
- Create: `packages/core/src/resource-governor.ts`
- Create: `packages/core/test/resource-governor.test.ts`
- Modify: `packages/core/src/agent-loop-input.ts`
- Modify: `packages/core/src/agent-loop-ports.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/agent-continuation.ts`
- Modify: `packages/core/src/agent-continuation-schema.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/tools/src/batch-coordinator.ts`
- Modify: `packages/tools/src/batch-types.ts`
- Modify: `packages/tools/test/batch-coordinator.test.ts`
- Modify: `packages/core/test/agent-loop-resume.test.ts`
- Modify: `packages/core/test/run-controller-tool-integration.test.ts`

**Interfaces:**
- `ResourceGovernor.evaluateBeforeTurn(input)` returns a typed turn decision.
- `ResourceGovernor.evaluateToolBatch(input)` returns `ALLOW`, `ALLOW_WITH_NUDGE`, `RENEW_AND_ALLOW`, `REPLAN`, `WAIT_FOR_RESOURCE_DECISION`, or `HARD_STOP`.
- `ResourceGovernor.recordProgress(input)`, `evaluateAfterTurn(input)`, `renewLease(input)`, `resolveGuard(input)`, and `recover(input)` are injected ports with no direct database/Runtime dependency in AgentLoop.
- `RunController` remains the only owner of atomic Run/State/Step/Continuation/Event commits.

- [ ] **Step 1: Write failing adaptive admission tests.**

  Cover: four accounted calls plus a five-call Adaptive healthy batch renews/allows; default Adaptive mode does not hard-stop after eight lifetime operations; explicit `hardLimits.maxToolCalls: 8` rejects the ninth operation; a 17-call one-turn batch returns REPLAN; a replan creates five safe result entries and dispatches zero calls; an Adaptive final candidate still enters Verification.

- [ ] **Step 2: Run the focused tests and observe the expected missing behavior.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-governor.test.ts packages/core/test/agent-loop-resume.test.ts packages/core/test/run-controller-tool-integration.test.ts packages/tools/test/batch-coordinator.test.ts
  ```

- [ ] **Step 3: Implement the governor decision model.**

  Separate operational lease counters from `BudgetManager` financial admission. Reuse `BudgetManager` only for exact token/cost and configured hard Tool limits. Renew lease through the durable CAS port, then allow the complete batch.

- [ ] **Step 4: Add Agent Turn accounting at the provider-turn boundary.**

  Count one settled provider attempt per Agent Turn. Do not increment turn count for individual Tool calls, synthetic replan results, or a provider retry attempt outside the settled-turn contract. Preserve failed-step accounting rules.

- [ ] **Step 5: Add the replan continuation.**

  Preserve the complete open user turn and requested Tool calls. Generate one sanitized synthetic result for each call, normalize in source order, persist the continuation/event atomically, and resume with at most one provider call. Do not dispatch any item from the rejected batch.

- [ ] **Step 6: Add NUDGE/pressure guidance.**

  Inject only a bounded runtime guidance message for elevated decisions. Never include raw model output, Tool arguments, internal cost, thresholds, or database revisions. Keep normal healthy prompts unchanged.

- [ ] **Step 7: Run Core and Tool integration suites.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-governor.test.ts packages/core/test/agent-loop*.test.ts packages/core/test/run-controller-tool-integration.test.ts packages/tools/test/batch-coordinator.test.ts
  ```

- [ ] **Step 8: Commit resource-aware execution.**

  ```bash
  git add packages/core packages/tools/src/batch-coordinator.ts packages/tools/src/batch-types.ts packages/tools/test/batch-coordinator.test.ts
  git diff --cached --check
  git commit -m "feat(core): add resource-aware replan boundaries"
  ```

### Task 6: Timeout Separation, Discovery Guidance, Context Pressure, and Defaults

**Files:**
- Create: `packages/core/test/resource-timeout.test.ts`
- Create: `packages/context/test/resource-discovery.test.ts`
- Modify: `packages/core/src/run-deadline.ts`
- Modify: `packages/core/src/run-deadline-registry.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/context/src/relevant-file-planner.ts`
- Modify: `packages/context/src/context-builder.ts`
- Modify: `packages/context/test/context-builder.test.ts`
- Modify: `packages/context/test/relevant-file-planner.test.ts`
- Modify: `apps/daemon/src/daemon-composition.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/test/daemon-composition.test.ts`
- Modify: `docs/architecture/timeout.md`
- Modify: `docs/architecture/execution-governance.md`

**Interfaces:**
- Run deadline remains derived from the original `startedAt` and explicit hard Run deadline; PENDING and terminal Runs are disarmed.
- Context retains bounded synthetic model input and never appends relevant-file context to durable conversation.
- Daemon exposes one canonical Adaptive default; CLI/Web receive it through daemon info/client contracts.

- [ ] **Step 1: Write timeout and default tests first.**

  Assert Adaptive defaults contain no low lifetime `maxToolCalls` and no implicit 10-second Run timeout; legacy payload still derives the old deadline; provider/tool/process timeout errors do not transition the entire Run to `TIMEOUT`; long timer delays rearm correctly; equality at deadline is expired.

- [ ] **Step 2: Write discovery/context pressure tests.**

  Use a fixture workspace to assert the planner prefers bounded `find_files`/targeted search facts, does not recursively scan above the workspace, and that repeated Tool output is projected within context limits while durable messages remain complete.

- [ ] **Step 3: Run tests and observe expected failures.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-timeout.test.ts packages/context/test/resource-discovery.test.ts apps/daemon/test/daemon-composition.test.ts
  ```

- [ ] **Step 4: Implement timeout ownership changes.**

  Keep provider/tool/process timeouts at their existing boundaries. Use resource policy only for inactivity signals and explicit hard Run deadlines. Do not pass remaining Run time as a replacement provider timeout.

- [ ] **Step 5: Implement bounded discovery/context changes.**

  Reuse Project Intelligence and existing filesystem constraints. Add only guidance/planning changes required for broad discovery; keep Context independent from Core/LLM and keep synthetic context out of the ledger.

- [ ] **Step 6: Replace daemon production defaults.**

  Remove the `maxSteps: 8`, `maxToolCalls: 8`, `timeoutMs: 10_000` Adaptive production default. Preserve an explicit legacy configuration path and validate all environment/config overrides against the same policy schema and Enterprise intersection.

- [ ] **Step 7: Run focused Core/Context/daemon suites and commit.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-timeout.test.ts packages/core/test/run-deadline*.test.ts packages/context/test/resource-discovery.test.ts packages/context/test/context-builder.test.ts apps/daemon/test/daemon-composition.test.ts
  git add packages/core packages/context apps/daemon docs/architecture/timeout.md docs/architecture/execution-governance.md
  git diff --cached --check
  git commit -m "feat(runtime): separate long-run timeout semantics"
  ```

### Task 7: Durable Resource Guard, Continue, Client, CLI, and Web

**Files:**
- Create: `packages/protocol/src/events/resource.ts`
- Create: `packages/client/src/control/resource.ts`
- Create: `packages/client/test/resource-control.test.ts`
- Modify: `packages/protocol/src/events/index.ts`
- Modify: `packages/protocol/src/events/base.ts`
- Modify: `packages/protocol/src/run.ts`
- Modify: `packages/protocol/src/api/run-actions.ts`
- Modify: `packages/client/src/client.ts`
- Modify: `packages/client/src/control/index.ts`
- Modify: `packages/client/src/control/run-control.ts`
- Modify: `packages/client/src/session-projection.ts`
- Modify: `apps/daemon/src/routes/runs.ts`
- Modify: `apps/daemon/src/execution/run-execution-supervisor.ts`
- Modify: `apps/daemon/test/execution-routes.test.ts`
- Modify: `apps/cli/src/application/cli-control.ts`
- Modify: `apps/cli/src/application/cli-controller.ts`
- Modify: `apps/cli/src/application/print-host.ts`
- Modify: `apps/cli/test/cli-control.test.ts`
- Modify: `apps/cli/test/cli-controller-recovery.test.ts`
- Modify: `apps/web/src/application/session-manager.ts`
- Modify: `apps/web/src/components/run-status.ts`
- Modify: `apps/web/src/components/session-workspace.ts`
- Modify: `apps/web/src/components/session-sidebar.ts`
- Modify: `apps/web/test/resource-control.test.ts`
- Modify: `apps/web/test/session-manager.test.ts`
- Modify: `apps/web/test/presentation.test.tsx`

**Interfaces:**
- `RunStatus` adds non-terminal `WAITING_RESOURCE`.
- `CaelushClient.continueResourceGuard(runId)` invokes the canonical action endpoint and parses the existing action response.
- Public Resource Guard projection exposes safe state, recent counts, elapsed time, and mutation/verification counts where already available; it never exposes raw hashes, args, output, or fake percentages.

- [ ] **Step 1: Write failing protocol/client/control tests.**

  Assert `WAITING_RESOURCE` is non-terminal and cancellable; a guard event parses; Continue uses the same Run ID; invalid guard payloads fail closed; client does not send policy overrides or Approval bypass data.

- [ ] **Step 2: Run focused tests and observe missing contracts.**

  ```bash
  pnpm exec vitest run packages/client/test/resource-control.test.ts apps/web/test/resource-control.test.ts apps/daemon/test/execution-routes.test.ts
  ```

- [ ] **Step 3: Implement additive protocol event/action contracts and daemon route.**

  Add only bounded safe Resource Guard fields. Route Continue through RunController’s canonical guard-resolution method. A Continue may renew an operational lease but may not raise Enterprise hard limits or skip Approval/Verification.

- [ ] **Step 4: Implement client shared projection/control helpers.**

  Keep resource semantics in `@caelush/client`; CLI and Web consume those helpers. Preserve SSE validation rules and durable sequence IDs.

- [ ] **Step 5: Implement CLI and Web presentation.**

  Add an inline guard card, accessible status icon, Continue and Cancel controls, and safe Chinese/English presentation strings. Do not add dashboards, settings, lease-number cards, or fake completion percentages.

- [ ] **Step 6: Test recovery and security boundaries.**

  Verify Reload restores `WAITING_RESOURCE`, Continue resumes the original continuation, Cancel remains canonical, pending Approval is still required, hard ceilings remain enforced, and no Tool executes twice.

- [ ] **Step 7: Run focused package suites and commit.**

  ```bash
  pnpm exec vitest run packages/protocol/test packages/client/test apps/daemon/test/execution-routes.test.ts apps/cli/test/cli-control.test.ts apps/cli/test/cli-controller-recovery.test.ts apps/web/test/resource-control.test.ts apps/web/test/session-manager.test.ts apps/web/test/presentation.test.tsx
  git add packages/protocol packages/client apps/daemon apps/cli apps/web
  git diff --cached --check
  git commit -m "feat(web): add resource guard continuation control"
  ```

### Task 8: Long-workload Integration, Release Validation, Review, and Git Seal

**Files:**
- Create: `packages/core/test/resource-long-run.test.ts`
- Create: `packages/storage/test/resource-recovery.test.ts`
- Create: `apps/daemon/test/resource-long-run-e2e.test.ts`
- Create: `apps/web/test/resource-guard.e2e.test.ts`
- Create: `docs/superpowers/reports/2026-09-03-agent-runtime-resource-governance.md`
- Modify: existing release/E2E fixtures only where required to include both legacy and canonical payloads

**Interfaces:**
- The synthetic workload records Tool operations, Agent Turns, lease renewals, progress signals, and final Run status.
- The completion report contains actual Git SHAs, test exit codes/counts, security findings, model audit, reviewer verdict, and delivery seal; it must not claim an unrun check.

- [ ] **Step 1: Write long-run and recovery tests.**

  Add a deterministic workspace scan with more than eight Tool operations and a synthetic workload with more than 100 operations, multiple lease renewals, healthy progress, and final Verification-driven completion. Add a no-progress workload that reaches NUDGE → REPLAN → WAITING_RESOURCE, reloads, Continue resumes the same Run, and Cancel stops it.

- [ ] **Step 2: Run the new integration tests before any release claim.**

  ```bash
  pnpm exec vitest run packages/core/test/resource-long-run.test.ts packages/storage/test/resource-recovery.test.ts apps/daemon/test/resource-long-run-e2e.test.ts apps/web/test/resource-guard.e2e.test.ts
  ```

- [ ] **Step 3: Run the full validation sequence and record exact results.**

  ```bash
  git diff --check
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm test:web:e2e
  pnpm build:release
  pnpm test:release
  ```

  If a command is unavailable or fails, record the command, exit code, and failure; do not substitute a partial command or report PASS.

- [ ] **Step 4: Perform changed-file and architecture review.**

  Inspect `git diff 5f526ad90c0638c6e8bae342ad43c6b4f63cd7bd..HEAD`, run `git diff --check`, verify no deep cross-package imports, no duplicate default policy constants, no raw fingerprint data in public payloads, no Tool execution in Core governance, and no Completion Authority regression.

- [ ] **Step 5: Run the independent review only if a Luna-capable reviewer is available.**

  The review scope is the full branch from `5f526ad90c0638c6e8bae342ad43c6b4f63cd7bd` to `HEAD`, using exactly `gpt-5.6-luna`. Require an explicit `APPROVED / CLEAN / PASS` verdict covering adaptive non-kill behavior, renewable leases, deterministic progress, exact-repeat correctness, cardinality-preserving replan, hard cost, legacy compatibility, recovery, durable guard, timeout separation, workspace discovery, bounded context, Security/Approval, and Verification. Silent reviewers are not PASS.

- [ ] **Step 6: Complete the report from verified evidence.**

  Fill every section required by the approved specification: Git, root cause, architecture, policy, compatibility, durable storage, progress, loop detection, Agent awareness, discovery, context pressure, timeout, guard controls, long-workload evidence, hard ceilings, recovery, tests, security, model audit, independent review, delivery seal, and final local cleanup.

- [ ] **Step 7: Push and seal the task branch when network is available.**

  ```bash
  git push -u origin codex/runtime-resource-governance-refactor
  git rev-parse HEAD
  git ls-remote origin refs/heads/codex/runtime-resource-governance-refactor
  ```

  Require local and remote task SHAs to match. If the network/TLS failure persists, report the delivery seal as blocked rather than claiming PASS.

- [ ] **Step 8: Fast-forward master only after all gates pass.**

  ```bash
  git switch master
  git merge --ff-only codex/runtime-resource-governance-refactor
  git push origin master
  git rev-parse HEAD
  git ls-remote origin refs/heads/master
  git branch -d codex/runtime-resource-governance-refactor
  git branch
  git worktree list
  git status --short
  ```

  Require final local master, remote master, and task remote SHA equality; `master` only; the main worktree only; and a clean status. Never use `git branch -D`.
