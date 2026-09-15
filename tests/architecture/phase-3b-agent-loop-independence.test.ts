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
  return sourceFiles(join(root, "packages", "agent", "src", "loop")).map((path) =>
    relative(root, path).replaceAll("\\", "/"),
  );
}

/**
 * The frozen Reason Kernel's own files.
 *
 * The lifecycle assertions below are scoped to `loop/`: Phase 3C added the Run execution decision
 * under `run/`, which legitimately names Run states, and a loop-scoped guard is what keeps the
 * property meaningful — the kernel is what must not own a lifecycle, not the package that also
 * contains the Run Layer's routing vocabulary.
 */
function kernelFiles(): string[] {
  return sourceFiles(join(root, "packages", "agent", "src", "loop")).map((path) =>
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
    for (const file of kernelFiles()) {
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
    for (const file of kernelFiles()) {
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
    for (const file of kernelFiles()) {
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

/**
 * Phase 3B frozen boundary remediation guards.
 *
 * The compile-time file `packages/agent/test/contracts/phase-3b-frozen-boundaries.test.ts` is the
 * contract-level guarantee: it restates the frozen boundary shapes and fails `pnpm typecheck` on
 * an added, renamed or dropped field. These guards are the structural half — they keep the
 * canonical implementation in the kernel, keep the provenance the Run Layer's to own, and fail
 * loudly if the exactness file is deleted or narrowed.
 */
describe("Phase 3B frozen boundary remediation", () => {
  it("keeps the boundary exactness file present and complete", () => {
    const exactness = read("packages/agent/test/contracts/phase-3b-frozen-boundaries.test.ts");
    for (const contract of ["ContextPrepareInput", "ContextProviderInput", "ContextProvider"]) {
      expect(exactness, contract).toContain(contract);
    }
    expect(exactness).toContain("Expect<Equal<");
    // The negative control: the removed field must be asserted absent, not merely unmentioned.
    expect(exactness).toContain("ProviderInputHasNoHistory");
  });

  it("keeps ContextProviderInput to the five frozen fields", () => {
    const port = read("packages/agent/src/loop/context/context-engine-port.ts");
    const input = port.slice(
      port.indexOf("export interface ContextProviderInput"),
      port.indexOf("export interface ContextProviderInput") === -1
        ? undefined
        : port.indexOf("/**", port.indexOf("export interface ContextProviderInput")),
    );
    const fields = [...input.matchAll(/^\s+readonly (\w+)[?]?:/gm)].map((match) => match[1] ?? "");
    // A provider may read the resolved model. It never receives the conversation: handing it the
    // whole durable history would let every provider become a second conversation assembler.
    expect(fields.sort()).toEqual(["identity", "input", "model", "signal", "turn"]);
    expect(fields).not.toContain("history");
  });

  it("resolves no model inside the legacy Context adapter", () => {
    const adapter = executable("packages/core/src/legacy-context-runtime-adapter.ts");
    // `ContextPrepareInput.model` is the single descriptor authority for a context build.
    expect(adapter).not.toMatch(/ModelCatalog/);
    expect(adapter).not.toMatch(/models\.resolve\(/);
    expect(adapter).toContain("const descriptor = input.model;");
  });

  it("declares no provider option the legacy adapter cannot consume", () => {
    const adapter = executable("packages/core/src/legacy-context-runtime-adapter.ts");
    // The frozen seam exists and is conformance-tested. The legacy assembler has no injection
    // point that could take a ContextItem without changing prompt order or the token budget, so
    // declaring support it ignores would be a misleading API.
    expect(adapter).not.toMatch(/providers\?:/);
    expect(adapter).not.toMatch(/ContextProvider\b/);
  });

  it("owns general turn validation in the kernel, not in Core", () => {
    const canonical = read("packages/agent/src/loop/history/conversation-history.ts");
    for (const exported of [
      "assertAgentTurnInput",
      "assertPendingAssistantHistory",
      "assertConversationProtocolIntegrity",
      "AgentTurnInputError",
    ]) {
      expect(canonical, exported).toContain(exported);
    }
    // The kernel's validator may not reach for a host context implementation.
    for (const forbidden of [
      "@caelush/context",
      "@caelush/tools",
      "@caelush/runtime",
      "@caelush/core",
    ]) {
      expect(canonical).not.toContain(`"${forbidden}"`);
    }

    const core = executable("packages/core/src/agent-loop-history.ts");
    // Core delegates the general checks and keeps only the Run/Coding projection invariants.
    expect(core).toContain("assertPendingAssistantHistory");
    expect(core).toContain("assertConversationProtocolIntegrity");
    expect(core).toContain('from "@caelush/agent"');
    // The legacy Context conversation grouping is no longer a second implementation here.
    expect(core).not.toContain("@caelush/context");
    expect(core).not.toMatch(/validateAndGroupConversation/);
    // And the Run/Coding invariants stay where they belong.
    for (const retained of ["run and state must both be RUNNING", "history source sequences"]) {
      expect(core, retained).toContain(retained);
    }
  });

  it("invokes turn validation before the Context Engine", () => {
    const loop = executable("packages/agent/src/loop/agent-loop.ts");
    const validation = loop.indexOf("assertAgentTurnInput(input.input)");
    const context = loop.indexOf("prepare(dependencies.contextEngine");
    expect(validation).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(-1);
    // An invalid batch must cost no context build, no admission decision, no commit, no call.
    expect(validation).toBeLessThan(context);
  });

  it("never casts a model call identity into a Step identity", () => {
    const violations: string[] = [];
    for (const directory of ["packages/core/src", "packages/agent/src"]) {
      for (const file of sourceFiles(join(root, directory))) {
        const relativePath = relative(root, file).replaceAll("\\", "/");
        const source = executable(relativePath);
        // The call identity is an `llm_…` value and a Step identity is an `stp_…` one; a cast
        // between them is a fabricated Step, however it is spelled.
        if (/callId[^\n;]*\bas\s+StepId/.test(source)) violations.push(relativePath);
        if (/callId\s+as\s+never\s+as\s+StepId/.test(source)) violations.push(relativePath);
      }
    }
    expect(violations).toEqual([]);
  });

  it("threads the durable Tool request Step through the Run Layer", () => {
    const facade = executable("packages/core/src/agent-loop.ts");
    // The Step comes from the caller, never from the decision or the attempt.
    expect(facade).toContain("sourceStepId: input.sourceStepId");
    expect(facade).not.toMatch(/sourceStepId:\s*input\.pendingDecision/);

    const controller = executable("packages/core/src/run-controller.ts");
    expect(controller).toContain("sourceStepId");
    // A legacy checkpoint without provenance is either determined durably or refused, never
    // guessed — and the normalization is a real write, not a runtime special case.
    expect(controller).toContain("recoverToolRequestSourceStep");
    expect(controller).toContain("cannot be recovered without guessing");
    expect(controller).toContain("normalizeLegacyRetryProvenance");
    expect(controller).not.toContain("recoverToolRequestSourceStep(snapshot, retryContinuation");

    const continuation = executable("packages/core/src/agent-continuation.ts");
    expect(continuation).toContain("readonly sourceStepId?: StepId | undefined;");
  });

  it("routes verification repair through the frozen continuation", () => {
    const controller = executable("packages/core/src/run-controller.ts");
    // Phase 3C checkpoint 6 moved this off the legacy facade: the coordinator's own
    // `COMPLETION_REPAIR` decision is what the production Run Layer executes, and the turn input it
    // carries is the frozen `CONTINUATION(VERIFICATION_REPAIR)` — never a re-derived user turn.
    expect(controller).not.toContain("continueRun({");
    expect(controller).toContain("this.coordinator.next(");
    expect(controller).toContain("COMPLETION_REPAIR");
    expect(controller).toContain("WAITING_VERIFICATION_REPAIR");

    // The frozen kernel owns the continuation turn kind itself.
    const kernel = executable("packages/agent/src/run/run-execution-coordinator.ts");
    expect(kernel).toContain('advance("RECOVER", "COMPLETION_REPAIR"');
    expect(kernel).toContain('kind: "CONTINUATION"');
    expect(kernel).toContain('reason: "VERIFICATION_REPAIR"');

    const facade = executable("packages/core/src/agent-loop.ts");
    expect(facade).toContain('kind: "CONTINUATION"');
    expect(facade).toContain("reason: input.reason");
  });
});
