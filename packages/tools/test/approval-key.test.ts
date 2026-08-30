import { describe, expect, it } from "vitest";
import { computeToolApprovalKey } from "../src/approval-key.js";

const definition = {
  name: "apply_patch" as const,
  description: "Apply a patch",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  riskLevel: "HIGH" as const,
  requiredCapabilities: ["FS_DELETE", "FS_WRITE"] as const,
  runtimeRequirements: { kind: "local", id: "runtime" },
};

describe("Tool approval identity", () => {
  it("is deterministic and canonicalizes only the approval identity fields", () => {
    const first = computeToolApprovalKey({
      toolName: definition.name,
      definition,
      args: { b: 2, a: 1 },
      securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "ALWAYS_ASK" },
    });
    const second = computeToolApprovalKey({
      toolName: definition.name,
      definition: { ...definition, description: "changed presentation" },
      args: { a: 1, b: 2 },
      securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "ALWAYS_ASK" },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when authorization-relevant identity changes", () => {
    const base = {
      toolName: definition.name,
      definition,
      args: { a: 1 },
      securityContext: {
        permissionProfile: "PROJECT_ACCESS" as const,
        approvalPolicy: "ALWAYS_ASK" as const,
      },
    };
    expect(computeToolApprovalKey(base)).not.toBe(
      computeToolApprovalKey({
        ...base,
        securityContext: { ...base.securityContext, permissionProfile: "FULL_ACCESS" },
      }),
    );
    expect(computeToolApprovalKey(base)).not.toBe(
      computeToolApprovalKey({ ...base, args: { a: 2 } }),
    );
  });
});
