# Caelush Phase 11B Deterministic Verification Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve and safely execute supported PROJECT verification checks from fresh Phase 5 project facts, persist bounded redacted evidence atomically, and keep the Run at `VERIFYING` until later Phase 11 rounds.

**Architecture:** Keep verification domain behavior in `@caelush/verification` behind provider-independent structural ports. Add a narrow typed-argv entry to the existing Runtime and a host-command Security adapter, then connect them through the existing Core RunController and SQLite durable event boundary. Verification never becomes a ToolInvocation and never owns storage, process primitives, cancellation authority, timeout policy, or completion authority.

**Tech Stack:** TypeScript 6, Node.js 24, pnpm workspaces, Zod 4, Vitest 4, SQLite/Drizzle, existing `LocalProcessManager`, existing Phase 5 `ProjectProfileDetector`, existing Phase 9 command policy and secret redaction.

**Spec:** `docs/superpowers/specs/2026-08-31-caelush-phase-11b-verification-execution-design.md`

## Global Constraints

- Phase 11 contains exactly 11A, 11B, 11C, and 11D; this plan implements only 11B.
- Phase 11B executes only PROJECT verification checks: LINT, TYPECHECK, TEST, and BUILD.
- Phase 11B must reuse the Phase 5 ProjectProfile and must not implement a second project detector, manifest parser, lockfile detector, or package-manager detector.
- Project verification commands are discovered from project evidence; they must never be guessed solely from language/file extensions.
- Repository-provided scripts are untrusted input; Node pre/main/post lifecycle bodies all participate in security analysis.
- Raw script bodies must never enter durable VerificationPlan, AgentState, Conversation, ToolObservation, or public Agent events.
- Verification is a host action, not a ToolInvocation; no fake ToolInvocation, ToolDispatcher path, Tool effects, Tool budget, or AgentState process projection is allowed.
- Verification must reuse `LocalProcessManager`, `WorkspacePathResolver`, the existing output buffer/environment policy, and `shell:false`; no second process manager or shell runtime is allowed.
- Typed argv verification is `executable + args`, `tty:false`, no stdin writes, and must not change existing `exec_command` string behavior.
- Verification remains subject to Phase 9 Security, the Run permission/approval profile, logical containment, the Run AbortSignal, and the Run deadline.
- `REVIEW_REQUIRED`, `DENY`, and `SYSTEM_DESTRUCTIVE` execute zero processes and settle the affected Check safely as `ERROR`; Phase 11B adds no Verification ApprovalRequest workflow.
- Verification output is redacted and byte-bounded before persistence; raw secrets must not enter SQLite, events, or public results.
- Check start persists `RUNNING + DISCOVERY evidence + verification.check.started` before external process launch.
- Check settlement persists terminal Check + COMMAND evidence + `verification.check.completed` atomically, then publishes committed events.
- A stale RUNNING verification Check is never automatically replayed after restart.
- Cancellation and Run deadline remain the only terminal authorities for the Run; there is no verification timeout system.
- Verification does not increment Tool-call, Agent Step, LLM-token, LLM-cost, or budget accounting.
- Successful PROJECT checks do not authorize `COMPLETED`; WORKSPACE, GIT, and TASK checks remain pending.
- Do not implement repair loops, LLM reviewers, `VERIFYING → RUNNING`, `VERIFYING → COMPLETED`, `run.completed`, `finalResult`, CLI/Web verification UI, HTTP verification API, MCP, Browser, Computer Use, remote runtime, or hard sandboxing.
- Production code is written only after a focused test has been observed failing for the expected missing behavior.
- The final full-repository format warning count must be no greater than the Phase 11B baseline of 637; all Phase 11B changed files must have zero Prettier warnings.

---

## File Map

### Protocol

- Modify `packages/protocol/src/limits.ts` for the exported evidence serialized-byte cap.
- Modify `packages/protocol/src/verification.ts` for lifecycle/timestamp invariants and bounded evidence details.
- Modify `packages/protocol/src/events/verification.ts` for Check start/completion event schemas and factories/types.
- Modify `packages/protocol/src/events/index.ts` to include the new event schemas in `AgentEventSchema` and exports.
- Test `packages/protocol/test/verification-contracts.test.ts` and `packages/protocol/test/verification-events.test.ts`.

### Verification domain

