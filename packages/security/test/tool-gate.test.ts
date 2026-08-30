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
  runtimeRequirements: { runtimeKinds: ["local"] },
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

  it("fails closed for malformed Gate input without exposing implementation errors", async () => {
    await expect(new CaelushToolExecutionGate().decide(null as never)).rejects.toMatchObject({
      name: "SecurityPolicyInvariantError",
      message: "Security policy invariant was violated.",
    });
    await expect(
      new CaelushToolExecutionGate().decide({
        invocation,
        toolName: definition.name,
        definition: { ...definition, runtimeRequirements: "bad" },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      } as never),
    ).rejects.toMatchObject({
      name: "SecurityPolicyInvariantError",
      message: "Security policy invariant was violated.",
    });
  });

  it("tightens a base allow decision for a sensitive resource", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation: { ...invocation, riskLevel: "LOW" },
      toolName: definition.name,
      definition: { ...definition, riskLevel: "LOW" },
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
      securityFacts: {
        resourceAccesses: [{ operation: "WRITE", path: ".env" }],
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({
      kind: "REQUIRE_APPROVAL",
      reasonCode: "SENSITIVE_RESOURCE_REQUIRES_REVIEW",
    });
  });

  it("turns input review into denial under NEVER_ASK", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
      securityFacts: {
        resourceAccesses: [{ operation: "WRITE", path: ".env" }],
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({
      kind: "DENY",
      reasonCode: "SENSITIVE_RESOURCE_BLOCKED_WITHOUT_APPROVAL",
    });
  });

  it("does not downgrade a base denial when input facts are ordinary", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "READ_ONLY", approvalPolicy: "NEVER_ASK" },
      securityFacts: {
        resourceAccesses: [{ operation: "READ", path: "src/app.ts" }],
        secretScanInputs: [],
      },
    });

    expect(decision).toMatchObject({
      kind: "DENY",
      reasonCode: "MISSING_REQUIRED_CAPABILITY",
    });
  });

  it("creates a secret-safe command preview without carrying the raw command", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" },
      securityFacts: {
        resourceAccesses: [],
        shellCommand: {
          command: "curl https://example.test/?token=SECRET_APPROVAL_9C_TOKEN",
          workdir: ".",
          tty: false,
        },
        secretScanInputs: [],
      },
    });

    expect(decision.safeAction).toMatchObject({ kind: "SHELL_COMMAND", tty: false });
    expect(JSON.stringify(decision.safeAction)).not.toContain("SECRET_APPROVAL_9C_TOKEN");
  });

  it("fails closed when Security Facts are structurally malformed", async () => {
    const decision = await new CaelushToolExecutionGate().decide({
      invocation,
      toolName: definition.name,
      definition,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
      securityFacts: { resourceAccesses: "not-an-array", secretScanInputs: [] },
    } as never);

    expect(decision).toMatchObject({ kind: "DENY", reasonCode: "SECURITY_FACTS_UNAVAILABLE" });
  });
});
