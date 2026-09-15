import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 3C durable Run driver boundary guards.
 *
 * Phase 3C split one decision into three objects, and each of them has an authority it must not
 * exceed:
 *
 * ```text
 * Coordinator        pure: no DB, no clock, no identifier, no I/O
 * TransitionPlanner  pure: it describes a transition, it never writes one
 * Driver             executes one effect: it writes no Run status and owns no retry
 * RunController      the only object that commits a lifecycle transition
 * ```
 *
 * These guards are structural, so a later refactor cannot quietly move a write into the decision.
 * The contract-level guarantee lives in `packages/agent/test/contracts/phase-3c-frozen-run-contracts.test.ts`,
 * which fails `pnpm typecheck` on any shape drift; these are the structural half.
 */

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8").replaceAll("\r\n", "\n");
}

/** A file's executable code, with its documentation removed. */
function executable(relativePath: string): string {
  return read(relativePath)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * A file's executable code with string literals removed too.
 *
 * A refusal message that names a contract is not a use of it. A guard that counted the name inside
 * a message would flag the very error text that documents why the contract is not implemented, so
 * the check for "who actually names this type" reads identifiers only.
 */
function identifiers(relativePath: string): string {
  return executable(relativePath).replaceAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function runLayerFiles(): string[] {
  return sourceFiles(join(root, "packages", "agent", "src", "run")).map((path) =>
    relative(root, path).replaceAll("\\", "/"),
  );
}

describe("Phase 3C agent run layer boundaries", () => {
  it("imports only the two target packages", () => {
    const violations: string[] = [];
    for (const file of runLayerFiles()) {
      for (const specifier of moduleSpecifiers(read(file))) {
        if (!specifier.startsWith("@caelush/")) continue;
        if (specifier === "@caelush/ai" || specifier === "@caelush/protocol") continue;
        violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("names no storage, runtime, verification or legacy Tool implementation", () => {
    // The Run Layer legitimately knows the Protocol Run entities — the canonical execution
    // snapshot *is* an AgentRun plus an AgentState plus an AgentStep. What it must not name is a
    // storage client, an execution substrate, a verification runner or a Tool implementation.
    const forbidden =
      /\b(?:RunRepository|CaelushStorage|DatabaseSync|drizzle|sqlite|LocalRuntime|RuntimeWorkspaceScope|VerificationRunner|VerificationPlan|ToolDispatcher|ToolRegistry|ToolInvocation|ObservationId)\b/;
    const violations: string[] = [];
    for (const file of runLayerFiles()) {
      if (forbidden.test(executable(file))) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("keeps the Run Layer free of the legacy durable message encoding", () => {
    const violations: string[] = [];
    for (const file of runLayerFiles()) {
      for (const specifier of moduleSpecifiers(read(file))) {
        if (specifier === "@caelush/llm" || specifier.startsWith("@caelush/llm/")) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the coordinator pure", () => {
    const coordinator = executable("packages/agent/src/run/run-execution-coordinator.ts");
    // No clock, no identifier, no randomness, no I/O, no scheduling.
    expect(coordinator).not.toMatch(
      /\b(?:Date\.now|new Date|Math\.random|randomUUID|setTimeout|setInterval)\b/,
    );
    expect(coordinator).not.toMatch(/\b(?:await|async)\b/);
    expect(coordinator).not.toMatch(/\b(?:node:fs|node:path|process\.env|fetch)\b/);
    // It reports retryability; it never acts on it.
    expect(coordinator).not.toMatch(/\b(?:sleep|backoff)\b/);
    // It routes on the durable snapshot, not on a parallel fact type.
    expect(coordinator).toContain("snapshot: RunExecutionSnapshot");
    expect(coordinator).not.toMatch(/RunExecutionFacts/);
  });

  it("keeps the transition planner pure and contract-shaped", () => {
    const planner = executable("packages/agent/src/run/run-transition-planner.ts");
    expect(planner).not.toMatch(/\b(?:await|async)\b/);
    expect(planner).not.toMatch(/\b(?:Date\.now|new Date|Math\.random|randomUUID)\b/);
    expect(planner).not.toMatch(/\b(?:node:fs|node:path|fetch)\b/);
    // A plan is a description: no storage handle, no commit call, no repository.
    expect(planner).not.toMatch(/\b(?:\.commit\(|repository|drizzle|sqlite)\b/);
    // The frozen input and return, with no declarative draft in between.
    expect(planner).toContain("readonly snapshot: RunExecutionSnapshot;");
    expect(planner).toContain("readonly directive: RunExecutionDirective;");
    expect(planner).toContain("readonly effect: RunExecutionEffectResult;");
    expect(planner).toContain("readonly now: TimestampMs;");
    expect(planner).toContain("plan(input: RunTransitionPlanInput): RunExecutionCommit;");
    expect(planner).not.toMatch(/RunTransitionDraft|RunStepSettlement/);
  });

  it("declares exactly the six frozen directive discriminants", () => {
    const directive = read("packages/agent/src/run/directive.ts");
    expect(directive).toContain("RUN_EXECUTION_DIRECTIVE_KINDS");
    const union = directive.slice(
      directive.indexOf("export type RunExecutionDirective ="),
      directive.indexOf("export const RUN_EXECUTION_DIRECTIVE_KINDS"),
    );
    const kinds = [...union.matchAll(/\| (\w+Directive)/g)].map((m) => m[1]!);
    expect(kinds.sort()).toEqual([
      "AdvanceAgentDirective",
      "EvaluateCompletionDirective",
      "ExecuteToolBatchDirective",
      "FinalizeDirective",
      "ReturnTerminalDirective",
      "SuspendDirective",
    ]);
    // A terminal action is a `reason` on FINALIZE, never a seventh directive — and it is the
    // three the Run Layer may commit, not the effect outcomes it must derive.
    const finalize = directive.slice(
      directive.indexOf("export type RunExecutionFinalizeReason"),
      directive.indexOf("/** Every finalization reason"),
    );
    expect(finalize).toContain("CANCELLED");
    expect(finalize).toContain("TIMEOUT");
    expect(finalize).toContain("MAX_STEPS_REACHED");
    expect(finalize).not.toContain("FAILED");
    expect(finalize).not.toContain("BUDGET_EXCEEDED");
    // The mode is exactly two values; START / TOOLS / REPAIR are reasons, not modes.
    expect(directive).toContain('export type RunExecutionMode = "EXECUTE" | "RECOVER";');
    // The terminal report says nothing beyond "settled".
    const terminal = directive.slice(
      directive.indexOf("export interface ReturnTerminalDirective"),
      directive.indexOf("/** Every directive the coordinator may produce. */"),
    );
    expect(terminal).not.toContain("status");
    expect(terminal).not.toContain("reason");
  });

  it("keeps the driver free of lifecycle authority", () => {
    const driver = executable("packages/agent/src/run/run-execution-driver.ts");
    // The driver executes one effect. It reports no Run status and commits nothing.
    expect(read("packages/agent/src/run/run-execution-driver.ts")).toContain("RunExecutionDriver");
    expect(driver).not.toMatch(/readonly status: RunExecutionStatus/);
    expect(driver).not.toMatch(/\b(?:commit\(|persist|markAgentRun)\b/);
    // Frozen signature: a directive plus a general execution context.
    expect(driver).toContain("directive: RunExecutionDirective,");
    expect(driver).toContain("context: RunExecutionEffectContext,");
    expect(driver).toContain("dependencies.agentLoop.advance(");
  });

  it("keeps the execution context general", () => {
    const driver = read("packages/agent/src/run/run-execution-driver.ts");
    const context = driver.slice(
      driver.indexOf("export interface RunExecutionEffectContext"),
      driver.indexOf("/** Create the frozen driver"),
    );
    for (const forbidden of [
      "workspace",
      "runtime",
      "git",
      "ProjectInspector",
      "VerificationPlan",
      "ToolRegistry",
    ]) {
      expect(context.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it("adds no new agent package dependency for the run layer", () => {
    const manifest = JSON.parse(read("packages/agent/package.json")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    expect(
      Object.keys(dependencies)
        .filter((name) => name.startsWith("@caelush/"))
        .sort(),
    ).toEqual(["@caelush/ai", "@caelush/protocol"]);
  });
});

describe("Phase 3C Run Layer ownership", () => {
  it("owns the canonical execution store port and continuation domain", () => {
    const store = read("packages/agent/src/run/ports/run-execution-store.ts");
    for (const contract of [
      "RunExecutionSnapshot",
      "RunExecutionCommit",
      "RunExecutionCommitResult",
      "RunExecutionStorePort",
      "RunExecutionConflictError",
      "RunExecutionInvariantError",
    ]) {
      expect(store, contract).toContain(contract);
    }
    // The general port carries no coding-verification concern.
    const storeCode = executable("packages/agent/src/run/ports/run-execution-store.ts");
    expect(storeCode).not.toContain("VerificationPlan");
    expect(storeCode).not.toContain("VerifiedRunFinalResult");
    expect(storeCode).not.toContain("commitVerifiedCompletion");
    // And the conversation speaks the frozen AI message contract.
    expect(store).toContain("readonly message: AIMessage;");

    const continuation = read("packages/agent/src/run/continuation/continuation.ts");
    for (const type of [
      "WAITING_TOOL_RESULTS",
      "AWAITING_VERIFICATION",
      "WAITING_VERIFICATION_REPAIR",
      "WAITING_RESOURCE",
      "WAITING_RETRY",
    ]) {
      expect(continuation, type).toContain(type);
    }
    expect(continuation).toContain("readonly observationPolicy?: ToolObservationPolicySnapshot");
    expect(continuation).toContain("readonly receivedResults?: readonly AIToolResultMessage[]");
  });

  it("keeps the canonical Step lifecycle in the Run Layer", () => {
    const lifecycle = read("packages/agent/src/run/turn/step-lifecycle.ts");
    for (const fn of [
      "createRunningAgentStep",
      "completeAgentStep",
      "failAgentStep",
      "cancelAgentStep",
      "nextAgentStepSequence",
    ]) {
      expect(lifecycle, fn).toContain(`export function ${fn}`);
    }
    const state = read("packages/agent/src/run/turn/step-state.ts");
    for (const fn of ["beginAgentStepState", "settleAgentStepState", "cancelAgentStepState"]) {
      expect(state, fn).toContain(`export function ${fn}`);
    }

    // Core keeps only the names the Run Layer already imports. A second implementation would be a
    // second Step authority, free to disagree with the one the kernel commits against.
    for (const [file, fns] of [
      [
        "packages/core/src/agent-step.ts",
        [
          "createRunningAgentStep",
          "completeAgentStep",
          "failAgentStep",
          "cancelAgentStep",
          "nextAgentStepSequence",
        ],
      ],
      [
        "packages/core/src/agent-state.ts",
        ["beginAgentStepState", "settleAgentStepState", "cancelAgentStepState"],
      ],
    ] as const) {
      const core = executable(file);
      expect(core, file).toContain('from "@caelush/agent"');
      for (const fn of fns) {
        // Re-exported, never re-declared.
        expect(core, `${file}: ${fn}`).not.toContain(`export function ${fn}`);
        expect(core, `${file}: ${fn}`).toContain(fn);
      }
    }

    // The kernel error is the one the kernel throws: an alias, not a second class, so
    // `instanceof` cannot disagree with the throw.
    const errors = executable("packages/core/src/agent-errors.ts");
    expect(errors).toContain("AgentStepStateError as AgentKernelStateError");
    expect(errors).not.toMatch(/class AgentKernelStateError/);
  });

  it("keeps Core projecting onto the canonical snapshot instead of inventing one", () => {
    const facts = read("packages/core/src/run-execution-facts.ts");
    expect(facts).toContain("toAgentExecutionSnapshot");
    expect(facts).toContain("toExecutionStatus");
    // A status the coordinator cannot route must fail loudly rather than widen.
    expect(facts).toContain("is not a frozen execution status");
    expect(facts).not.toContain("RunExecutionFacts");
  });

  it("keeps the legacy durable encoding in one reviewed codec", () => {
    // The message projection is a representation boundary, not a second domain: it is
    // encode/decode only, and it is the single place the persisted encoding is named.
    const messages = read("packages/core/src/run-message-compatibility.ts");
    expect(messages).toContain("export function toLegacyDurableMessage");
    expect(messages).toContain("export function toAgentAIMessage");
    // It must decide nothing: no Run status, no retry, no Tool outcome.
    expect(messages).not.toMatch(/AgentRunSchema|AgentStateSchema|RunStatus/);

    const continuations = read("packages/core/src/run-continuation-compatibility.ts");
    expect(continuations).toContain("export function toDurableContinuation");
    expect(continuations).toContain("export function toAgentContinuation");

    // Storage never learns the AI contract; it implements the port and calls the codec.
    expect(read("packages/storage/src/run-execution-store.ts")).not.toContain("@caelush/ai");
  });

  it("routes through the coordinator and hands the planner a commit", () => {
    const controller = read("packages/core/src/run-controller.ts");
    expect(controller).toContain("this.coordinator.next(toAgentExecutionSnapshot(snapshot), now)");
    // The controller keeps the transition planner as an injected, pure collaborator.
    expect(controller).toContain("this.transitionPlanner");
    // A state the coordinator cannot route is never guessed at: the in-memory abort cause and a
    // stale active Step are settled by the controller before anything is routed.
    expect(controller).toContain("if (snapshot.activeStep !== undefined) return undefined;");
  });

  it("keeps maxSteps out of the general kernel loop", () => {
    for (const file of sourceFiles(join(root, "packages", "agent", "src", "loop")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    )) {
      expect(read(file), file).not.toMatch(/\bmaxSteps\b/);
    }
  });

  it("keeps the Run transition planner pure and authority-free", () => {
    const planner = executable("packages/agent/src/run/default-run-transition-planner.ts");

    // No clock, no identity, no I/O. The planner receives `now` and returns a description.
    for (const forbidden of [
      "Date.now",
      "new Date",
      "Math.random",
      "randomUUID",
      "createEventId",
      "node:fs",
      "node:child_process",
      "fetch(",
      "EventBus",
      "Repository",
      "Storage",
      "sqlite",
      "completionGate",
      "toolCoordinator",
    ]) {
      expect(planner, `planner must not reference ${forbidden}`).not.toContain(forbidden);
    }

    // Events are planned empty; materialization is a separate host boundary.
    expect(planner).toContain("events: []");
    // A planner that produced a plan identity or a verified result would be a second completion
    // authority, and the branches that would need one fail closed instead.
    expect(planner).not.toContain("VerificationPlan");
    expect(planner).not.toContain("VerifiedRunFinalResult");
    expect(planner).not.toContain("createVerificationPlanId");
  });

  it("routes production Agent effects through the canonical planner", () => {
    // Checkpoint 5 cut the production Agent effect path over. The controller must plan, materialize
    // and commit — in that order — and must ask the coordinator for the directive rather than
    // re-deriving one from the legacy execution epoch.
    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("createRunTransitionPlanner()");
    expect(controller).toContain("createRunCommitEventMaterializer(");
    expect(controller).toContain(
      "this.transitionPlanner.plan({ snapshot, directive, effect, now })",
    );
    expect(controller).toContain("this.eventMaterializer.materialize(");
    expect(controller).toContain("classifyAgentEffectSettlement({ execution, directive })");
    expect(controller).toContain("this.coordinator.next(");

    // The canonical branch is a method of its own: `settle` classifies and dispatches, so the
    // compatibility settlement is one named adapter rather than a second half of one big if/else.
    expect(controller).toContain("private async settleCanonicalAgentEffect(");
    expect(controller).toContain("private async settleCompatibilityAgentEffect(");
  });

  it("never falls back from a failed plan to a compatibility settlement", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    const canonical = controller.slice(
      controller.indexOf("private async settleCanonicalAgentEffect("),
      controller.indexOf("private async settleCompatibilityAgentEffect("),
    );
    expect(canonical.length).toBeGreaterThan(0);

    // No generic fallback: a planner error is not caught, and the compatibility settlement is not
    // reachable from this method at all. Dual authority is exactly what that would create.
    expect(canonical).not.toContain("catch");
    expect(canonical).not.toContain("settleCompatibilityAgentEffect");

    // Ordering is the contract: plan, materialize, commit, then notify.
    const plan = canonical.indexOf("this.transitionPlanner.plan(");
    const materialize = canonical.indexOf("this.eventMaterializer.materialize(");
    const commit = canonical.indexOf("await this.commit(materialized)");
    const notify = canonical.indexOf("this.notify(committed.events)");
    expect(plan).toBeGreaterThan(-1);
    expect(materialize).toBeGreaterThan(plan);
    expect(commit).toBeGreaterThan(materialize);
    expect(notify).toBeGreaterThan(commit);

    // The router classifies by typed discriminant only: no message parsing decides a route, and
    // nothing is caught. `includes` is allowed only in the epoch-agreement assertion, which tests
    // membership in a literal table rather than reading a value.
    const router = executable("packages/core/src/run-agent-effect-settlement.ts");
    expect(router).not.toContain(".message");
    expect(router).not.toContain("catch");
    const classifier = router.slice(
      router.indexOf("export function classifyAgentEffectSettlement("),
      router.indexOf("function canonicalRoute("),
    );
    expect(classifier.length).toBeGreaterThan(0);
    expect(classifier).not.toContain("includes(");
  });

  it("keeps the frozen driver contract unchanged", () => {
    const driver = read("packages/agent/src/run/run-execution-driver.ts");
    expect(driver).toContain("export function createRunExecutionDriver(");
    expect(driver).toContain("readonly completionGate: CompletionGate;");
    expect(driver).toContain("readonly toolTurns: ToolTurnCoordinator;");
    // The frozen effect context still carries nothing a host owns.
    for (const forbidden of [
      "workspace",
      "cwd",
      "runtime",
      "verificationPlan",
      "budget",
      "store",
    ]) {
      expect(driver, `effect context must not carry ${forbidden}`).not.toContain(
        `readonly ${forbidden}`,
      );
    }
  });

  it("gates provider execution behind the durable model turn boundary", () => {
    // The boundary is a real Core implementation now, and the RunController is the object that
    // commits through it: the boundary holds no store of its own.
    const boundary = executable("packages/core/src/run-model-turn-boundary.ts");
    expect(boundary).toContain("export function createAgentModelTurnBoundary(");
    expect(boundary).toContain("ModelTurnBoundaryPort");
    // It never touches a store, a repository or a provider.
    for (const forbidden of ["executionStore", "Repository", "sqlite", ".commit(", "gateway"]) {
      expect(boundary, `boundary must not reference ${forbidden}`).not.toContain(forbidden);
    }

    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("createAgentModelTurnBoundary(");
    expect(controller).toContain("await boundary.beforeExecute(");
    // The commit the boundary asks for is RunController-owned, not boundary-owned.
    expect(controller).toContain("openTurn: (turn) => this.openAgentTurn(turn)");
    expect(controller).toContain("private async openAgentTurn(");

    // Opening the turn must precede the provider: the hook that calls the boundary is the one the
    // kernel invokes before it executes the turn, and the provider port is composed after it.
    const hook = controller.indexOf("beforeProviderTurn:");
    const boundaryCall = controller.indexOf("await boundary.beforeExecute(");
    const settlement = controller.indexOf("return this.settle(snapshot, execution, advancement");
    expect(hook).toBeGreaterThan(-1);
    expect(boundaryCall).toBeGreaterThan(hook);
    expect(settlement).toBeGreaterThan(boundaryCall);
  });

  it("keeps a refused boundary commit out of the Agent failure vocabulary", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    // A boundary that never committed means no Step and no provider call, so there is no Agent
    // effect to plan. Surfacing it as an infrastructure failure is what stops the planner from
    // durably recording a model failure for a turn that never reached a model.
    expect(controller).toContain("requiresBoundaryRepair(turnObservation)");
    expect(controller).toContain(
      'throw new RunControllerInfrastructureError("Unable to durably open the model turn"',
    );

    const boundary = executable("packages/core/src/run-model-turn-boundary.ts");
    // The observation is Core-private; the frozen result is not widened to carry it.
    expect(boundary).toContain("export function createObservingModelTurnExecutor(");
    expect(boundary).not.toContain("AgentLoopAdvanceResult");
  });

  it("keeps the tool, completion and verification authorities where they were", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    // Phase 3D: the Tool boundary is still the Core compatibility path.
    expect(controller).toContain("private async driveToolBoundariesLocked(");
    expect(controller).toContain("private async persistCompleteToolResultsLocked(");
    expect(controller).toContain("private async persistWaitingApprovalLocked(");
    expect(controller).toContain("private async persistWaitingResourceLocked(");
    // Phase 3E: no production completion gate exists anywhere in the workspace. The port is
    // declared once, the frozen driver depends on it, and the kernel's index re-exports it —
    // nothing else may name it at all, which is what "implementation count = 0" means.
    const carriers = sourceFiles(join(root, "packages"))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => !file.includes("/dist/") && !file.includes("/test/"))
      .filter(
        (file) =>
          file !== "packages/agent/src/run/ports/completion-gate.ts" &&
          file !== "packages/agent/src/run/run-execution-driver.ts" &&
          file !== "packages/agent/src/index.ts",
      )
      .filter((file) => /\bCompletionGate\b(?![A-Za-z])/.test(identifiers(file)));
    expect(carriers).toEqual([]);
  });

  it("keeps the Run state machine declared once, in the kernel", () => {
    const kernel = executable("packages/agent/src/run/state/run-state-machine.ts");
    expect(kernel).toContain("export const RUN_STATUS_TRANSITIONS");
    expect(kernel).toContain("export class InvalidRunStatusTransitionError");

    // Core re-exports; it must not declare a second matrix or a second error class.
    const facade = executable("packages/core/src/run-state-machine.ts");
    expect(facade).toContain('from "@caelush/agent"');
    expect(facade).not.toContain("export const RUN_STATUS_TRANSITIONS");
    expect(facade).not.toContain("class InvalidRunStatusTransitionError");

    // One terminal predicate among the packages that can see the kernel. `@caelush/client` mirrors
    // it by necessity — `CLIENT_MUST_NOT_DEPEND_ON_AGENT` forbids it importing the kernel at all —
    // so the client's copy is a boundary requirement, not a competing authority.
    const declarations = sourceFiles(join(root, "packages", "agent", "src"))
      .concat(sourceFiles(join(root, "packages", "core", "src")))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => executable(file).includes("export function isTerminalRunStatus"));
    expect(declarations).toEqual(["packages/agent/src/run/state/run-execution-invariant.ts"]);
  });
});