- Create `packages/verification/src/contracts.ts` for structural ProjectProfile, candidate, security, Runtime, storage, and runner ports.
- Create `packages/verification/src/candidate.ts` for deterministic candidate construction and SHA-256 hashing.
- Create `packages/verification/src/lifecycle.ts` for the pure Check transition validator.
- Create `packages/verification/src/evidence.ts` for safe evidence normalization and byte bounding.
- Create `packages/verification/src/resolver.ts` for the resolver registry and shared resolver types.
- Create `packages/verification/src/node-resolver.ts` for exact Node script resolution and lifecycle inputs.
- Create `packages/verification/src/rust-resolver.ts` for Cargo offline resolution.
- Create `packages/verification/src/java-resolver.ts` for conservative Maven/Gradle offline resolution.
- Create `packages/verification/src/runner.ts` for the storage-free project-check execution coordinator.
- Modify `packages/verification/src/index.ts` to expose only public domain contracts and implementations.
- Create focused tests under `packages/verification/test/` for contracts, lifecycle, candidates, resolvers, evidence, and runner behavior.

### Runtime

- Modify `packages/runtime/src/exec/contracts.ts` with `RuntimeArgvExecRequest` and the typed-argv service method.
- Modify `packages/runtime/src/exec/service.ts` to validate and execute typed argv through the existing process manager and environment policy.
- Modify `packages/runtime/src/exec/index.ts` to export the public typed-argv contract.
- Test `packages/runtime/test/exec-service.test.ts`, `packages/runtime/test/exec-contracts.test.ts`, and a dedicated typed-argv test if the existing files become too broad.

### Security

- Create `packages/security/src/verification-admission.ts` as the host-command adapter over existing Phase 9 policy primitives.
- Modify `packages/security/src/index.ts` to export the adapter and its result type without exposing internal implementation details.
- Create `packages/security/test/verification-admission.test.ts` for capability, command-classification, lifecycle-body, secret, review, deny, and system-destructive cases.

### Storage and Core

- Create `packages/storage/src/verification-execution-store.ts` for narrow SQLite start/settlement transactions and recovery reads.
- Modify `packages/storage/src/storage.ts` and `packages/storage/src/index.ts` to expose the execution adapter through the existing public API.
- Modify `packages/core/src/run-controller-ports.ts`, `packages/core/src/run-controller-input.ts`, and `packages/core/src/run-controller.ts` to inject and drive the runner after the 11A Final Candidate commit.
- Modify `packages/core/src/run-execution-state.ts` only if a narrowly tested VERIFYING recovery invariant is required; do not add a new Run status or continuation type.
- Add Core/Storage integration tests under `packages/core/test/` and `packages/storage/test/`.

### Composition, architecture, and docs

- Modify the daemon/local composition root only to wire the existing ProjectInspector, LocalRuntime, Phase 9 Security adapter, SQLite execution adapter, and runner.
- Add architecture guards under `tests/architecture/` for forbidden imports and forbidden scope leakage.
- Create `docs/architecture/verification-execution.md`.
- Modify `docs/architecture/verification.md`, `docs/architecture/runtime.md`, `docs/architecture/security.md`, `docs/architecture/context-and-project-intelligence.md`, `README.md`, and `AGENTS.md` with only Phase 11B statements.

---

## Task 1: Strengthen Protocol Check and Evidence Contracts

**Files:**

- Modify: `packages/protocol/src/limits.ts`
- Modify: `packages/protocol/src/verification.ts`
- Modify: `packages/protocol/src/events/verification.ts`
- Modify: `packages/protocol/src/events/index.ts`
- Test: `packages/protocol/test/verification-contracts.test.ts`
- Test: `packages/protocol/test/verification-events.test.ts`

**Interfaces:**

- `VerificationCheckSchema` must accept only the lifecycle/timestamp combinations defined by the spec.
- Export `MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES = 32 * 1024` from the protocol limits surface.
- Add `VerificationCheckStartedEventSchema` for `verification.check.started` with `planId`, `checkId`, `ordinal`, `kind`, `purpose`, and `stage`.
- Add `VerificationCheckCompletedEventSchema` for `verification.check.completed` with `planId`, `checkId`, terminal `status`, `evidenceIds`, and optional `durationMs`.

- [ ] **Step 1: Write the failing lifecycle tests.** Add tests for PENDING, RUNNING, PASSED, FAILED, SKIPPED, preflight ERROR, execution ERROR, and CANCELLED timestamp invariants. Include terminal mutation rejection and an oversized/multibyte JSON evidence details case.

```ts
expect(() => VerificationCheckSchema.parse({ ...pending, startedAt: now })).toThrow();
expect(() => VerificationCheckSchema.parse({ ...running, finishedAt: now })).toThrow();
expect(() => VerificationCheckSchema.parse({ ...skipped, skipReason: undefined })).toThrow();
expect(() =>
  VerificationEvidenceSchema.parse({ ...evidence, details: multibytePayload }),
).toThrow();
```

- [ ] **Step 2: Run the protocol tests and verify RED.**

Run: `pnpm exec vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/verification-events.test.ts`

