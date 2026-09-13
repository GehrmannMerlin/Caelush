import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 3B AgentLoop independence guards.
 *
 * Phase 3B made `@caelush/agent`'s `AgentLoop.advance()` the only Reason implementation. These
 * guards are structural — they read the repository rather than a live runtime — so the two
 * properties the phase exists for can never regress silently:
 *
 * ```text
 * the general loop knows no coding-agent package
 * the general loop owns no Run lifecycle
 * ```
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

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+\*\s+from\s*["']([^"']+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function agentLoopFiles(): string[] {
  return sourceFiles(join(root, "packages", "agent", "src")).map((path) =>
    relative(root, path).replaceAll("\\", "/"),
  );
}

/** A file's executable code, with its documentation removed. */
function executable(relativePath: string): string {
  return read(relativePath)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Phase 3B general loop independence", () => {
  it("imports no coding context implementation", () => {
    const forbidden = [
      "@caelush/context",
      "@caelush/coding-agent",
      "@caelush/tools",
      "@caelush/verification",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/core",
      "@caelush/security",
      "@caelush/events",
    ];
    const violations: string[] = [];
    for (const file of agentLoopFiles()) {
      for (const specifier of moduleSpecifiers(read(file))) {
        if (forbidden.includes(specifier)) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("names no project inspector and no relevant-file planner", () => {
    const violations: string[] = [];
    for (const file of agentLoopFiles()) {
      const source = executable(file);
      if (
        /\b(?:ProjectInspector|RelevantFilePlanner|ContextBuilder|ProjectIntelligenceSnapshot)\b/.test(
          source,
        )
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it("names no Runtime and no workspace", () => {
    const violations: string[] = [];
    for (const file of agentLoopFiles()) {
      const source = executable(file);
      if (
        /\b(?:LocalRuntime|RuntimeWorkspaceScope|WorkspacePathResolver|ToolExecutionEnvironment)\b/.test(
          source,
        )
      ) {
        violations.push(`${file}: runtime`);
      }
      if (/\b(?:workspacePath|cwd|process\.cwd)\b/.test(source)) {
        violations.push(`${file}: workspace`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("creates no Step and holds no AgentState", () => {
    const violations: string[] = [];
    for (const file of agentLoopFiles()) {
      const source = executable(file);
      if (
        /\b(?:createRunningAgentStep|beginAgentStepState|settleAgentStepState|AgentStepSchema)\b/.test(
          source,
        )
      ) {
        violations.push(`${file}: step lifecycle`);
      }
      if (/\b(?:AgentState|currentStepId|stepIdFactory|maxSteps)\b/.test(source)) {
        violations.push(`${file}: Run state`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("writes no Run status and performs no verification", () => {
    const violations: string[] = [];
    for (const file of agentLoopFiles()) {
      const source = executable(file);
      if (
        /\b(?:RunStatus|RunController|RunStateMachine|markAgentRun|status\.changed)\b/.test(source)
      ) {
        violations.push(`${file}: run status`);
      }
      if (
        /\b(?:VerificationRunner|VerificationPlan|TaskReviewer|finalResult|COMPLETED_RUN)\b/.test(
          source,
        )
      ) {
        violations.push(`${file}: verification`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("executes no Tool and approves nothing", () => {
    const violations: string[] = [];
    for (const file of agentLoopFiles()) {
      const source = executable(file);
      if (
        /\b(?:ToolDispatcher|ToolRegistry|ToolBatchCoordinator|ToolBatchOutcome|handler)\b/.test(
          source,
        )
      ) {
        violations.push(`${file}: tool execution`);
      }
      if (
        /\b(?:ApprovalRequest|ApprovalManager|resolveApproval|PermissionProfile|ConversationMessage)\b/.test(
          source,
        )
      ) {
        violations.push(`${file}: approval or permission`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("advances exactly one Reason per call", () => {
    const loop = executable("packages/agent/src/loop/agent-loop.ts");
    expect(loop).toContain("async advance(input: AgentLoopAdvanceInput)");
    // A single executor invocation, plus the one bounded recovery attempt.
    const executions = loop.match(/executeTurn\(/g) ?? [];
    expect(executions).toHaveLength(3);
    expect(loop).not.toMatch(/\bwhile\s*\(/);
  });
});

describe("Phase 3B context boundary", () => {
  it("freezes the context input to the eight documented fields", () => {
    const port = read("packages/agent/src/loop/context/context-engine-port.ts");
    const input = port.slice(
      port.indexOf("export interface ContextPrepareInput"),
      port.indexOf("export interface ContextProvider"),
    );
    const fields = [...input.matchAll(/^\s+readonly (\w+)[?]?:/gm)].map((match) => match[1] ?? "");
    expect(fields.sort()).toEqual([
      "history",
      "identity",
      "input",
      "mode",
      "model",
      "signal",
      "tools",
      "turn",
    ]);
  });

  it("keeps the context boundary free of host environment types", () => {
    const port = executable("packages/agent/src/loop/context/context-engine-port.ts");
    expect(port).toContain("ContextEnginePort");
    expect(port).toContain("ContextProvider");
    // The exclusions are the contract: none of these may appear even as a type name.
    expect(port).not.toMatch(
      /\b(?:cwd|workspace|project|git|verificationPlan|runtime|snapshot|filePlan)\b/i,
    );
  });

  it("keeps the coding context implementation behind a Core adapter", () => {
    const adapter = read("packages/core/src/legacy-context-runtime-adapter.ts");
    // Core may import both sides; that is exactly what makes it the boundary.
    expect(adapter).toContain('from "@caelush/context"');
    expect(adapter).toContain('from "@caelush/agent"');
    expect(adapter).toContain("ProjectIntelligenceSnapshot");
    expect(adapter).toContain("createLegacyContextRuntimeAdapter");
  });

  it("routes the legacy loop through the frozen advance()", () => {
    const facade = read("packages/core/src/agent-loop.ts");
    expect(facade).toContain("createAgentLoop(");
    expect(facade).toContain(".advance(");
    // The facade still owns the lifecycle the frozen loop refuses to own.
    expect(facade).toContain("createRunningAgentStep");
    // And it maps run() and resumeWithToolResults() onto the two frozen turn kinds.
    expect(facade).toContain('kind: "USER_INPUT"');
    expect(facade).toContain('kind: "TOOL_RESULTS"');
  });

  it("orders admission before the durable boundary", () => {
    const loop = executable("packages/agent/src/loop/agent-loop.ts");
    const admission = loop.indexOf("modelAdmission.admit(");
    const boundary = loop.indexOf("modelTurnBoundary.beforeExecute(");
    const model = loop.indexOf("executeTurn(");
    expect(admission).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(-1);
    // A refused turn must not commit a Step, and a failed commit must not reach the provider.
    expect(admission).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(model);
  });

  it("keeps the standalone proof on the two allowed packages", () => {
    const proof = read("packages/agent/test/standalone-kernel.test.ts");
    const specifiers = moduleSpecifiers(proof).filter((specifier) =>
      specifier.startsWith("@caelush/"),
    );
    expect([...new Set(specifiers)].sort()).toEqual([
      "@caelush/agent",
      "@caelush/ai",
      "@caelush/protocol",
    ]);
    // No workspace, Git, Runtime, Storage, legacy Context, legacy Tools or Verification.
    for (const forbidden of [
      "@caelush/context",
      "@caelush/tools",
      "@caelush/verification",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/coding-agent",
      "@caelush/core",
    ]) {
      expect(proof).not.toContain(`"${forbidden}"`);
    }
  });
});
