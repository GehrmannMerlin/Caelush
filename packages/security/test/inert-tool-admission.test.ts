import { createUpdatePlanTool } from "@caelush/coding-agent";
import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  CaelushToolExecutionGate,
  evaluateLogicalSandboxAdmission,
  resolveToolExecutionRequirement,
} from "../src/index.js";

/**
 * The admission of a Tool that declared no host access.
 *
 * ```text
 * declaration                 the trusted catalog says: no capability, no runtime
 * projected facts             the Tool says: nothing is accessed
 *        ↓
 * startup coverage check      accepts the combination
 * runtime logical sandbox     must accept the same combination
 * policy evaluation           still decides permission, unchanged
 * ```
 *
 * These cases exist because the two readers of that declaration used to disagree. The startup check
 * accepted "no capability, no runtime" as a deliberately inert Tool, and the runtime sandbox
 * required a `local` runtime kind from it anyway — so `update_plan`, the Tool whose entire purpose is
 * to record a plan, was registered, offered to a model and then always refused with
 * `RUNTIME_KIND_UNSUPPORTED`.
 *
 * Each case names the failure it would have caused, so a regression reads as the bug it is.
 */

function planSecurityMetadata() {
  const definition = createUpdatePlanTool();
  return { definition, security: definition.security };
}

const planFacts = {
  resourceAccesses: [] as const,
  secretScanInputs: [] as const,
  structuralPreview: { kind: "GENERIC", purpose: "PLAN" },
};

function planInvocation() {
  return {
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: "update_plan" as const,
    externalCallId: "call-plan-1",
    args: { plan: [{ step: "Read the workspace", status: "in_progress" as const }] },
    riskLevel: "LOW" as const,
    status: "REQUESTED" as const,
    createdAt: createTimestampMs(1),
  };
}

describe("inert control Tool admission", () => {
  it("resolves the real update_plan declaration as IN_PROCESS", () => {
    expect(planSecurityMetadata().security.requiredCapabilities).toEqual([]);
    expect(
      resolveToolExecutionRequirement({
        requiredCapabilities: planSecurityMetadata().security.requiredCapabilities,
        runtimeRequirements: planSecurityMetadata().security.runtimeRequirements,
      }),
    ).toEqual({ kind: "IN_PROCESS" });
  });

  it("admits update_plan to the logical sandbox without inventing a host runtime", () => {
    const { security } = planSecurityMetadata();
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "local",
        runtimeRequirements: security.runtimeRequirements,
        requiredCapabilities: security.requiredCapabilities,
        securityFacts: planFacts,
      }),
    ).toEqual({ kind: "ALLOW", containment: "STRUCTURED_WORKSPACE" });
  });

  it("still requires the projected security facts of an inert Tool", () => {
    const { security } = planSecurityMetadata();
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "local",
        runtimeRequirements: security.runtimeRequirements,
        requiredCapabilities: security.requiredCapabilities,
        securityFacts: undefined,
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "SECURITY_FACTS_UNAVAILABLE" });
  });

  it("refuses an inert declaration whose facts claim host access", () => {
    const { security } = planSecurityMetadata();
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "local",
        runtimeRequirements: security.runtimeRequirements,
        requiredCapabilities: security.requiredCapabilities,
        securityFacts: {
          resourceAccesses: [{ operation: "WRITE", path: "src/app.ts" }],
          secretScanInputs: [],
        },
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "INERT_TOOL_HOST_ACCESS_DECLARED" });

    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "local",
        runtimeRequirements: security.runtimeRequirements,
        requiredCapabilities: security.requiredCapabilities,
        securityFacts: {
          resourceAccesses: [],
          secretScanInputs: [],
          shellCommand: { command: "echo hi", workdir: ".", tty: false },
        },
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "INERT_TOOL_HOST_ACCESS_DECLARED" });
  });

  it("refuses the two incoherent declaration combinations", () => {
    expect(
      resolveToolExecutionRequirement({
        requiredCapabilities: [],
        runtimeRequirements: { runtimeKinds: ["local"] },
      }),
    ).toEqual({ kind: "INVALID", reason: "METADATA_MISMATCH" });
    expect(
      resolveToolExecutionRequirement({
        requiredCapabilities: ["FS_READ"],
        runtimeRequirements: { runtimeKinds: [] },
      }),
    ).toEqual({ kind: "INVALID", reason: "METADATA_MISMATCH" });
    expect(
      resolveToolExecutionRequirement({
        requiredCapabilities: [],
        runtimeRequirements: { runtimeKinds: "local" as never },
      }),
    ).toEqual({ kind: "INVALID", reason: "METADATA_MISMATCH" });
  });

  it("refuses a host Tool when the active runtime kind is not among its declared kinds", () => {
    expect(
      evaluateLogicalSandboxAdmission({
        containment: "STRUCTURED_WORKSPACE",
        runtimeKind: "remote",
        runtimeRequirements: { runtimeKinds: ["local"] },
        requiredCapabilities: ["FS_READ"],
        securityFacts: { resourceAccesses: [], secretScanInputs: [] },
      }),
    ).toMatchObject({ kind: "DENY", reasonCode: "RUNTIME_KIND_UNSUPPORTED" });
  });

  it("admits the real plan call through the real Gate under every preset", async () => {
    const { security } = planSecurityMetadata();
    const gate = new CaelushToolExecutionGate();
    const definition = {
      name: "update_plan" as const,
      riskLevel: security.riskLevel,
      requiredCapabilities: security.requiredCapabilities,
      runtimeRequirements: security.runtimeRequirements,
    };
    for (const [permissionProfile, approvalPolicy] of [
      ["READ_ONLY", "ON_BOUNDARY"],
      ["PROJECT_ACCESS", "ON_BOUNDARY"],
      ["FULL_ACCESS", "NEVER_ASK"],
    ] as const) {
      const decision = await gate.decide({
        invocation: planInvocation(),
        toolName: "update_plan",
        definition,
        securityContext: { permissionProfile, approvalPolicy },
        securityFacts: planFacts,
      });
      expect(decision.kind, `${permissionProfile} must not deny the plan`).toBe("ALLOW");
      expect(decision.reasonCode).not.toBe("RUNTIME_KIND_UNSUPPORTED");
    }
  });

  it("keeps a host-modifying Tool under the same admission it always had", async () => {
    const gate = new CaelushToolExecutionGate();
    const invocation = {
      ...planInvocation(),
      toolName: "apply_patch" as const,
      riskLevel: "HIGH" as const,
    };
    const definition = {
      name: "apply_patch" as const,
      riskLevel: "HIGH" as const,
      requiredCapabilities: ["FS_WRITE", "FS_DELETE"] as const,
      runtimeRequirements: { runtimeKinds: ["local"] },
    };
    const decision = await gate.decide({
      invocation,
      toolName: "apply_patch",
      definition,
      securityContext: { permissionProfile: "READ_ONLY", approvalPolicy: "ON_BOUNDARY" },
      securityFacts: {
        resourceAccesses: [{ operation: "WRITE", path: "src/app.ts" }],
        secretScanInputs: [],
      },
    });
    expect(decision.kind).toBe("DENY");
  });
});
