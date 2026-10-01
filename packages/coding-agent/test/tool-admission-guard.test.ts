import { createRunId, createSessionId, createStepId, createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createCodingToolAdmissionPort,
  computeCodingToolApprovalKey,
  createToolGuardPipeline,
  type CodingToolDefinition,
  type ToolGuardDecision,
} from "../src/index.js";
import type {
  ToolAdmissionRequest,
  ToolExecutionGatePort,
  ToolPolicyDecision,
} from "@caelush/agent";
import { CaelushToolExecutionGate } from "@caelush/security";

const request: ToolAdmissionRequest = {
  identity: {
    runId: createRunId(),
    sessionId: createSessionId(),
    sourceStepId: createStepId(),
    invocationId: "tinv_0190f2f0-7d9a-7d5f-b7bb-3e3d5f2af101" as never,
    externalCallId: "call-1",
  },
  toolName: "exec_command" as never,
  args: { cmd: "echo hello", workdir: "." },
  environment: {
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    runtime: { id: "local", kind: "local" },
  },
  securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
};

const catalogEntry = {
  tool: { name: "exec_command" },
  security: {
    riskLevel: "HIGH" as const,
    requiredCapabilities: ["SHELL_EXEC"] as const,
    runtimeRequirements: {},
  },
  securityFactsProjector: () => ({
    resourceAccesses: [],
    secretScanInputs: [{ kind: "COMMAND", text: "echo hello" }],
    shellCommand: { command: "echo hello", workdir: ".", tty: false },
    structuralPreview: { kind: "SHELL_COMMAND", command: "echo hello" },
  }),
} as unknown as CodingToolDefinition;

function build(
  decision: ToolPolicyDecision,
  guardDecision?: ToolGuardDecision,
): ReturnType<typeof createCodingToolAdmissionPort> {
  const gate: ToolExecutionGatePort = {
    async decide() {
      return decision.kind === "ALLOW"
        ? { kind: "ALLOW" as const }
        : decision.kind === "DENY"
          ? { kind: "DENY" as const, reasonCode: "CORE_DENY" }
          : { kind: "REQUIRE_APPROVAL" as const, safeReason: "Core review" };
    },
  };
  const guard =
    guardDecision === undefined
      ? undefined
      : createToolGuardPipeline({
          registrations: [
            {
              id: "guard-1" as never,
              priority: 1,
              criticality: "REQUIRED",
              timeoutMs: 100,
              hook: { evaluate: async () => guardDecision },
            },
          ],
        });
  return createCodingToolAdmissionPort({
    gate,
    registry: { resolve: () => ({ tool: { name: "exec_command" } }) as never },
    catalog: { get: () => catalogEntry },
    ...(guard === undefined ? {} : { guard }),
  });
}

