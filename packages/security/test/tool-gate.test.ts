import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushToolExecutionGate, SecurityPolicyInvariantError } from "../src/index.js";

const invocation = {
  id: createToolInvocationId(),
  runId: createRunId(),
  stepId: createStepId(),
  toolName: "apply_patch" as const,
  externalCallId: "call-1",
  args: {
    patch: "SECRET_COMMAND_9A_123 SECRET_PATH_9A_456 SECRET_TOKEN_9A_789",
  },
  riskLevel: "HIGH" as const,
  status: "REQUESTED" as const,
  createdAt: createTimestampMs(1),
};

const definition = {
  name: "apply_patch" as const,
  riskLevel: "HIGH" as const,
  requiredCapabilities: ["FS_WRITE", "FS_DELETE"] as const,
  runtimeRequirements: {},
};

describe("Caelush Tool execution Gate", () => {
  it("converts a Tool boundary request into a policy decision", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
    });

    expect(decision).toMatchObject({ kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY" });
  });

  it("fails closed for a Tool risk metadata mismatch without leaking arguments", async () => {
    await expect(
      new CaelushToolExecutionGate().decide({
        invocation,
        toolName: definition.name,
        definition: { ...definition, riskLevel: "LOW" },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      }),
    ).rejects.toBeInstanceOf(SecurityPolicyInvariantError);
    await expect(
      new CaelushToolExecutionGate().decide({
        invocation,
        toolName: definition.name,
        definition: { ...definition, riskLevel: "LOW" },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      }),
    ).rejects.not.toThrow("SECRET_");
  });
});
