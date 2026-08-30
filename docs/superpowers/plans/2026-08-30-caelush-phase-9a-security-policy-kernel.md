# Caelush Phase 9A Security Policy Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, Run-derived Security Policy Kernel and integrate its Gate decisions with the existing Tool Dispatcher, batch coordinator, recovery path, and RunController without implementing Phase 9B/9C/9D.

**Architecture:** `@caelush/tools` remains the owner of the ToolExecutionGatePort and receives a JSON-safe ToolSecurityContext alongside the runtime environment. `@caelush/security` implements the port using existing protocol policy metadata, a deterministic capability resolver, containment classifier, and precedence-ordered evaluator. The Dispatcher owns persistence and invocation lifecycle; RunController derives policy from durable `AgentRun` and verifies it matches `AgentState`.

**Tech Stack:** TypeScript ESM, Zod 4 protocol schemas, Vitest, pnpm workspace, SQLite/Drizzle existing storage contracts, ESLint, Prettier.

**Spec:** `docs/superpowers/specs/2026-08-30-caelush-phase-9a-security-policy-kernel-design.md`

## Global Constraints

- Phase 9 contains exactly 9A, 9B, 9C, and 9D; do not create Phase 9E or another round.
- Reuse `PermissionProfile`, `ApprovalPolicy`, `Capability`, and `RiskLevel` from `@caelush/protocol`; do not create V2 duplicates.
- `ToolExecutionEnvironment` and `ToolSecurityContext` are different contracts; runtime environment remains `{ workspace, runtime }`.
- Security context is derived from durable `AgentRun`, never from the model, Tool arguments, or environment variables.
- Capability denial takes precedence over approval; approval cannot grant a missing capability.
- `READ_ONLY` grants `FS_READ` and `GIT_READ` only.
- `PROJECT_ACCESS` grants project read/write/delete, Git read, and process capabilities, but has no hard OS sandbox for arbitrary shell/process execution.
- `FULL_ACCESS` grants the complete current capability set but does not disable Phase 8 structured Tool path invariants.
- `ALWAYS_ASK` asks for every otherwise capability-authorized Tool; `DANGEROUS_ONLY` allows LOW/MEDIUM and asks for HIGH/CRITICAL; `NEVER_ASK` never emits `REQUIRE_APPROVAL`.
- `PROJECT_ACCESS + NEVER_ASK + UNCONFINED_PROCESS` is `DENY`; `FULL_ACCESS + NEVER_ASK` may allow capability-authorized unconfined process Tools.
- Security decisions and errors must not include raw Tool arguments, shell commands, stdin, file contents, environment variables, or host absolute paths.
- Security evaluation is pure/deterministic and performs no filesystem, network, storage, EventBus, clock, or randomness I/O.
- ToolDispatcher remains the lifecycle owner; Security does not write Storage or publish events.
- Phase 9A adds no database migration and does not implement approval persistence/resolution, command policy, sensitive-file policy, secret redaction, cancellation, timeout, retry, budget, verification execution, or hard OS sandboxing.
- Never run `prettier --write .`; preserve the measured 517-file repository formatting debt and format only changed files when needed.
- Final evidence must include plain `pnpm test` without retry, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`, `pnpm check`, and `git diff --check`.

## Actual baseline and file map

The required Git baseline was revalidated. `origin/master` is `ea7efabd5b96dbce3103d80bfafa9ef949ff2241`, Phase 8D is `8d45c92e0ec6c2c45e69dc0c4026f5a9d90f65a7`, and the merge-base check returned non-ancestor. Worktree: `.worktrees/phase-9a-security-policy-kernel`; branch: `codex/phase-9a-security-policy-kernel`; base ref: `origin/codex/phase-8d-git-runtime-builtins-finalization`.

Baseline `pnpm test` was run plainly after build completion: 184 files passed, 616 tests passed, 4 skipped. A concurrent build/test invocation also produced one transient `process-manager` EXITED/RUNNING failure and 38 import failures; the focused process-manager test and the subsequent serial plain run passed, so no Phase 8 runtime change is authorized by current evidence. Baseline `pnpm format:check` reports 517 warning files.

Files to create or modify:

- Create `packages/security/src/capabilities.ts`: immutable profile-to-capability resolver.
- Create `packages/security/src/containment.ts`: capability-based `ExecutionContainment` classifier.
- Create `packages/security/src/decision.ts`: stable decision code and public SecurityDecision types.
- Create `packages/security/src/errors.ts`: sanitized invariant/context errors.
- Create `packages/security/src/evaluator.ts`: pure precedence-ordered evaluator.
- Create `packages/security/src/tool-gate.ts`: `ToolExecutionGatePort` adapter using evaluator and invocation/definition invariants.
- Modify `packages/security/src/index.ts` and `packages/security/package.json`: public exports and `@caelush/protocol`/`@caelush/tools` workspace dependencies.
- Modify `packages/tools/src/dispatcher-ports.ts`: extend Gate input/decision with context and safe diagnostics while preserving three decision kinds.
- Modify `packages/tools/src/dispatcher-types.ts` and `packages/tools/src/batch-types.ts`: add strict `ToolSecurityContext` to dispatch/batch requests.
- Modify `packages/tools/src/batch-coordinator.ts`: validate and forward context unchanged to each dispatch request.
- Modify `packages/tools/src/dispatcher.ts`: validate the durable-context path, pass context to the Gate, and preserve recovery semantics.
- Modify `packages/core/src/run-controller.ts`: derive context from `AgentRun`, compare it with `AgentState`, and include it in every Tool batch.
- Modify `packages/core/src/run-controller-ports.ts` only if the actual integration requires a narrowly typed Gate construction seam; do not make Core depend on Security.
- Add focused tests under `packages/security/test`, `packages/tools/test`, `packages/core/test`, and `packages/storage/test` following existing fixture patterns.
- Add `tests/architecture/security-boundaries.test.ts` and public API/declaration checks as needed.
- Create `docs/architecture/security.md`; update `README.md` and `AGENTS.md` only after implementation verification.

## Task 1: Characterize the Phase 8D Tool catalog and existing Gate

**Files:**
- Test: `packages/tools/test/security-catalog-characterization.test.ts`
- Read: `packages/tools/src/builtins/default-tools.ts`, the nine built-in registration files, `packages/tools/src/dispatcher-ports.ts`, and existing dispatcher tests.

**Interfaces:**
- Consumes: `createDefaultBuiltinToolRegistrations`, `ToolDefinition`, `ToolExecutionGatePort`.
- Produces: executable characterization assertions for actual names, risk levels, and required capabilities; no fake metadata list.

- [ ] **Step 1: Write the failing characterization test** asserting the nine catalog entries and actual metadata, including `apply_patch` write/delete, shell/process capabilities, and Git read capabilities.
- [ ] **Step 2: Run `pnpm exec vitest run packages/tools/test/security-catalog-characterization.test.ts` and confirm it fails only if the expected actual metadata is wrong or the test file is not yet wired.
- [ ] **Step 3: Implement only test fixture setup using existing registration factories; do not change built-in definitions to satisfy expectations.
- [ ] **Step 4: Run the focused test and record the actual matrix.
- [ ] **Step 5: Commit `test(tools): characterize phase 8d security metadata`.

## Task 2: Add strict ToolSecurityContext contracts and propagation

**Files:**
- Modify: `packages/tools/src/dispatcher-types.ts`, `packages/tools/src/batch-types.ts`, `packages/tools/src/batch-coordinator.ts`, `packages/tools/src/dispatcher.ts`, `packages/tools/src/index.ts`
- Test: `packages/tools/test/security-context.test.ts`, `packages/tools/test/dispatcher-contracts.test.ts`, `packages/tools/test/batch-coordinator.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolSecurityContext {
    readonly permissionProfile: PermissionProfile;
    readonly approvalPolicy: ApprovalPolicy;
  }
  export interface ToolDispatchRequest { securityContext: ToolSecurityContext; }
  export interface ToolBatchRequest { securityContext: ToolSecurityContext; }
  ```
  `assertToolSecurityContext` and request assertions reject null, arrays, missing/invalid fields, and extra keys.

- [ ] **Step 1: Write tests for valid profiles/policies, invalid values, null, array, missing field, and `additionalProperties`; update existing request fixtures to express the intended new contract.
- [ ] **Step 2: Run the focused Tool tests and verify RED with the missing-field/extra-key failures.
- [ ] **Step 3: Implement the context type and runtime assertions using `PermissionProfileSchema` and `ApprovalPolicySchema`; add the required field to batch and dispatch validation.
- [ ] **Step 4: Update `ToolBatchCoordinator.toDispatchRequest` to pass the same context object/value to every item and update Dispatcher recovery APIs so recovery receives context from the request path.
- [ ] **Step 5: Run focused Tool tests and the existing dispatcher/batch suites; refactor only after green.
- [ ] **Step 6: Commit `feat(tools): propagate run security context`.

## Task 3: Implement capability resolver and containment classifier

**Files:**
- Create: `packages/security/src/capabilities.ts`, `packages/security/src/containment.ts`
- Test: `packages/security/test/capabilities.test.ts`, `packages/security/test/containment.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolveGrantedCapabilities(profile: PermissionProfile): ReadonlySet<Capability>;
  export type ExecutionContainment = "STRUCTURED_WORKSPACE" | "UNCONFINED_PROCESS";
  export function classifyExecutionContainment(required: readonly Capability[]): ExecutionContainment;
  export function requiresUnconfinedProcess(required: readonly Capability[]): boolean;
  ```

- [ ] **Step 1: Write tests for all three profile matrices, all ten current capabilities, set immutability/determinism, and process-capability classification independent of Tool name.
- [ ] **Step 2: Run the two focused tests and verify RED.
- [ ] **Step 3: Implement static frozen capability data and capability-based containment logic; do not import Runtime or use mutable module state.
- [ ] **Step 4: Run focused tests and assert unknown future LOW Tools with empty requirements remain structured.
- [ ] **Step 5: Commit `feat(security): add capability and containment policy primitives`.

## Task 4: Add SecurityDecision contract and pure evaluator

**Files:**
- Create: `packages/security/src/decision.ts`, `packages/security/src/errors.ts`, `packages/security/src/evaluator.ts`
- Test: `packages/security/test/decision-matrix.test.ts`, `packages/security/test/safe-reason.test.ts`, `packages/security/test/evaluator-purity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SecurityDecisionCode =
    | "ALLOWED_BY_POLICY"
    | "MISSING_REQUIRED_CAPABILITY"
    | "APPROVAL_POLICY_REQUIRES_REVIEW"
    | "DANGEROUS_ACTION_REQUIRES_REVIEW"
    | "UNCONFINED_EXECUTION_REQUIRES_REVIEW"
    | "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL";
  export type SecurityDecision =
    | { readonly kind: "ALLOW"; readonly reasonCode: "ALLOWED_BY_POLICY"; readonly safeReason: string }
    | { readonly kind: "DENY"; readonly reasonCode: Exclude<SecurityDecisionCode, "ALLOWED_BY_POLICY" | "APPROVAL_POLICY_REQUIRES_REVIEW" | "DANGEROUS_ACTION_REQUIRES_REVIEW" | "UNCONFINED_EXECUTION_REQUIRES_REVIEW">; readonly safeReason: string }
    | { readonly kind: "REQUIRE_APPROVAL"; readonly reasonCode: "APPROVAL_POLICY_REQUIRES_REVIEW" | "DANGEROUS_ACTION_REQUIRES_REVIEW" | "UNCONFINED_EXECUTION_REQUIRES_REVIEW"; readonly safeReason: string };
  export interface SecurityPolicyInput {
    readonly permissionProfile: PermissionProfile;
    readonly approvalPolicy: ApprovalPolicy;
    readonly riskLevel: RiskLevel;
    readonly requiredCapabilities: readonly Capability[];
  }
  export interface SecurityPolicyEvaluator { evaluate(input: SecurityPolicyInput): SecurityDecision; }
  export function evaluateSecurityPolicy(input: SecurityPolicyInput): SecurityDecision;
  ```

- [ ] **Step 1: Write matrix tests covering every profile/policy combination, capability precedence, PROJECT_ACCESS shell restriction, FULL_ACCESS shell allow, unknown future Tool metadata, and stable reason codes.
- [ ] **Step 2: Run focused matrix tests and verify RED.
- [ ] **Step 3: Write sentinel privacy tests with command/path/token values in a separate ignored fixture input and assert no sentinel appears in `reasonCode`, `safeReason`, or evaluator errors; the evaluator API must not accept args.
- [ ] **Step 4: Implement the fixed nine-step algorithm in order: validate input, resolve capabilities, missing capability denial, classify containment, apply PROJECT_ACCESS unconfined branch, then approval policy.
- [ ] **Step 5: Run focused tests and review the implementation for `Date.now`, randomness, I/O imports, raw args, Tool-name branches, and mutable output.
- [ ] **Step 6: Commit `feat(security): add permission policy evaluator`.

## Task 5: Implement the real ToolExecutionGate adapter

**Files:**
- Create: `packages/security/src/tool-gate.ts`
- Modify: `packages/security/src/index.ts`, `packages/tools/src/dispatcher-ports.ts`, `packages/tools/src/index.ts`
- Test: `packages/security/test/tool-gate.test.ts`, `packages/tools/test/dispatcher-contracts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class CaelushToolExecutionGate implements ToolExecutionGatePort {
    decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision>;
  }
  ```
  Gate input includes `securityContext`; Gate output keeps `kind` and may include `reasonCode`/`safeReason` diagnostics. The adapter validates invocation risk equals definition risk and fails closed with a sanitized invariant error on mismatch.

- [ ] **Step 1: Write tests for valid conversion, risk mismatch invariant failure, missing/invalid context rejection, and no raw-argument leakage.
- [ ] **Step 2: Run the focused Gate tests and verify RED.
- [ ] **Step 3: Implement adapter-only validation and conversion to `SecurityPolicyInput`; the evaluator must consume only context and definition metadata, not invocation args.
- [ ] **Step 4: Export the stable public API and run `pnpm --filter @caelush/security build` plus focused tests.
- [ ] **Step 5: Commit `feat(security): add tool execution policy gate`.

## Task 6: Integrate ALLOW, DENY, and REQUIRE_APPROVAL with Dispatcher and batch

**Files:**
- Modify: `packages/tools/src/dispatcher.ts`, `packages/tools/src/batch-coordinator.ts`, related Tool tests
- Test: `packages/tools/test/dispatcher-security-integration.test.ts`, `packages/tools/test/batch-security-boundary.test.ts`

**Interfaces:**
- Consumes: `ToolDispatchRequest.securityContext`, `ToolExecutionGateDecision`, existing durable Store and handler ports.
- Produces: ALLOW invokes a handler exactly once; DENY persists `PERMISSION_DENIED` in phase `SECURITY` with `isError=true`; REQUIRE_APPROVAL persists `WAITING_APPROVAL` and never invokes a handler; batch returns completed prefix and stops at approval.

- [ ] **Step 1: Write ALLOW/DENY/approval integration tests with handler and mutation counters plus batch prefix/suffix assertions.
- [ ] **Step 2: Run focused integration tests and verify RED against missing context/real Gate behavior.
- [ ] **Step 3: Wire the context into Gate invocation and ensure Dispatcher catches Gate invariant/input failures before any durable Tool side effect. Keep generic model-facing denial text.
- [ ] **Step 4: Add the batch known-DENY case proving the next item continues, distinct from `UNCERTAIN_SIDE_EFFECT`.
- [ ] **Step 5: Run focused Tool and existing Dispatcher/Batch suites; commit `test(tools): integrate security gate lifecycle decisions`.

## Task 7: Preserve Dispatcher recovery semantics with durable context

**Files:**
- Modify: `packages/tools/src/dispatcher.ts`, `packages/tools/src/batch-coordinator.ts`
- Test: `packages/tools/test/dispatcher-security-recovery.test.ts`, existing `dispatcher-recovery.test.ts`

**Interfaces:**
- Consumes: `recoverOrDispatch(request)` and `recover(invocationId, environment, securityContext)` or the equivalent final typed signature.
- Produces: REQUESTED is re-gated using the supplied durable Run-derived context; WAITING_APPROVAL stays waiting; RUNNING becomes existing uncertainty result; terminal states reuse observation without Gate/handler.

- [ ] **Step 1: Write recovery tests for REQUESTED denied, WAITING_APPROVAL unchanged despite current policy changes, RUNNING no rerun, and COMPLETED no Gate call.
- [ ] **Step 2: Run focused recovery tests and verify RED.
- [ ] **Step 3: Implement only the recovery context plumbing and state guards; do not add approval cache/resume semantics.
- [ ] **Step 4: Run recovery, idempotency, failure, and stale-side-effect suites.
- [ ] **Step 5: Commit `test(tools): preserve security decisions across recovery boundaries`.

## Task 8: Propagate durable Run policy through RunController

**Files:**
- Modify: `packages/core/src/run-controller.ts` and only necessary core port/type files
- Test: `packages/storage/test/run-controller-security-context.test.ts`, `packages/storage/test/run-controller-tool-integration.test.ts`

**Interfaces:**
- Produces helper behavior equivalent to:
  ```ts
  function securityContextFor(run: AgentRun): ToolSecurityContext;
  ```
  Before constructing a ToolBatchRequest, verify `snapshot.state.permissionProfile === snapshot.run.permissionProfile` and the same for approval policy; mismatch throws `RunControllerInvariantError` and does not call the coordinator.

- [ ] **Step 1: Write an E2E test proving AgentRun policy flows to a real `CaelushToolExecutionGate` through RunController → ToolBatch → Dispatcher, plus a mismatch fail-closed test.
- [ ] **Step 2: Run the focused storage/core test and verify RED.
- [ ] **Step 3: Derive the context from `snapshot.run`, compare with State, and include it in the batch request for both execute and recovery paths.
- [ ] **Step 4: Run existing RunController tool, recovery, restart, and state tests.
- [ ] **Step 5: Commit `test(core): propagate durable run security policy`.

## Task 9: Run-level security E2Es and full matrices

**Files:**
- Test: `packages/storage/test/run-controller-security-e2e.test.ts`, `packages/tools/test/security-policy-matrix.test.ts`

- [ ] **Step 1: Add READ_ONLY E2E: read succeeds, patch produces permission-denied Tool result, next model turn produces final candidate, Run ends at `VERIFYING`.
- [ ] **Step 2: Add PROJECT_ACCESS + DANGEROUS_ONLY patch E2E: invocation and Run are `WAITING_APPROVAL`, handler/mutation count is zero, and test stops without fake approval.
- [ ] **Step 3: Add PROJECT_ACCESS + NEVER_ASK patch ALLOW, PROJECT_ACCESS + NEVER_ASK shell DENY with zero process count, and FULL_ACCESS + NEVER_ASK safe shell ALLOW with exit code 0.
- [ ] **Step 4: Run focused E2Es and all Phase 7/8 regression suites; document genuine RED→GREEN evidence in the completion report.
- [ ] **Step 5: Commit `test(core): cover phase 9a run security e2e`.

## Task 10: Architecture, public declaration, privacy, and scope audits

**Files:**
- Create/modify: `tests/architecture/security-boundaries.test.ts`, public API tests, `packages/security/test/public-api.test.ts`

- [ ] **Step 1: Write architecture tests asserting Security imports only protocol/tools-port/shared, Tools never import Security, and Security source contains no `node:fs`, `node:child_process`, `node:net`, `node:http`, `node:https`, Runtime, Core, Storage, Events, LLM, or app imports.
- [ ] **Step 2: Run architecture tests and verify RED.
- [ ] **Step 3: Implement/adjust exports and dependency declarations; build declarations and assert no Runtime/Storage/private database types leak from `@caelush/security`.
- [ ] **Step 4: Search new Security code for `invocation.args`, command/stdin/environment interpolation, `Date.now`, random APIs, and I/O imports; remove any leak or nondeterminism.
- [ ] **Step 5: Verify no new migration, approval endpoint, command parser, redaction engine, sandbox, cancellation, timeout, retry, budget, or verification runner exists in the diff.
- [ ] **Step 6: Commit `test(security): add architecture and privacy audits`.

## Task 11: Documentation and durable rules

**Files:**
- Create: `docs/architecture/security.md`
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 1: Write the security architecture document with the Run → Security Context → Gate diagram, exact capability/approval matrices, algorithm, stable codes, containment semantics, PROJECT_ACCESS shell limitation, FULL_ACCESS/NEVER_ASK behavior, and explicit Permission != Approval != Sandbox boundaries.
- [ ] **Step 2: Add source/observed/adopted/not-copied notes for Codex safety/sandboxing/permissions and OpenCode permissions.
- [ ] **Step 3: Update README phase status without claiming sandboxing, redaction, completed approval workflow, or production-complete security.
- [ ] **Step 4: Add the frozen Phase 9A rules to AGENTS.md, including no 9E and no Phase 9B/9C/9D leakage.
- [ ] **Step 5: Run changed-file Prettier check only; do not rewrite the repository.
- [ ] **Step 6: Commit `docs: define phase 9a security policy kernel`.

## Task 12: Full verification and delivery

**Files:**
- Modify: none unless verification identifies a Phase 9A defect.

- [ ] **Step 1: Run focused security capability, containment, decision, privacy, context, Dispatcher, batch, recovery, and Run E2E tests without retry.
- [ ] **Step 2: Remove only generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` using explicit Node fs/PowerShell paths; never use `git clean` or broad recursive deletion.
- [ ] **Step 3: Run `pnpm install --frozen-lockfile`, then sequentially `pnpm lint`, `pnpm typecheck`, plain `pnpm test`, and `pnpm build`.
- [ ] **Step 4: Run `pnpm format:check`, changed-file Prettier checks, `pnpm check`, and `git diff --check`; report the pre-existing 517-file format debt separately and ensure Phase 9A files have zero warnings.
- [ ] **Step 5: Audit `git status --short`, `git diff --stat`, `git diff`, migrations, public declarations, package boundaries, scope boundaries, and all completion-gate checklist items.
- [ ] **Step 6: Push the actual task branch with `git push -u origin codex/phase-9a-security-policy-kernel`; verify `git rev-parse HEAD` equals `git ls-remote` for that exact branch. Do not merge master, force-push, or create a PR.
- [ ] **Step 7: Report baseline, ConPTY status/root-cause evidence, tests, format counts, architecture references, decision matrices, lifecycle/recovery proof, boundaries, commit SHAs, push SHA match, and working-tree state in the required Phase 9A Completion Report.

## Completion checklist

- [ ] `@caelush/security` implements and publicly exports the policy kernel and real Gate adapter.
- [ ] All protocol policy enums are reused without duplicates.
- [ ] Context is strict/runtime validated and propagated through batch/dispatch/recovery.
- [ ] Run is policy authority and State mismatch fails closed.
- [ ] Capability precedence, containment, approval matrices, privacy, and deterministic purity are tested.
- [ ] Dispatcher ALLOW/DENY/WAITING_APPROVAL behavior and batch boundary are verified with handler/mutation counts.
- [ ] REQUESTED/WAITING_APPROVAL/RUNNING/terminal recovery semantics are preserved.
- [ ] READ_ONLY, PROJECT_ACCESS, and FULL_ACCESS Run E2Es pass without Phase 9B behavior.
- [ ] No migrations, approval resolution, command policy, redaction, or OS sandbox are introduced.
- [ ] Lint, typecheck, plain full test, build, changed-file formatting, and required audits have fresh evidence.
- [ ] Branch is pushed and local/remote SHA match; final working tree is clean.
