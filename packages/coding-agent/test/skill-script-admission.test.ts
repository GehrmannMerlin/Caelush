import { describe, expect, it } from "vitest";
import { createRunId, createSessionId, createStepId, createWorkspaceId } from "@caelush/protocol";
import {
  computeCodingToolApprovalKey,
  createCodingToolAdmissionPort,
  createToolGuardPipeline,
  createRunSkillScriptTool,
  projectRunSkillScriptSecurityFacts,
  type CodingToolApprovalIdentityInput,
} from "../src/index.js";
import type { ToolAdmissionRequest, ToolExecutionGatePort } from "@caelush/agent";

const safeSecurityContext: CodingToolApprovalIdentityInput["securityContext"] = {
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  securityPolicy: {
    presetId: "WORKSPACE_WRITE",
    presetVersion: 1,
    policyDigest: "a".repeat(64),
    filesystemBoundary: "WORKSPACE_READ_WRITE",
    processBoundary: "WORKSPACE_WRITE",
    requiredEnforcement: "OS_RESTRICTED",
  },
};

describe("run_skill_script admission", () => {
  it("uses the existing process execution risk and capability gate", () => {
    const definition = createRunSkillScriptTool();

    expect(definition.security).toMatchObject({
      riskLevel: "CRITICAL",
      requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.tool.scheduling).toMatchObject({ class: "UNKNOWN" });
  });

  it("projects only bounded identifiers and fingerprints, never raw script input", () => {
    const raw = {
      bindingId: "binding_private_1",
      resourcePath: "scripts/private-check.mjs",
      args: ["--token=do-not-expose", "C:/Users/test/private.txt"],
      workdir: "project folder",
      yieldTimeMs: 2500,
    };
    const facts = projectRunSkillScriptSecurityFacts(raw as never);
    const encoded = JSON.stringify(facts);

    expect(facts.structuralPreview).toMatchObject({
      kind: "SKILL_SCRIPT",
      argumentCount: 2,
      effectScope: "BOUND_BUNDLE_PROCESS",
    });
    expect(encoded).not.toContain("binding_private_1");
    expect(encoded).not.toContain("private-check.mjs");
    expect(encoded).not.toContain("do-not-expose");
    expect(encoded).not.toContain("C:/Users/test/private.txt");
  });

  it("binds process approvals to the exact immutable bundle authority", () => {
    const base: CodingToolApprovalIdentityInput = {
      toolName: "run_skill_script" as never,
      security: {
        riskLevel: "CRITICAL",
        requiredCapabilities: ["PROCESS_START", "SHELL_EXEC"],
        runtimeRequirements: { runtimeKinds: ["local"] },
      },
      args: {
        bindingId: "binding_1",
        resourcePath: "scripts/check.mjs",
        args: ["--mode", "check"],
      },
      securityContext: safeSecurityContext,
      effectDigest: "b".repeat(64),
      executableIdentity: "SKILL_SCRIPT:node",
    };

    const original = computeCodingToolApprovalKey(base);
    const replacedBundle = computeCodingToolApprovalKey({
      ...base,
      effectDigest: "c".repeat(64),
    });

    expect(replacedBundle).not.toBe(original);
  });

  it("uses the real admission and Guard port in EXECUTE and approved RECOVER modes", async () => {
    const definition = createRunSkillScriptTool();
    const modes: string[] = [];
    let observedSafeFacts: unknown;
    const gate: ToolExecutionGatePort = {
      async decide() {
        return { kind: "ALLOW" };
      },
    };
    const port = createCodingToolAdmissionPort({
      gate,
      registry: { resolve: () => ({ tool: definition.tool }) as never },
      catalog: { get: () => definition },
      guard: createToolGuardPipeline({
        registrations: [
          {
            id: "skill-script-facts" as never,
            priority: 1,
            criticality: "REQUIRED",
            timeoutMs: 100,
            hook: {
              evaluate: async (input, context) => {
                observedSafeFacts = input.safeFacts;
                modes.push(context.mode);
                return { kind: "PASS" as const };
              },
            },
          },
        ],
      }),
    });
    const admissionRequest: ToolAdmissionRequest = {
      identity: {
        runId: createRunId(),
        sessionId: createSessionId(),
        sourceStepId: createStepId(),
        invocationId: "tinv_0190f2f0-7d9a-7d5f-b7bb-3e3d5f2af101" as never,
        externalCallId: "call-script-1",
      },
      toolName: "run_skill_script" as never,
      args: {
        bindingId: "binding-private",
        resourcePath: "scripts/private.mjs",
        args: ["--secret=do-not-expose"],
        workdir: "project folder",
      },
      environment: {
        workspace: { id: createWorkspaceId(), path: "C:/workspace" },
        runtime: { id: "local", kind: "local" },
      },
      securityContext: safeSecurityContext,
    };

    for (const mode of ["EXECUTE", "RECOVER"] as const) {
      const result = await port.evaluate(admissionRequest, {
        mode,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: "ALLOW" });
    }

    const safeFactsText = JSON.stringify(observedSafeFacts);
    expect(modes).toEqual(["EXECUTE", "RECOVER"]);
    expect(observedSafeFacts).toMatchObject({
      structuralKind: "SKILL_SCRIPT",
      skillScript: { argumentCount: 1, effectScope: "BOUND_BUNDLE_PROCESS" },
    });
    expect(safeFactsText).not.toContain("binding-private");
    expect(safeFactsText).not.toContain("private.mjs");
    expect(safeFactsText).not.toContain("do-not-expose");
    expect(safeFactsText).not.toContain("C:/workspace");
  });

  it("issues different approval identities for different bound script effects", async () => {
    const definition = createRunSkillScriptTool();
    const port = createCodingToolAdmissionPort({
      gate: {
        async decide() {
          return { kind: "REQUIRE_APPROVAL", safeReason: "Process execution requires review." };
        },
      },
      registry: { resolve: () => ({ tool: definition.tool }) as never },
      catalog: { get: () => definition },
    });
    const baseRequest: ToolAdmissionRequest = {
      identity: {
        runId: createRunId(),
        sessionId: createSessionId(),
        sourceStepId: createStepId(),
        invocationId: "tinv_0190f2f0-7d9a-7d5f-b7bb-3e3d5f2af102" as never,
        externalCallId: "call-script-2",
      },
      toolName: "run_skill_script" as never,
      args: {
        bindingId: "binding-version-1",
        resourcePath: "scripts/check.mjs",
        args: ["--mode", "check"],
      },
      environment: {
        workspace: { id: createWorkspaceId(), path: "C:/workspace" },
        runtime: { id: "local", kind: "local" },
      },
      securityContext: safeSecurityContext,
    };
    const mode = { mode: "EXECUTE" as const, signal: new AbortController().signal };
    const first = await port.evaluate(baseRequest, mode);
    const changedBinding = await port.evaluate(
      { ...baseRequest, args: { ...baseRequest.args, bindingId: "binding-version-2" } },
      mode,
    );
    const changedArgs = await port.evaluate(
      { ...baseRequest, args: { ...baseRequest.args, args: ["--mode", "publish"] } },
      mode,
    );

    expect(first.kind).toBe("REQUIRE_APPROVAL");
    expect(changedBinding.kind).toBe("REQUIRE_APPROVAL");
    expect(changedArgs.kind).toBe("REQUIRE_APPROVAL");
    if (
      first.kind !== "REQUIRE_APPROVAL" ||
      changedBinding.kind !== "REQUIRE_APPROVAL" ||
      changedArgs.kind !== "REQUIRE_APPROVAL"
    ) {
      throw new Error("expected approval requirements");
    }
    expect(changedBinding.requirement.key).not.toBe(first.requirement.key);
    expect(changedArgs.requirement.key).not.toBe(first.requirement.key);
  });
});