Expected: FAIL because the current schema permits invalid timestamps, has no serialized byte cap, and does not export the new event schemas.

- [ ] **Step 3: Implement the smallest schema/event change.** Use a `superRefine` that distinguishes preflight ERROR (`startedAt` absent) from execution ERROR (`startedAt` present), requires monotonic `finishedAt >= startedAt` for started checks, and validates details using `Buffer.byteLength(JSON.stringify(details), "utf8")` without coercion. Add the two new event schemas to the discriminated union while preserving legacy events unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/verification-events.test.ts`

Expected: PASS with no new warnings.

- [ ] **Step 5: Run the package typecheck and commit.**

Run: `pnpm --filter @caelush/protocol typecheck`

Commit: `feat(protocol): enforce verification lifecycle and check events`

## Task 2: Add Verification Domain Ports, Lifecycle, Candidate Hashing, and Evidence Normalization

**Files:**

- Create: `packages/verification/src/contracts.ts`
- Create: `packages/verification/src/lifecycle.ts`
- Create: `packages/verification/src/candidate.ts`
- Create: `packages/verification/src/evidence.ts`
- Modify: `packages/verification/src/index.ts`
- Test: `packages/verification/test/lifecycle.test.ts`
- Test: `packages/verification/test/candidate.test.ts`
- Test: `packages/verification/test/evidence.test.ts`

**Interfaces:**

```ts
export interface VerificationCommandSecurityInput {
  readonly kind: "SCRIPT" | "COMMAND";
  readonly label: string;
  readonly body: string;
  readonly workdir: string;
}

export interface VerificationCommandCandidate {
  readonly checkId: VerificationCheck["id"];
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly provenance: {
    readonly ecosystem: string;
    readonly resolver: string;
    readonly evidencePath?: string;
    readonly scriptName?: string;
  };
  readonly securityInputs: readonly VerificationCommandSecurityInput[];
  readonly candidateHash: string;
}

export type ProjectCheckResolution =
  | { readonly kind: "READY"; readonly candidate: VerificationCommandCandidate }
  | { readonly kind: "UNAVAILABLE"; readonly reason: VerificationDiscoveryReason };
```

- [ ] **Step 1: Write failing tests for transitions, deterministic hashes, and evidence bounds.** Assert the allowed transition table, reject terminal mutation, assert identical candidate inputs produce identical SHA-256 hashes, and assert redaction/bounding occurs before evidence details are returned.

- [ ] **Step 2: Run focused tests and verify RED.**

Run: `pnpm exec vitest run packages/verification/test/lifecycle.test.ts packages/verification/test/candidate.test.ts packages/verification/test/evidence.test.ts`

Expected: FAIL because the new modules and exported functions do not exist.

- [ ] **Step 3: Implement pure domain helpers.** Add `assertVerificationCheckTransition(previous, next)`, `createVerificationCandidate(input)`, `computeVerificationCandidateHash(input)`, `createDiscoveryEvidence(input)`, and `createCommandEvidence(input)`. Candidate hashing must use stable JSON ordering and include resolver version, executable, args, relative workdir, manifest evidence path, and ordered lifecycle bodies. Evidence helpers must accept redaction/bounding ports rather than import Security or Runtime.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/verification/test/lifecycle.test.ts packages/verification/test/candidate.test.ts packages/verification/test/evidence.test.ts`

Expected: PASS with deterministic hashes and no raw script/output in the durable evidence structures.

- [ ] **Step 5: Run package typecheck and commit.**

Run: `pnpm --filter @caelush/verification typecheck`

Commit: `feat(verification): add candidate lifecycle and evidence domain`

## Task 3: Implement the Resolver Registry and Exact Node Resolver

**Files:**

- Create: `packages/verification/src/resolver.ts`
- Create: `packages/verification/src/node-resolver.ts`
- Modify: `packages/verification/src/index.ts`
- Test: `packages/verification/test/node-resolver.test.ts`
- Test: `packages/verification/test/resolver-registry.test.ts`

**Interfaces:**

```ts
export interface VerificationProjectPackage {
  readonly relativePath: string;
  readonly scripts: readonly { readonly name: string; readonly command: string }[];
}

export interface VerificationProjectProfile {
  readonly ecosystems: readonly string[];
  readonly packageManager: { readonly name: string; readonly source?: string };
  readonly tooling: readonly { readonly name: string; readonly evidencePaths: readonly string[] }[];
  readonly isMonorepo: boolean;
  readonly rootPackage?: VerificationProjectPackage;
  readonly activePackage?: VerificationProjectPackage;
}

export interface ProjectCheckResolver {
  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution;
}

export class ProjectCheckResolverRegistry {
  resolve(check: VerificationCheck, profile: VerificationProjectProfile): ProjectCheckResolution;
}
```

