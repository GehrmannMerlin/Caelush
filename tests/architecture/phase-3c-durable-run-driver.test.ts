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

  it("keeps the legacy Core AgentLoop out of production Agent execution", () => {
    // Checkpoint 6 retired the facade. The file may remain as a test/migration-parity surface, but
    // no production consumer may call it — and the Run Layer must compose the frozen loop itself.
    const controller = executable("packages/core/src/run-controller.ts");
    for (const forbidden of [
      ".agentLoop.run(",
      ".resumeWithToolResults(",
      ".continueRun(",
      "withLifecycleHooks",
      "AgentLoopExecutionResult",
    ]) {
      expect(controller, `run-controller must not use ${forbidden}`).not.toContain(forbidden);
    }
    // It composes the frozen loop and drives it through the frozen driver instead.
    expect(controller).toContain("createRunAgentLoop(");
    expect(controller).toContain("createRunExecutionDriver(");
    expect(controller).toContain("await driver.execute(directive,");
    // The composition is Core-private and the only `createAgentLoop` call site in the production
    // Agent path is inside it.
    const composition = executable("packages/core/src/run-agent-execution.ts");
    expect(composition).toContain("export function createRunAgentLoop(");
    expect(composition).toContain("return createAgentLoop({");

    // The daemon composition root must not instantiate the legacy facade either.
    const daemon = executable("apps/daemon/src/daemon-composition.ts");
    expect(daemon).not.toContain("new AgentLoop(");
    expect(daemon).not.toContain("agentLoop");
    expect(daemon).toContain("createRunAgentExecutionContext(");
    expect(daemon).toContain("createLegacyContextRuntimeAdapter({");
  });

  it("allocates the durable Step in the Run Layer, not in a facade", () => {
    // The production Step allocator is the Run Layer's own direct execution path.
    const composition = executable("packages/core/src/run-agent-execution.ts");
    expect(composition).toContain("export function allocateRunAgentStep(");
    expect(composition).toContain("createRunningAgentStep({");
    expect(composition).toContain("nextAgentStepSequence(input.state)");
    expect(composition).toContain("export function monotonicStepStart(");

    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("allocateRunAgentStep({");
    expect(controller).toContain("stepId: execution.stepIds.create()");
    // Second authorities are refused outright: a Step id is never a UUID, a timestamp or a call id.
    for (const forbidden of ["randomUUID", "Date.now()", "callId as", "toolCallId as"]) {
      expect(controller, `run-controller must not mint a Step via ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    // The sequence comes from the canonical helper, never from a second `usage.steps + 1` rule.
    expect(controller).not.toMatch(/usage\.steps\s*\+\s*1/);
  });

  it("settles canonical Agent effects without the legacy execution projection", () => {
    const router = executable("packages/core/src/run-agent-effect-settlement.ts");
    // Classification reads the frozen result and the Core-private observation only.
    expect(router).toContain("readonly result: AgentLoopAdvanceResult;");
    expect(router).toContain("readonly observation: AgentTurnObservation;");
    expect(router).not.toContain("AgentLoopExecutionResult");
    // Every route is a named authority, and there is no generic fallback.
    for (const route of [
      "CANONICAL_AGENT_EFFECT",
      "VERIFICATION_COMPATIBILITY",
      "RETRY_COMPATIBILITY",
      "TERMINATION_AUTHORITY",
      "BUDGET_AUTHORITY",
    ]) {
      expect(router, route).toContain(route);
    }

    const controller = executable("packages/core/src/run-controller.ts");
    // The Step settlement source on the compatibility bridges is the Run's own durable active Step.
    expect(controller).toContain("private requireExecutedStep(");
    expect(controller).toContain("current.activeStep");
    expect(controller).toContain("private async openCompletionBoundary(");
    expect(controller).toContain("private async settleRetryCompatibility(");
    // And the retry bridge settles the attempt *before* asking the policy, so maxSteps compares the
    // post-attempt count.
    const retry = controller.slice(
      controller.indexOf("private async settleRetryCompatibility("),
      controller.indexOf("private retryResumeContext("),
    );
    const settle = retry.indexOf("settleExecutedStepState(");
    const decide = retry.indexOf("this.retryController.decide(");
    expect(settle).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(settle);
    expect(retry).toContain("steps: settledState.usage.steps");
  });

  it("keeps the Tool driver real and the completion port misrouted in production", () => {
    // Phase 3D replaced the Tool placeholder with a real run-scoped adapter and Phase 3E replaced the
    // completion one, so what remains here are two *misroute* guards: ports the frozen driver requires
    // but that a wrongly-composed effect must never reach.
    const deferred = executable("packages/core/src/run-agent-deferred-ports.ts");
    expect(deferred).toContain("export const MISROUTED_TOOL_TURN_COORDINATOR");
    expect(deferred).toContain("export const MISROUTED_COMPLETION_GATE");
    expect(deferred).not.toContain("DEFERRED_TOOL_TURN_COORDINATOR");
    expect(deferred).not.toContain("DEFERRED_COMPLETION_GATE");
    expect(deferred).toMatch(/async execute\(\): Promise<never>/);
    expect(deferred).toMatch(/async evaluate\(\): Promise<never>/);

    // The production Agent composition binds the misroute guard, never a Tool execution path: a
    // Tool directive arriving at an Agent driver is refused rather than driven twice.
    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("toolTurns: MISROUTED_TOOL_TURN_COORDINATOR");
    expect(controller).toContain("completionGate: MISROUTED_COMPLETION_GATE");
    // And the Tool batch itself is driven through the frozen driver over the real adapter — not
    // through a direct call to the Tool Layer from the Agent path.
    expect(controller).toContain("createRunToolTurnDriverFactory(");
    expect(controller).toContain("toolTurns: turnDriver.coordinator");
  });

  it("normalizes legacy retry provenance durably instead of special-casing the runtime", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("private async normalizeLegacyRetryProvenance(");
    expect(controller).toContain("recoverToolRequestSourceStep(");
    // The normalization runs before the coordinator is asked, so the coordinator only ever sees a
    // state it can route — there is no "unroutable legacy checkpoint" branch left.
    const recover = controller.slice(
      controller.indexOf("private async recoverLocked("),
      controller.indexOf("private async resumeRetryLocked("),
    );
    expect(recover).toContain("await this.normalizeLegacyRetryProvenance(loaded)");
    expect(recover.indexOf("this.coordinatedBoundary(")).toBeGreaterThan(
      recover.indexOf("await this.normalizeLegacyRetryProvenance(loaded)"),
    );
    // And no branch returns an absent directive for it any more.
    expect(controller).not.toContain("advancementDirective");
    expect(controller).not.toMatch(/sourceStepId === undefined\s*\)\s*\{\s*return undefined/);
  });

  it("projects the production Agent history onto the frozen AI contract", () => {
    const history = executable("packages/core/src/run-agent-history.ts");
    expect(history).toContain("export function projectRunAgentHistory(");
    // It reuses the frozen validators rather than reimplementing them.
    expect(history).toContain("assertPendingAssistantHistory");
    expect(history).toContain("assertConversationProtocolIntegrity");
    // It decides nothing about the Run: no status, no Step settlement, no continuation.
    expect(history).not.toMatch(/AgentRunSchema|AgentStateSchema|RunStatus|continuation/);
    // And no legacy durable encoding crosses into it.
    expect(history).not.toContain("@caelush/llm");

    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("projectRunAgentHistory({");
    expect(controller).toContain("input: directive.input");
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
    // Checkpoint 5 cut the production Agent effect path over, and checkpoint 6 drove it through the
    // frozen driver. The controller must plan, materialize and commit — in that order — and must ask
    // the coordinator for the directive rather than re-deriving one from a legacy execution epoch.
    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("createRunTransitionPlanner()");
    expect(controller).toContain("createRunCommitEventMaterializer(");
    expect(controller).toContain(
      "this.transitionPlanner.plan({ snapshot, directive, effect, now })",
    );
    expect(controller).toContain("this.eventMaterializer.materialize(");
    expect(controller).toContain(
      "classifyAgentEffectSettlement({ result, directive, observation })",
    );
    expect(controller).toContain("this.coordinator.next(");

    // The canonical branch is a method of its own: `settle` classifies and dispatches, so each
    // compatibility bridge is a named adapter rather than a second half of one big if/else.
    expect(controller).toContain("private async settleCanonicalAgentEffect(");
    expect(controller).toContain("private async openCompletionBoundary(");
    expect(controller).toContain("private async settleRetryCompatibility(");

    // No execution epoch survives as an Agent execution authority.
    expect(controller).not.toContain("advancementDirective");
    expect(controller).not.toContain("executeLoop(");
    expect(controller).not.toContain('"START" | "TOOL_RESULTS" | "VERIFICATION_REPAIR"');
  });

  it("never falls back from a failed plan to a compatibility settlement", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    const canonical = controller.slice(
      controller.indexOf("private async settleCanonicalAgentEffect("),
      controller.indexOf("private agentTurnProvenance("),
    );
    expect(canonical.length).toBeGreaterThan(0);

    // No generic fallback: a planner error is not caught, and no compatibility settlement is
    // reachable from this method at all. Dual authority is exactly what that would create.
    expect(canonical).not.toContain("catch");
    expect(canonical).not.toContain("Compatibility(");

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
    // nothing is caught.
    const router = executable("packages/core/src/run-agent-effect-settlement.ts");
    expect(router).not.toContain(".message");
    expect(router).not.toContain("catch");
    // It consumes the frozen result directly — no legacy execution projection in between.
    expect(router).toContain("readonly result: AgentLoopAdvanceResult;");
    expect(router).not.toContain("AgentLoopExecutionResult");
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
    // The boundary is a real Core implementation, and the RunController is the object that commits
    // through it: the boundary holds no store of its own.
    const boundary = executable("packages/core/src/run-model-turn-boundary.ts");
    expect(boundary).toContain("export function createAgentModelTurnBoundary(");
    expect(boundary).toContain("ModelTurnBoundaryPort");
    // It never touches a store, a repository or a provider.
    for (const forbidden of ["executionStore", "Repository", "sqlite", ".commit(", "gateway"]) {
      expect(boundary, `boundary must not reference ${forbidden}`).not.toContain(forbidden);
    }

    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("createAgentModelTurnBoundary(");
    // The commit the boundary asks for is RunController-owned, not boundary-owned.
    expect(controller).toContain("openTurn: (turn) => this.openAgentTurn(turn)");
    expect(controller).toContain("private async openAgentTurn(");
    // And the boundary is entered through the frozen driver, not through a legacy lifecycle hook.
    expect(controller).toContain("createRunExecutionDriver(");
    expect(controller).toContain("await driver.execute(directive,");
    expect(controller).not.toContain("beforeProviderTurn:");
    expect(controller).not.toContain("withLifecycleHooks");

    // Opening the turn must precede the provider: the driver is composed with the boundary port,
    // and the observed effect is settled only after `execute` resolved.
    const driverComposition = controller.indexOf("createRunExecutionDriver(");
    const boundaryPort = controller.indexOf("modelTurnBoundary: boundary,");
    const settlement = controller.indexOf("return this.settle(snapshot, directive, effect.result");
    expect(driverComposition).toBeGreaterThan(-1);
    expect(boundaryPort).toBeGreaterThan(-1);
    expect(settlement).toBeGreaterThan(driverComposition);
    expect(settlement).toBeGreaterThan(boundaryPort);
  });

  it("keeps a refused boundary commit out of the Agent failure vocabulary", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    // A boundary that never committed means no Step and no provider call, so there is no Agent
    // effect to settle. Surfacing it as an infrastructure failure is what stops the durable ledger
    // from recording a model failure for a turn that never reached a model.
    expect(controller).toContain("requiresBoundaryRepair(observation)");
    expect(controller).toContain(
      'throw new RunControllerInfrastructureError("Unable to durably open the model turn"',
    );
    // The observation is the only provider-attempt authority on the Agent path.
    expect(controller).not.toContain("providerTurnState: execution");

    const boundary = executable("packages/core/src/run-model-turn-boundary.ts");
    // The observation is Core-private; the frozen result is not widened to carry it.
    expect(boundary).toContain("export function createObservingModelTurnExecutor(");
    expect(boundary).not.toContain("AgentLoopAdvanceResult");
  });

  it("keeps the tool, completion and verification authorities where they were", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    // Phase 3D moved the Tool boundary into the frozen driver: the Run Layer's Tool turn is a real
    // adapter, the controller only resolves it and settles what it returns, and every inline Tool
    // decision the pre-3D loop held is gone from the production branch.
    expect(controller).toContain("private toolTurnDriver(");
    expect(controller).toContain("private async executeToolBatchDirective(");
    expect(controller).toContain("private async settleToolEffect(");
    expect(controller).toContain("private async settleCanonicalToolTurn(");
    expect(controller).toContain("private async settleWaitingResource(");
    // Phase 3E: exactly one production gate is the coding verification gate. Its identity is
    // declared once, in the adapter that owns it, and every other completion port in the workspace is
    // a misroute guard rather than a second policy.
    const realGates = sourceFiles(join(root, "packages"))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => !file.includes("/dist/") && !file.includes("/test/"))
      .filter((file) => read(file).includes("caelush.coding-verification-completion-gate.v1"));
    expect(realGates).toEqual(["packages/core/src/run-completion-gate.ts"]);

    // And nothing else in the workspace declares a gate-shaped object.
    const carriers = sourceFiles(join(root, "packages"))
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => !file.includes("/dist/") && !file.includes("/test/"))
      .filter(
        (file) =>
          file !== "packages/agent/src/run/ports/completion-gate.ts" &&
          file !== "packages/agent/src/run/run-execution-driver.ts" &&
          file !== "packages/agent/src/index.ts" &&
          file !== "packages/core/src/run-agent-deferred-ports.ts" &&
          // The real gate: it declares the coding implementation the frozen driver is driven with.
          file !== "packages/core/src/run-completion-gate.ts" &&
          // Phase 3F: the composition seam that carries the real gate to the driver. It *names* the
          // frozen port as its own return type; it declares no gate, no policy and no `evaluate()`.
          file !== "packages/core/src/run-completion-assembly.ts" &&
          // Phase 3F: the general accept-directly gate. It is an implementation *of* the frozen port
          // for a host with no verification subsystem — not the coding policy this guard protects, and
          // never selected by a coding composition.
          file !== "packages/agent/src/run/gates/direct-accept-completion-gate.ts",
      )
      .filter((file) => /\bCompletionGate\b(?![A-Za-z])/.test(identifiers(file)));
    expect(carriers).toEqual([]);

    // The seam is a carrier, not a second policy: it holds no gate id and evaluates nothing itself.
    const assembly = executable("packages/core/src/run-completion-assembly.ts");
    expect(assembly).not.toContain("caelush.coding-verification-completion-gate.v1");
    expect(assembly).not.toMatch(/\bevaluate\s*[(:]/);

    // The misroute guard is fail-closed: it never returns a decision.
    const deferred = read("packages/core/src/run-agent-deferred-ports.ts");
    expect(deferred).toContain("MISROUTED_COMPLETION_GATE");
    expect(deferred).not.toMatch(/async evaluate\([^)]*\)\s*\{\s*return/);
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
