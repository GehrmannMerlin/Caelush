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

/**
 * Phase 3A frozen contract remediation guards.
 *
 * The contract-level guarantee is the compile-time exactness file: it restates every frozen shape
 * and fails `pnpm typecheck` when a property is added, renamed, made optional or dropped. These
 * guards are the structural half — they keep the *source of truth* in the file the freeze names,
 * and they fail loudly if the exactness file is deleted or narrowed.
 */
describe("Phase 3A frozen contract remediation", () => {
  it("keeps the compile-time exactness file present and complete", () => {
    const exactness = read("packages/agent/test/contracts/phase-3a-frozen-contracts.test.ts");
    // Every frozen contract of the phase must be asserted by name.
    for (const contract of [
      "AgentExecutionIdentity",
      "AgentTurnRef",
      "AgentTurnInput",
      "AgentLoopAdvanceInput",
      "AgentLoopAdvanceResult",
      "AgentLoopContextReceipt",
      "PreparedModelContext",
      "ToolObservationPolicySnapshot",
      "ContextBuildReport",
      "ModelRequestAdmissionInput",
      "ModelRequestAdmissionDecision",
      "ModelTurnBoundaryInput",
      "ModelTurnExecutionInput",
      "ModelTurnExecutionResult",
      "ModelTurnExecutionError",
      "AgentTransientStreamEvent",
      "AgentLoopDependencies",
    ]) {
      expect(exactness, contract).toContain(contract);
    }
    // A source-text containment check would agree with the drift by construction; the file must
    // assert structural equality of whole shapes instead.
    expect(exactness).toContain("Expect<Equal<");
    expect(exactness).toContain("type Keys<T> = keyof T;");
  });

  it("keeps the frozen advance input free of settings and streamSink", () => {
    const types = read("packages/agent/src/loop/types.ts");
    const executable = types
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    // `modelSettings` is the frozen field name; `settings` is not an allowed rename.
    expect(executable).toContain("readonly modelSettings?: AIModelSettings;");
    expect(executable).not.toMatch(/\breadonly settings\?:/);
    // Streaming belongs to the executor the composition root binds, never to the loop input.
    expect(executable).not.toMatch(/\breadonly streamSink\?:/);
  });

  it("keeps the advance result a four-discriminant union with no COMPLETED status", () => {
    const types = read("packages/agent/src/loop/types.ts");
    const executable = types
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    for (const kind of ['"TOOL_REQUESTS"', '"FINAL_CANDIDATE"', '"FAILED"', '"CANCELLED"']) {
      expect(executable, kind).toContain(kind);
    }
    expect(executable).toContain(
      "export type AgentLoopAdvanceResult =\n  | AgentLoopToolRequestsResult\n  | AgentLoopFinalCandidateResult\n  | AgentLoopFailedResult\n  | AgentLoopCancelledResult;",
    );
    // The drift this remediation removed: a `status`-tagged result and a COMPLETED-the-Reason
    // variant that the Run Layer could mistake for completion authority.
    expect(executable).not.toContain("AgentLoopAdvanceCompleted");
    expect(executable).not.toContain("AgentLoopAdvanceFailed");
    expect(executable).not.toContain('readonly status: "COMPLETED"');
    expect(executable).not.toMatch(/\breadonly status: "FAILED"/);
    expect(executable).not.toMatch(/\breadonly status: "CANCELLED"/);
  });

  it("keeps the context receipt typed and the prepared context free of recovered", () => {
    const types = read("packages/agent/src/loop/types.ts");
    const executable = types
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    expect(executable).toContain("export interface AgentLoopContextReceipt {");
    expect(executable).toContain('readonly recovery: "NONE" | "FORCED_CONTEXT_RECOVERY";');
    // A forced recovery is recorded in the receipt, not on the engine's answer.
    expect(executable).not.toMatch(/\breadonly recovered\?:/);
    // The report is a typed contract, never an opaque bag.
    expect(executable).toContain("export interface ContextBuildReport {");
    expect(executable).not.toContain("Readonly<Record<string, unknown>>");
    // The observation snapshot is exactly two numbers.
    expect(executable).toContain("export interface ToolObservationPolicySnapshot {");
    // The previous shape — a policy id, a byte budget and an include-details switch — is gone.
    expect(executable).not.toContain("export interface ObservationPolicySnapshot {");
    expect(executable).not.toMatch(/\breadonly maxOutputBytes\?:/);
    expect(executable).not.toMatch(/\breadonly includeDetails\?:/);
  });

  it("keeps the model turn failure free of stage and raw cause", () => {
    const failure = read("packages/agent/src/loop/turn/model-turn-error.ts");
    const executable = failure
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    expect(executable).toContain("readonly code: ModelTurnExecutionErrorCode;");
    expect(executable).toContain("readonly message: string;");
    expect(executable).toContain("readonly retryable: boolean;");
    expect(executable).toContain("readonly retryAfterMs?: number;");
    // `stage` and `cause` were the drift: where a Reason failed is the caller's observation, and a
    // raw provider throw is never an `@caelush/agent` public field.
    expect(executable).not.toMatch(/\breadonly stage\?:/);
    expect(executable).not.toMatch(/\breadonly cause\?:/);
  });

  it("keeps the durable boundary free of the request and the full descriptor", () => {
    const boundary = read("packages/agent/src/loop/ports/model-turn-boundary.ts");
    const executable = boundary
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    expect(executable).toContain('readonly model: ModelDescriptor["ref"];');
    expect(executable).not.toMatch(/\breadonly request:/);
    expect(executable).not.toMatch(/\breadonly model: ModelDescriptor;/);
  });

  it("keeps the admission decision carrying the approved request", () => {
    const admission = read("packages/agent/src/loop/ports/model-request-admission.ts");
    const executable = admission
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    expect(executable).toContain("export type ModelRequestAdmissionDecision =");
    expect(executable).toContain("readonly request: AIModelRequest;");
    // The frozen input names the identity, the turn and the request — no second model authority
    // and no cancellation signal.
    expect(executable).not.toMatch(/\breadonly model: ModelDescriptor;/);
    expect(executable).not.toMatch(/\breadonly signal: AbortSignal;/);
    expect(executable).not.toContain("AgentModelAdmissionDecision");
  });

  it("keeps every transient delta correlated and the envelope unforwardable", () => {
    const events = read("packages/agent/src/loop/events/transient-stream-event.ts");
    const executable = events
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    // Each of the three deltas carries the correlation a multiplexed host needs.
    expect(executable.match(/readonly runId: RunId;/g)).toHaveLength(3);
    expect(executable.match(/readonly stepId: StepId;/g)).toHaveLength(3);
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

  it("keeps the loop dependencies frozen: required classifier, no request builder", () => {
    const loop = read("packages/agent/src/loop/agent-loop.ts");
    const executable = loop
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

    expect(executable).toContain("readonly decisionClassifier: AgentDecisionClassifier;");
    expect(executable).not.toMatch(/\breadonly decisionClassifier\?:/);
    expect(executable).not.toMatch(/\breadonly modelRequestBuilder\?:/);
    // The classifier has no loop-supplied default: the composition root owns it.
    expect(executable).not.toContain("dependencies.decisionClassifier ??");
    // The loop performs no retry, no sleep and no backoff of its own.
    expect(executable).not.toMatch(/\bsetTimeout|\bsetInterval|\bsleep\b/);
    expect(executable).not.toMatch(/\bwhile\s*\(/);
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

    // Phase 3E retired the facade from production composition, so exactly one Core port still names
    // it: the resumable Agent loop, whose frozen dependencies are unchanged. The verification
    // reviewer runs on the explicit-identity client instead, because a review is a host action about
    // a Run rather than an Agent Reason.
    expect(read("packages/core/src/agent-loop-ports.ts")).toContain("LegacyModelTurnExecutor");
    expect(read("packages/core/src/task-acceptance-reviewer.ts")).not.toContain(
      "LegacyModelTurnExecutor",
    );
    expect(read("packages/core/src/task-acceptance-reviewer.ts")).toContain(
      "readonly modelTurns: VerificationModelClient;",
    );
  });
});