- [ ] **Step 1: Write failing Node resolver tests.** Cover `pnpm lint`, `npm typecheck`, `type-check` fallback, `yarn test`, `bun build`, root precedence, active fallback, unknown/ambiguous package managers, missing exact scripts, no fuzzy aliases, lifecycle body ordering, no installer/dlx commands, and deterministic candidate hashes.

- [ ] **Step 2: Run focused tests and verify RED.**

Run: `pnpm exec vitest run packages/verification/test/node-resolver.test.ts packages/verification/test/resolver-registry.test.ts`

Expected: FAIL because no resolver registry or Node resolver exists.

- [ ] **Step 3: Implement exact Node resolution.** Select root package first, use active package only if root lacks the exact alias, map package managers to `executable + ["run", scriptName]`, and return bounded reasons for unknown/ambiguous manager or missing script. Collect only existing `pre<script>`, main, and `post<script>` entries from the selected package; put raw bodies only into ephemeral `securityInputs` and candidate hash input.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/verification/test/node-resolver.test.ts packages/verification/test/resolver-registry.test.ts`

Expected: PASS; no result contains `npx`, `pnpx`, `yarn dlx`, `bunx`, install, fetch, or sync commands.

- [ ] **Step 5: Run package typecheck and commit.**

Run: `pnpm --filter @caelush/verification typecheck`

Commit: `feat(verification): add deterministic project check resolvers`

## Task 4: Add Rust, Java, and Conservative Unsupported Resolvers

**Files:**

- Create: `packages/verification/src/rust-resolver.ts`
- Create: `packages/verification/src/java-resolver.ts`
- Modify: `packages/verification/src/resolver.ts`
- Test: `packages/verification/test/rust-resolver.test.ts`
- Test: `packages/verification/test/java-resolver.test.ts`
- Test: `packages/verification/test/unsupported-resolver.test.ts`

**Interfaces:**

```ts
export const rustProjectCheckResolver: ProjectCheckResolver;
export const javaProjectCheckResolver: ProjectCheckResolver;
export const unsupportedProjectCheckResolver: ProjectCheckResolver;
```

- [ ] **Step 1: Write failing Rust/Java/unsupported tests.** Assert Cargo `TYPECHECK`, `TEST`, and `BUILD` candidates contain `--offline`, Rust LINT is unavailable, Maven uses `mvn -o test` and `mvn -o -DskipTests package`, Gradle uses `gradle --offline test` and `gradle --offline build`, Java LINT/TYPECHECK are unavailable, ambiguous tooling is unavailable, and Python/Go never produce guessed commands.

- [ ] **Step 2: Run focused tests and verify RED.**

Run: `pnpm exec vitest run packages/verification/test/rust-resolver.test.ts packages/verification/test/java-resolver.test.ts packages/verification/test/unsupported-resolver.test.ts`

Expected: FAIL because the non-Node resolver registrations do not exist.

- [ ] **Step 3: Implement conservative resolvers.** Require explicit `tooling` evidence for Cargo, Maven, or Gradle. Treat more than one Java tool as `TOOLING_UNAVAILABLE`. Return `ECOSYSTEM_UNSUPPORTED` or `TOOLING_UNAVAILABLE` for unsupported/insufficient facts instead of selecting a command based on an extension.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/verification/test/rust-resolver.test.ts packages/verification/test/java-resolver.test.ts packages/verification/test/unsupported-resolver.test.ts`

Expected: PASS with stable candidate provenance and no network/install command.

- [ ] **Step 5: Run package typecheck and commit.**

Run: `pnpm --filter @caelush/verification typecheck`

Commit: `feat(verification): support offline rust and java checks`

## Task 5: Add Typed-Argv Execution to the Existing Runtime

**Files:**

- Modify: `packages/runtime/src/exec/contracts.ts`
- Modify: `packages/runtime/src/exec/service.ts`
- Modify: `packages/runtime/src/exec/index.ts`
- Test: `packages/runtime/test/exec-service.test.ts`
- Test: `packages/runtime/test/exec-contracts.test.ts`
- Test: `packages/runtime/test/typed-argv-exec.test.ts`

**Interfaces:**

```ts
export interface RuntimeArgvExecRequest {
  readonly signal?: AbortSignal;
  readonly ownerRunId: RunId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir?: string;
  readonly yieldTimeMs: number;
}

export interface RuntimeExecService {
  execute(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
  executeArgv(request: RuntimeArgvExecRequest): Promise<RuntimeExecResult>;
  interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult>;
}
```

