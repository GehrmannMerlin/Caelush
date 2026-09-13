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

  it("names no storage, runtime, verification or legacy Tool type", () => {
    const forbidden =
      /\b(?:AgentRun|AgentState|AgentStep|RunRepository|CaelushStorage|DatabaseSync|drizzle|sqlite|LocalRuntime|RuntimeWorkspaceScope|VerificationRunner|VerificationPlan|ToolDispatcher|ToolRegistry|ToolBatchCoordinator|ToolInvocation|ObservationId)\b/;
    const violations: string[] = [];
    for (const file of runLayerFiles()) {
      if (forbidden.test(executable(file))) violations.push(file);
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
    expect(coordinator).not.toMatch(/\b(?:sleep|backoff|retryAfter)\b/);
  });

  it("keeps the transition planner pure", () => {
    const planner = executable("packages/agent/src/run/run-transition-planner.ts");
    expect(planner).not.toMatch(/\b(?:await|async)\b/);
    expect(planner).not.toMatch(/\b(?:Date\.now|new Date|Math\.random|randomUUID)\b/);
    expect(planner).not.toMatch(/\b(?:node:fs|node:path|fetch)\b/);
    // A plan is a description: it carries no storage handle and no commit call.
    expect(planner).not.toMatch(/\b(?:commit\(|store\.|repository|insert|update)\b/);
  });

  it("declares exactly the six frozen directive discriminants", () => {
    const directive = read("packages/agent/src/run/directive.ts");
    expect(directive).toContain("RUN_EXECUTION_DIRECTIVE_KINDS");
    for (const kind of [
      "ADVANCE_AGENT",
      "EXECUTE_TOOL_BATCH",
      "EVALUATE_COMPLETION",
      "SUSPEND",
      "FINALIZE",
      "RETURN_TERMINAL",
    ]) {
      expect(directive).toContain(kind);
    }
    // The union itself must list exactly the six kinds. `RunExecutionFinalization` holds its own
    // inner `reason` union, which is checked separately below.
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
    // A terminal outcome is a reason on FINALIZE, never a seventh directive.
    const finalization = directive.slice(
      directive.indexOf("export type RunExecutionFinalization"),
      directive.indexOf("/** Commit a terminal settlement. */"),
    );
    for (const reason of [
      "CANCELLED",
      "TIMEOUT",
      "FAILED",
      "BUDGET_EXCEEDED",
      "MAX_STEPS_REACHED",
    ]) {
      expect(finalization).toContain(reason);
    }
  });

  it("keeps the driver free of lifecycle authority", () => {
    const driver = executable("packages/agent/src/run/run-execution-driver.ts");
    // The driver executes one effect. It reports no Run status and commits nothing.
    expect(read("packages/agent/src/run/run-execution-driver.ts")).toContain("RunExecutionDriver");
    expect(driver).not.toMatch(/readonly status: RunExecutionStatus/);
    expect(driver).not.toMatch(/\b(?:commit\(|persist|markAgentRun)\b/);
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

describe("Phase 3C RunController authority", () => {
  it("routes through the coordinator instead of its own priority chain", () => {
    const controller = read("packages/core/src/run-controller.ts");
    // The controller consumes the frozen decision...
    expect(controller).toContain("this.coordinator.next(");
    expect(controller).toContain("toDirectiveAction(");
    expect(controller).toContain("toRunExecutionFacts(");
    // ...and keeps the transition planner as an injected, pure collaborator.
    expect(controller).toContain("this.transitionPlanner");
  });

  it("keeps the snapshot to facts projection in one place", () => {
    const facts = read("packages/core/src/run-execution-facts.ts");
    expect(facts).toContain("toRunExecutionFacts");
    expect(facts).toContain("toExecutionStatus");
    // A status the coordinator cannot route must fail loudly rather than widen.
    expect(facts).toContain("is not a frozen execution status");
    expect(facts).toContain("is not routable");
  });

  it("keeps maxSteps out of the general kernel", () => {
    for (const file of sourceFiles(join(root, "packages", "agent", "src", "loop")).map((path) =>
      relative(root, path).replaceAll("\\", "/"),
    )) {
      expect(read(file), file).not.toMatch(/\bmaxSteps\b/);
    }
  });
});
