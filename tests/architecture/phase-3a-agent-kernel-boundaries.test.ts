import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 3A Agent Kernel contract and boundary guards.
 *
 * Phase 3A froze the Architecture V2 general Agent Kernel contracts. These guards are
 * deliberately structural — they read the repository rather than a live runtime — so a
 * regression fails at review time instead of in production:
 *
 * ```text
 * agent → ai               allowed
 * agent → protocol         allowed
 * agent → legacy           forbidden
 * executor result          a union, never a throw
 * transient stream         three deltas, never the envelope
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
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+\*\s+from\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function agentKernelFiles(): string[] {
  return sourceFiles(join(root, "packages", "agent", "src")).map((path) =>
    relative(root, path).replaceAll("\\", "/"),
  );
}

/** The frozen kernel directories of Phase 3A, plus the Phase 3B context boundary. */
const KERNEL_DIRECTORIES = [
  "packages/agent/src/loop",
  "packages/agent/src/loop/context",
  "packages/agent/src/loop/decision",
  "packages/agent/src/loop/turn",
  "packages/agent/src/loop/ports",
  "packages/agent/src/loop/events",
] as const;

describe("Phase 3A agent kernel dependency boundaries", () => {
  it("declares exactly the two allowed workspace dependencies", () => {
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

  it("allows agent to ai and agent to protocol, and nothing else from the workspace", () => {
    const violations: string[] = [];
    for (const file of agentKernelFiles()) {
      for (const specifier of moduleSpecifiers(read(file))) {
        if (!specifier.startsWith("@caelush/")) continue;
        if (specifier === "@caelush/ai" || specifier === "@caelush/protocol") continue;
        violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("forbids every legacy package, including the ones a coding agent would need", () => {
    const forbidden = [
      "@caelush/core",
      "@caelush/context",
      "@caelush/tools",
      "@caelush/verification",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/llm",
      "@caelush/security",
      "@caelush/coding-agent",
      "@caelush/events",
      "@caelush/memory",
      "@caelush/shared",
      "@caelush/observability",
    ];

    const violations: string[] = [];
    for (const file of agentKernelFiles()) {
      for (const specifier of moduleSpecifiers(read(file))) {
        if (forbidden.includes(specifier) || specifier.startsWith("@caelush/llm/")) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the kernel free of coding-agent vocabulary and host execution", () => {
    const source = agentKernelFiles()
      .map((file) => read(file))
      .join("\n")
      // Comments are documentation, and the contract documents what it forbids. Only
      // executable code is guarded.
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    expect(source).not.toMatch(/\b(?:ProjectInspector|RelevantFilePlanner|ContextBuilder)\b/);
    expect(source).not.toMatch(/\b(?:read_file|exec_command|apply_patch|git_status)\b/);
    expect(source).not.toMatch(
      /\b(?:node:fs|node:path|node:child_process|process\.env|Date\.now|Math\.random)\b/,
    );
    expect(source).not.toMatch(/\b(?:workspace|cwd|permissionProfile|approvalPolicy)\b/);
  });

  it("keeps the AgentLoop free of a lifecycle implementation", () => {
    const loop = read("packages/agent/src/loop/agent-loop.ts");
    // One Reason through a fixed sequence: Phase 3B implemented `advance()` as a straight line
    // with exactly one bounded context-overflow recovery, and no loop of its own.
    expect(loop).toContain(
      "advance(input: AgentLoopAdvanceInput): Promise<AgentLoopAdvanceResult>",
    );
    const executable = loop
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
    // No iteration, no sleeping, no retry loop.
    expect(executable).not.toMatch(/\bwhile\s*\(/);
    expect(executable).not.toMatch(/\bfor\s*\(/);
    expect(executable).not.toMatch(/\bsetTimeout|\bsetInterval|\bsleep\b/);
    // Tool execution, Run status and the max-step gate are all absent by construction.
    expect(executable).not.toMatch(/\b(?:dispatch|executeTool|ToolDispatcher|markAgentRun)\b/);
    expect(executable).not.toMatch(/\bmaxSteps\b/);
  });
});

describe("Phase 3A frozen kernel surface", () => {
  it("creates exactly the frozen kernel directories", () => {
    for (const directory of KERNEL_DIRECTORIES) {
      expect(existsSync(join(root, directory)), directory).toBe(true);
    }
  });

  it("publishes the frozen contracts from the package root only", () => {
    const manifest = JSON.parse(read("packages/agent/package.json")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);

    const entry = read("packages/agent/src/index.ts");
    expect(entry).not.toMatch(/export \* from/);
    expect(
      moduleSpecifiers(entry).filter((specifier) => specifier.startsWith("@caelush/")),
    ).toEqual([]);

    // Every frozen contract of the phase is reachable from the root entry.
    for (const contract of [
      "AgentExecutionIdentity",
      "AgentTurnRef",
      "AgentTurnInput",
      "AgentDecision",
      "AgentLoopAdvanceInput",
      "AgentLoopAdvanceResult",
      "AgentDecisionClassifier",
      "ModelRequestBuilder",
      "ModelRequestAdmissionPort",
      "ModelTurnBoundaryPort",
      "ModelTurnStreamSink",
      "ModelTurnExecutionResult",
      "ModelTurnExecutionError",
    ]) {
      expect(entry, contract).toContain(contract);
    }
  });

  it("keeps the transient stream contract to the three delta kinds", () => {
    const events = read("packages/agent/src/loop/events/transient-stream-event.ts");
    expect(events).toContain('"text.delta"');
    expect(events).toContain('"thinking.delta"');
    expect(events).toContain('"tool_call.delta"');

    // The AI envelope, accounting and durable tool-call lifecycle must never be
    // forwardable as an agent transient delta.
    const executable = events
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [
      "stream.start",
      "stream.finish",
      "stream.error",
      '"usage"',
      "tool_call.start",
      "tool_call.completed",
    ]) {
      expect(executable, forbidden).not.toContain(forbidden);
    }
  });

  it("never exposes a throwing model turn interface from the agent package", () => {
    const violations: string[] = [];
    for (const file of agentKernelFiles()) {
      const source = read(file);
      // The executor resolves a union; a throwing execute would restore the legacy
      // semantics the freeze removed from this package.
      if (/execute\s*\([^)]*\)\s*:\s*Promise<AIModelTurnResult>/.test(source)) {
        violations.push(`${file}: throwing execute signature`);
      }
      if (/\bthrow\s+(?:new\s+)?AIError\b/.test(source)) {
        violations.push(`${file}: throws an AIError across the executor boundary`);
      }
    }
    expect(violations).toEqual([]);
    const executor = read("packages/agent/src/loop/turn/model-turn-executor.ts");
    expect(executor).toContain("Promise<ModelTurnExecutionResult>");
  });

  it("keeps the request builder free of provider-native cache control", () => {
    const builder = read("packages/agent/src/loop/turn/model-request-builder.ts");
    const executable = builder
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
    expect(executable).not.toMatch(/cache_control|cachePoint|cacheControl|providerOptions/);
  });

  it("keeps the agent decision free of legacy and wire model types", () => {
    const decision = read("packages/agent/src/loop/decision/decision.ts");
    const executable = decision
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
    expect(executable).not.toContain("LLMAssistantMessage");
    expect(executable).not.toContain("@caelush/llm");
    expect(executable).not.toMatch(/import[^;]*\bModelRef\b[^;]*from\s+["']@caelush\/protocol/);
  });
});

describe("Phase 3A Core compatibility boundary", () => {
  it("keeps the decision classifier in exactly one implementation", () => {
    // The Core facade must re-export the agent classifier rather than reimplement it: a
    // second classifier would be a second decision authority.
    const facade = read("packages/core/src/agent-decision-mapper.ts");
    const executable = facade
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
    expect(executable).toContain('from "@caelush/agent"');
    expect(executable).not.toMatch(/\bfunction\s+classify|=>\s*\{/);
    expect(existsSync(join(root, "packages", "core", "src", "agent-decision.ts"))).toBe(true);
  });

  it("keeps the durable projection in the Core boundary and out of the agent package", () => {
    const projection = read("packages/core/src/ai-invocation-projection.ts");
    // Core may import both sides; that is exactly what makes it the boundary.
    expect(projection).toContain('from "@caelush/llm/messages"');
    expect(projection).toContain('from "@caelush/agent"');
    expect(projection).toContain("toLegacyMessage");
    expect(projection).toContain("toLegacyAssistantMessage");

    for (const file of agentKernelFiles()) {
      expect(read(file), file).not.toContain("@caelush/llm");
    }
  });

  it("keeps the legacy executor facade at the host boundary only", () => {
    const facade = read("packages/core/src/legacy-model-turn-executor.ts");
    expect(facade).toContain("AIModelTurnResult");
    expect(facade).toContain('case "COMPLETED"');
    expect(facade).toContain('case "CANCELLED"');
    expect(facade).toContain('case "FAILED"');
    // Cancellation stays distinguishable from a provider failure.
    expect(facade).toContain("AI_ABORTED");

    // The two legacy consumers name the facade rather than the frozen port.
    expect(read("packages/core/src/agent-loop-ports.ts")).toContain("LegacyModelTurnExecutor");
    expect(read("packages/core/src/task-acceptance-reviewer.ts")).toContain(
      "LegacyModelTurnExecutor",
    );
  });
});