- [ ] **Step 1: Write failing typed-argv tests.** Assert exact executable and args reach the adapter, `shell:false` remains enforced, `tty:false` is used, workspace-relative workdir is resolved through `WorkspacePathResolver`, outside-workspace/NUL/argument-count/argument-byte violations are rejected, and the existing string `execute()` behavior remains unchanged. Add an AbortSignal test that closes the owned process.

- [ ] **Step 2: Run focused Runtime tests and verify RED.**

Run: `pnpm exec vitest run packages/runtime/test/exec-service.test.ts packages/runtime/test/exec-contracts.test.ts packages/runtime/test/typed-argv-exec.test.ts`

Expected: FAIL because `executeArgv` and typed argv validation do not exist.

- [ ] **Step 3: Implement the narrow Runtime entry.** Validate non-empty executable without NUL, at most 128 args, each arg at most 16 KiB UTF-8, total argv at most 64 KiB UTF-8, and resolve `workdir ?? "."` through the existing path resolver. Call `LocalProcessManager.start` with `{ launch: { executable, args }, tty: false }`, the existing bounded environment, owner Run ID, signal, and yield time. Do not touch shell resolver logic used by `execute()`.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/runtime/test/exec-service.test.ts packages/runtime/test/exec-contracts.test.ts packages/runtime/test/typed-argv-exec.test.ts`

Expected: PASS, including existing `exec_command` regressions.

- [ ] **Step 5: Run Runtime typecheck and commit.**

Run: `pnpm --filter @caelush/runtime typecheck`

Commit: `feat(runtime): add typed argv execution path`

## Task 6: Add Phase 9 Verification Host Security Admission

**Files:**

- Create: `packages/security/src/verification-admission.ts`
- Modify: `packages/security/src/index.ts`
- Test: `packages/security/test/verification-admission.test.ts`

**Interfaces:**

```ts
export interface VerificationCommandSecurityPort {
  assess(input: {
    readonly permissionProfile: PermissionProfile;
    readonly approvalPolicy: ApprovalPolicy;
    readonly executable: string;
    readonly args: readonly string[];
    readonly workdir: string;
    readonly inputs: readonly VerificationCommandSecurityInput[];
  }): VerificationSecurityDecision;
}

export type VerificationSecurityDecision =
  | { readonly kind: "ALLOW"; readonly safeReason: string }
  | { readonly kind: "REVIEW_REQUIRED"; readonly reasonCode: string; readonly safeReason: string }
  | { readonly kind: "DENY"; readonly reasonCode: string; readonly safeReason: string };
```

- [ ] **Step 1: Write failing Security tests.** Cover safe commands with required capabilities, missing `SHELL_EXEC`/`PROCESS_START`, `ALWAYS_ASK` and unconfined review, network/destructive/opaque/secret-bearing scripts, dangerous pre/post lifecycle bodies, `SYSTEM_DESTRUCTIVE`, and `NEVER_ASK` deny. Assert the adapter returns safe reasons and never starts a Runtime process itself.

- [ ] **Step 2: Run focused Security tests and verify RED.**

Run: `pnpm exec vitest run packages/security/test/verification-admission.test.ts`

Expected: FAIL because no host-command adapter exists.

- [ ] **Step 3: Implement the adapter by reusing Phase 9 primitives.** Build a typed host-command fact for each lifecycle body, call existing capability evaluation and `evaluateInputSecurityPolicy`, combine decisions using existing precedence, and force `SYSTEM_DESTRUCTIVE` to DENY. Map `REQUIRE_APPROVAL` to `REVIEW_REQUIRED`; do not create an ApprovalRequest, ToolDefinition, ToolInvocation, or Tool event.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/security/test/verification-admission.test.ts packages/security/test/command-policy.test.ts packages/security/test/secret-redaction.test.ts`

Expected: PASS; review and deny decisions remain process-free.

- [ ] **Step 5: Run Security typecheck and commit.**

Run: `pnpm --filter @caelush/security typecheck`

Commit: `feat(security): add verification host command admission`

## Task 7: Add Storage-Free Verification Runner Coordination

**Files:**

- Create: `packages/verification/src/runner.ts`
- Modify: `packages/verification/src/index.ts`
- Test: `packages/verification/test/runner.test.ts`

**Interfaces:**

```ts
export interface VerificationCommandExecutionPort {
  executeArgv(request: RuntimeArgvExecRequest): Promise<RuntimeExecResult>;
  interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult>;
}

export interface VerificationExecutionStorePort {
  startCheck(input: VerificationStartCommit): Promise<VerificationStartCommitResult>;
  settleCheck(input: VerificationSettlementCommit): Promise<VerificationSettlementCommitResult>;
}

export interface VerificationRunner {
  run(input: VerificationRunnerInput): Promise<VerificationRunnerResult>;
}
```