describe("Phase 6G Coding admission Guard integration", () => {
  it("exposes only bounded policy-safe facts to Guard hooks", async () => {
    let observed: Record<string, unknown> | undefined;
    const port = createCodingToolAdmissionPort({
      gate: {
        async decide() {
          return { kind: "ALLOW" as const };
        },
      },
      registry: { resolve: () => ({ tool: { name: "exec_command" } }) as never },
      catalog: { get: () => catalogEntry },
      guard: createToolGuardPipeline({
        registrations: [
          {
            id: "facts" as never,
            priority: 1,
            criticality: "REQUIRED",
            timeoutMs: 100,
            hook: {
              evaluate: async (input) => {
                observed = input.safeFacts;
                return { kind: "PASS" as const };
              },
            },
          },
        ],
      }),
    });

    await port.evaluate(
      {
        ...request,
        securityContext: {
          ...request.securityContext,
          permissionProfile: "FULL_ACCESS",
          approvalPolicy: "NEVER_ASK",
          securityPolicy: {
            presetId: "FULL_ACCESS",
            presetVersion: 1,
            policyDigest: "a".repeat(64),
            filesystemBoundary: "HOST_USER_SCOPE",
            processBoundary: "UNRESTRICTED",
            requiredEnforcement: "HARD_SAFETY_ONLY",
          },
        },
      },
      { mode: "EXECUTE", signal: new AbortController().signal },
    );

    expect(observed).toMatchObject({
      securityPolicy: {
        presetId: "FULL_ACCESS",
        filesystemBoundary: "HOST_USER_SCOPE",
        processBoundary: "UNRESTRICTED",
      },
    });
    expect(JSON.stringify(observed)).not.toContain("echo hello");
  });

  it("allows ordinary Full Access publishing without an approval decision", async () => {
    const gate = new CaelushToolExecutionGate();
    const decision = await gate.decide({
      invocation: {
        id: request.identity.invocationId,
        runId: request.identity.runId,
        stepId: request.identity.sourceStepId,
        toolName: request.toolName,
        externalCallId: request.identity.externalCallId,
        args: { cmd: "npm publish", workdir: ".", tty: false },
        riskLevel: "HIGH",
        status: "REQUESTED",
        createdAt: 0 as never,
      },
      toolName: request.toolName,
      definition: {
        name: request.toolName,
        riskLevel: "HIGH",
        requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
        runtimeRequirements: { runtimeKinds: ["local"] },
      },
      securityContext: {
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
        securityPolicy: {
          presetId: "FULL_ACCESS",
          presetVersion: 1,
          policyDigest: "a".repeat(64),
          filesystemBoundary: "HOST_USER_SCOPE",
          processBoundary: "UNRESTRICTED",
          requiredEnforcement: "HARD_SAFETY_ONLY",
        },
      },
      runtimeKind: "local",
      securityFacts: {
        resourceAccesses: [],
        secretScanInputs: [{ kind: "COMMAND", text: "npm publish" }],
        shellCommand: { command: "npm publish", workdir: ".", tty: false },
      },
    });

    expect(decision).toMatchObject({ kind: "ALLOW" });
  });

  it("hard-denies power control before any approval can be created", async () => {
    const gate = new CaelushToolExecutionGate();
    const decision = await gate.decide({
      invocation: {
        id: request.identity.invocationId,
        runId: request.identity.runId,
        stepId: request.identity.sourceStepId,
        toolName: request.toolName,
        externalCallId: request.identity.externalCallId,
        args: { cmd: "shutdown now", workdir: ".", tty: false },
        riskLevel: "HIGH",
        status: "REQUESTED",
        createdAt: 0 as never,
      },
      toolName: request.toolName,
      definition: {
        name: request.toolName,
        riskLevel: "HIGH",
        requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
        runtimeRequirements: { runtimeKinds: ["local"] },
      },
      securityContext: {
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
        securityPolicy: {
          presetId: "FULL_ACCESS",
          presetVersion: 1,
          policyDigest: "a".repeat(64),
          filesystemBoundary: "HOST_USER_SCOPE",
          processBoundary: "UNRESTRICTED",
          requiredEnforcement: "HARD_SAFETY_ONLY",
        },
      },
      runtimeKind: "local",
      securityFacts: {
        resourceAccesses: [],
        secretScanInputs: [{ kind: "COMMAND", text: "shutdown now" }],
        shellCommand: { command: "shutdown now", workdir: ".", tty: false },
      },
    });

    expect(decision).toMatchObject({ kind: "DENY" });
    expect(decision.kind === "DENY" ? decision.reasonCode : undefined).toBe("POWER_CONTROL_DENIED");
  });

  it("turns a Guard BLOCK into safe denial without skipping Core Security", async () => {
    let coreCalls = 0;
    const gate: ToolExecutionGatePort = {
      async decide() {
        coreCalls += 1;
        return { kind: "ALLOW" as const };
      },
    };
    const port = createCodingToolAdmissionPort({
      gate,
      registry: { resolve: () => ({ tool: { name: "exec_command" } }) as never },
      catalog: { get: () => catalogEntry },
      guard: createToolGuardPipeline({
        registrations: [
          {
            id: "blocked" as never,
            priority: 1,
            criticality: "OPTIONAL",
            timeoutMs: 100,
            hook: { evaluate: async () => ({ kind: "BLOCK", code: "NOPE", reason: "Nope" }) },
          },
        ],
      }),
    });

    const result = await port.evaluate(request, {
      mode: "EXECUTE",
      signal: new AbortController().signal,
    });

    expect(coreCalls).toBe(1);
    expect(result).toMatchObject({ kind: "DENY", feedback: { code: "PERMISSION_DENIED" } });
  });

  it("keeps the legacy approval key without a Guard and changes it when Guard adds approval", async () => {
    const core = { kind: "ALLOW" as const };
    const legacy = await build(core).evaluate(request);
    const guarded = await build(core, {
      kind: "REQUIRE_APPROVAL",
      code: "REVIEW_COMMAND",
      reason: "Review command",
    }).evaluate(request, { mode: "RECOVER", signal: new AbortController().signal });
    const expectedLegacy = computeCodingToolApprovalKey({
      toolName: request.toolName,
      security: catalogEntry.security as never,
      args: request.args,
      securityContext: request.securityContext,
    });

    expect(legacy).toMatchObject({ kind: "ALLOW" });
    expect(guarded).toMatchObject({ kind: "REQUIRE_APPROVAL" });
    if (guarded.kind !== "REQUIRE_APPROVAL") throw new Error("expected Guard approval");
    expect(guarded.requirement.key).not.toBe(expectedLegacy);
  });
});
