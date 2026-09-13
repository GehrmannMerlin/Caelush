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
  });

  it("keeps Core projecting onto the canonical snapshot instead of inventing one", () => {
    const facts = read("packages/core/src/run-execution-facts.ts");
    expect(facts).toContain("toAgentExecutionSnapshot");
    expect(facts).toContain("toExecutionStatus");
    // The legacy durable encoding is projected here and nowhere else in the Run Layer.
    expect(facts).toContain("toAIMessage");
    // A status the coordinator cannot route must fail loudly rather than widen.
    expect(facts).toContain("is not a frozen execution status");
    expect(facts).not.toContain("RunExecutionFacts");
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
});