- [ ] **Step 1: Write failing runner tests.** Use in-memory structural ports to cover discovery unavailable (`IF_AVAILABLE → SKIPPED`, `REQUIRED → ERROR`), security review/deny with zero execution calls, durable start-before-runtime ordering, exit 0/non-zero/spawn failure mapping, redacted bounded evidence, empty-string polling, and no Tool/LLM/Step accounting.

- [ ] **Step 2: Run the runner tests and verify RED.**

Run: `pnpm exec vitest run packages/verification/test/runner.test.ts`

Expected: FAIL because `VerificationRunner` does not exist.

- [ ] **Step 3: Implement the storage-free coordinator.** Accept the immutable plan/check list, fresh structural profile, Run metadata, clock, signal, resolver registry, security port, execution port, storage port, event ID/check evidence ID factories, and redaction/bounding functions. Resolve in ordinal order; call `startCheck` before `executeArgv`; poll only with `chars: ""`; normalize/redact/bound output; call `settleCheck`; and return safe counts/blocking ID. Never import storage, tools, llm, child_process, or node-pty.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/verification/test/runner.test.ts packages/verification/test/evidence.test.ts`

Expected: PASS with no raw command/script/output in runner results.

- [ ] **Step 5: Run package typecheck and commit.**

Run: `pnpm --filter @caelush/verification typecheck`

Commit: `feat(verification): add project check execution coordinator`

## Task 8: Add Atomic Verification Start and Settlement Storage

**Files:**

- Create: `packages/storage/src/verification-execution-store.ts`
- Modify: `packages/storage/src/storage.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/verification-execution-store.test.ts`

**Interfaces:**

```ts
export interface VerificationExecutionStorePort {
  startCheck(input: VerificationStartCommit): Promise<VerificationStartCommitResult>;
  settleCheck(input: VerificationSettlementCommit): Promise<VerificationSettlementCommitResult>;
  getPlanExecutionSnapshot(
    planId: VerificationPlanId,
  ): Promise<VerificationExecutionSnapshot | null>;
}
```

- [ ] **Step 1: Write failing SQLite tests.** Assert start writes Check RUNNING, Discovery evidence, and `verification.check.started` in one transaction; a Check or event insertion failure rolls back both and no external process is called; settlement writes terminal Check, Command evidence, and `verification.check.completed` atomically; events are published only after commit; duplicate terminal settlement cannot create a second event; and evidence details are decoded through the Protocol schema.

- [ ] **Step 2: Run focused Storage tests and verify RED.**

Run: `pnpm exec vitest run packages/storage/test/verification-execution-store.test.ts`

Expected: FAIL because no atomic verification execution store exists.

- [ ] **Step 3: Implement transactions on the existing SQLite database.** Reuse `verification_plans`, `verification_checks`, `verification_evidence`, `appendDurableEventsInTransaction`, current codec/schema checks, and durable sequence assignment. Update only the selected Check by ID with optimistic status validation; insert append-only evidence; construct new verification Check event drafts; commit first and return committed events for the existing notifier. Do not create any new verification table or a second event bus.

- [ ] **Step 4: Run focused Storage tests and verify GREEN.**

Run: `pnpm exec vitest run packages/storage/test/verification-execution-store.test.ts packages/storage/test/verification-repository.test.ts`

Expected: PASS with atomic rollback and publish-after-persist behavior.

- [ ] **Step 5: Run Storage typecheck and commit.**

Run: `pnpm --filter @caelush/storage typecheck`

Commit: `feat(storage): add atomic verification execution persistence`

## Task 9: Connect Verification Driving to RunController and Composition

**Files:**

- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-execution-state.ts` only for tested recovery invariant adjustments
- Modify: the existing daemon/local composition root that constructs `RunController`
- Test: `packages/core/test/run-controller-verification.test.ts`
- Test: `packages/core/test/run-controller-recovery.test.ts`

**Interfaces:**

```ts
export interface VerificationRunnerPort {
  run(input: VerificationRunnerInput): Promise<VerificationRunnerResult>;
}

export interface ProjectProfileProviderPort {
  getFreshProfile(run: AgentRun, config: RunExecutionConfig): Promise<VerificationProjectProfile>;
}

export interface RunControllerDependencies {
  // existing fields remain unchanged
  readonly verificationRunner?: VerificationRunnerPort;
  readonly projectProfileProvider?: ProjectProfileProviderPort;
}
```

- [ ] **Step 1: Write failing Core integration tests.** Assert the Final Candidate transaction commits/publishes before the first verification start call; configured runner drives only PROJECT checks in ordinal order; absent runner leaves the Run at `AWAITING_VERIFICATION`/`VERIFYING` without marking checks passed; all PROJECT checks passing returns safe counts while Run remains `VERIFYING`; no LLM, Tool, Step, conversation, or budget counters change; and Workspace/Git/Task checks remain PENDING.

- [ ] **Step 2: Run Core tests and verify RED.**

Run: `pnpm exec vitest run packages/core/test/run-controller-verification.test.ts packages/core/test/run-controller-recovery.test.ts`

Expected: FAIL because RunController has no verification runner dependency or drive path.

- [ ] **Step 3: Implement the Core boundary.** Add optional runner/profile-provider dependencies so existing compositions remain valid. After the existing Final Candidate commit and event notification, call the runner with a fresh profile and the current Run scope signal. Do not put external process execution in the Final Candidate transaction. Convert runner output to a safe `AWAITING_VERIFICATION` result; never alter Plan structure, call AgentLoop, change Run to RUNNING/COMPLETED, emit `run.completed`, or set `finalResult`.

- [ ] **Step 4: Add cancellation/deadline and recovery tests before changing behavior.** Create a long-running fake execution port and assert `cancel(runId)` aborts the owned process, settles the Run as `CANCELLED`, and starts no trailing check. Advance the existing Run deadline and assert `TIMEOUT`, cleanup, and no trailing check. Construct a stale durable RUNNING Check and assert recovery performs zero Runtime/Tool/LLM calls and leaves the Run VERIFYING. Construct a PENDING next Check with no stale RUNNING Check and assert only that Check can execute.

- [ ] **Step 5: Run Core focused tests and verify GREEN.**

Run: `pnpm exec vitest run packages/core/test/run-controller-verification.test.ts packages/core/test/run-controller-recovery.test.ts packages/core/test/run-controller-cancellation.test.ts packages/core/test/run-controller-timeout.test.ts`

Expected: PASS with canonical Run cancellation/deadline authority and conservative recovery.

- [ ] **Step 6: Run Core and composition typechecks and commit.**

Run: `pnpm --filter @caelush/core typecheck; pnpm --filter @caelush/storage typecheck`

Commit: `feat(core): drive durable project verification checks`

## Task 10: Add Cross-Layer Security, Recovery, and Architecture Guards

**Files:**

- Modify: `tests/architecture/package-boundaries.test.ts`
- Modify: `tests/architecture/process-runtime-boundaries.test.ts`
- Modify: `tests/architecture/security-boundaries.test.ts`
- Create/modify: `packages/verification/test/architecture.test.ts`
- Create: `packages/core/test/verification-e2e.test.ts`
- Create: `packages/storage/test/verification-restart.test.ts`

**Interfaces:**

- The guards must fail if verification imports storage, tools, llm, child_process, or node-pty; runtime/security/context import verification; AgentLoop imports or constructs a VerificationRunner; or ToolDispatcher is used by verification.
- The E2E fixtures must use real file-backed SQLite and injectable Runtime/Security ports, while process execution remains owned by the existing Runtime package.

- [ ] **Step 1: Write failing architecture and E2E tests.** Assert no duplicate detector/parser arrays exist under verification, forbidden guessed command strings are absent, raw secrets/scripts are absent from SQLite/events/results, check started/completed events are exactly once, completed checks are not rerun after restart, stale RUNNING performs zero process executions, and PENDING recovery runs only the next PENDING check.

- [ ] **Step 2: Run the new guards and verify RED.**

Run: `pnpm exec vitest run tests/architecture packages/verification/test/architecture.test.ts packages/core/test/verification-e2e.test.ts packages/storage/test/verification-restart.test.ts`

Expected: FAIL on missing implementation and any forbidden import/path until the feature is fully connected.

- [ ] **Step 3: Implement only the fixtures and guards needed to prove the contracts.** Use real storage lifecycle, injected fake clock/scope, and deterministic fake process outcomes. Do not weaken guards to match an implementation shortcut. Ensure no Tool effects, ToolInvocation, Agent Step, LLM, or budget ledger record appears for verification.

- [ ] **Step 4: Run the guards and E2E tests and verify GREEN.**

Run: `pnpm exec vitest run tests/architecture packages/verification/test/architecture.test.ts packages/core/test/verification-e2e.test.ts packages/storage/test/verification-restart.test.ts`

Expected: PASS with event exact-once, restart preservation, no replay, and no scope leakage.

- [ ] **Step 5: Run all package typechecks and commit.**

Run: `pnpm typecheck`

Commit: `test: cover phase 11b verification execution boundaries`

## Task 11: Document the Phase 11B Boundary and Run Final Verification

**Files:**

- Create: `docs/architecture/verification-execution.md`
- Modify: `docs/architecture/verification.md`
- Modify: `docs/architecture/runtime.md`
- Modify: `docs/architecture/security.md`
- Modify: `docs/architecture/context-and-project-intelligence.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `tests/architecture/workspace-shape.test.ts` when documentation/phase markers are guarded there

**Interfaces:**

- Documentation must describe Intent → Candidate → Security → typed argv Runtime → Evidence, the exact resolver aliases, lifecycle analysis, redaction/bytes, durable boundaries, fail-fast, cancellation/deadline, stale recovery, and 11B exclusions.
- README must state 11A and 11B COMPLETED, 11C and 11D NOT STARTED, and Phase 11 IN PROGRESS without claiming all tasks can be proven complete.
- AGENTS.md must contain the durable Phase 11B rules from the spec and must not erase existing Phase 1–10 rules.

- [ ] **Step 1: Write failing documentation/architecture assertions where existing architecture tests can prove required boundaries.** Assert the new docs mention typed argv and shared ProcessManager, Phase 5 reuse, host-action/no-ToolInvocation, lifecycle script security, redaction, and no completion authority.

- [ ] **Step 2: Run the focused documentation/architecture tests and verify RED.**

Run: `pnpm exec vitest run tests/architecture`

Expected: FAIL until the required documentation and imports/phase markers exist.

- [ ] **Step 3: Write the documentation and phase status updates.** Keep claims factual: local process verification may have workspace side effects and the current V1 boundary is logical/policy-based, not a hard OS sandbox. Describe legacy verification contracts as compatibility-only.

- [ ] **Step 4: Run focused architecture tests and verify GREEN.**

Run: `pnpm exec vitest run tests/architecture`

Expected: PASS.

- [ ] **Step 5: Run the complete focused verification gate serially.**

Run in order:

```text
pnpm exec vitest run packages/protocol/test/verification-contracts.test.ts packages/protocol/test/verification-events.test.ts
pnpm exec vitest run packages/verification/test
pnpm exec vitest run packages/runtime/test/exec-service.test.ts packages/runtime/test/exec-contracts.test.ts packages/runtime/test/typed-argv-exec.test.ts
pnpm exec vitest run packages/security/test/verification-admission.test.ts packages/security/test/command-policy.test.ts packages/security/test/secret-redaction.test.ts
pnpm exec vitest run packages/storage/test/verification-execution-store.test.ts packages/storage/test/verification-restart.test.ts
pnpm exec vitest run packages/core/test/run-controller-verification.test.ts packages/core/test/run-controller-recovery.test.ts packages/core/test/verification-e2e.test.ts
pnpm exec vitest run tests/architecture
```

Expected: every command exits 0; any existing flaky ConPTY output must be separately identified rather than hidden.

- [ ] **Step 6: Run the full regression gate serially.**

Run: `pnpm lint`, then `pnpm typecheck`, then `pnpm test`, then `pnpm build`.

Expected: each command exits 0; `pnpm test` must pass directly without `--retry`.

- [ ] **Step 7: Perform clean-build verification without destructive Git commands.** Use a Node filesystem command to remove only `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` beneath the current worktree. Do not run `git clean`, `git reset --hard`, or checkout commands. Repeat `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` serially.

- [ ] **Step 8: Verify formatting and repository state.** Run `pnpm format:check` and record the warning count; it must be no greater than 637. Run an exact changed-file Prettier check for `git diff --name-only` against the selected Phase 11B base and require zero warnings. Run `git diff --check` and `git status --short`; resolve only Phase 11B issues and leave the worktree clean before the final commit.

- [ ] **Step 9: Commit the final documentation/verification changes.** Use a coherent commit message such as `docs: define phase 11b verification execution` only if no earlier commit already uses it; otherwise use `chore: finalize phase 11b delivery gate`. Inspect `git diff` and `git status --short` before committing.

- [ ] **Step 10: Push and verify the remote SHA.** Run `git push -u origin codex/phase-11b-deterministic-verification-runner-project-discovery`, then compare `git rev-parse HEAD` with `git ls-remote --heads origin refs/heads/codex/phase-11b-deterministic-verification-runner-project-discovery`. Never force-push, merge master automatically, or create a PR.

## Plan self-review

The plan covers all design sections: fresh Phase 5 profile reuse, resolver
registry and exact Node aliases, lifecycle script security, Rust/Java offline
commands, conservative Python/Go behavior, typed argv Runtime reuse, Phase 9
host admission, evidence bounds/redaction, durable start/settlement/events,
fail-fast, cancellation/deadline, accounting isolation, PENDING/stale recovery,
SQLite restart, event exact-once, architecture guards, docs, and final gates.

The plan contains no implementation placeholders. Every production change has
a focused RED/GREEN cycle, and every later interface is defined before it is
consumed. The plan does not introduce a Phase 11E or any Phase 11C/11D
functionality.
