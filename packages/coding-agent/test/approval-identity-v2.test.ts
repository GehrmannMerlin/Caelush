import { describe, expect, it } from "vitest";
import { computeCodingToolApprovalKey } from "../src/index.js";

const base = {
  toolName: "exec_command" as never,
  security: {
    riskLevel: "HIGH" as const,
    requiredCapabilities: ["SHELL_EXEC"] as const,
    runtimeRequirements: { runtimeKinds: ["local"] },
  },
  args: { cmd: "npm publish", workdir: ".", tty: false } as never,
  securityContext: {
    permissionProfile: "FULL_ACCESS" as const,
    approvalPolicy: "NEVER_ASK" as const,
    securityPolicy: {
      presetId: "FULL_ACCESS" as const,
      presetVersion: 1,
      policyDigest: "a".repeat(64),
      filesystemBoundary: "HOST_USER_SCOPE" as const,
      processBoundary: "UNRESTRICTED" as const,
      requiredEnforcement: "HARD_SAFETY_ONLY" as const,
    },
  },
};

describe("v2 Tool approval identity", () => {
  it("binds approvals to the immutable policy digest", () => {
    const key = computeCodingToolApprovalKey(base);
    const changed = computeCodingToolApprovalKey({
      ...base,
      securityContext: {
        ...base.securityContext,
        securityPolicy: {
          ...base.securityContext.securityPolicy,
          policyDigest: "b".repeat(64),
        },
      },
    });

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(key);
  });

  it("binds approvals to normalized effects and executable identity", () => {
    const key = computeCodingToolApprovalKey({
      ...base,
      effectDigest: "c".repeat(64),
      executableIdentity: "npm",
    });
    expect(
      computeCodingToolApprovalKey({
        ...base,
        effectDigest: "d".repeat(64),
        executableIdentity: "npm",
      }),
    ).not.toBe(key);
    expect(
      computeCodingToolApprovalKey({
        ...base,
        effectDigest: "c".repeat(64),
        executableIdentity: "pnpm",
      }),
    ).not.toBe(key);
  });

  it("keeps the legacy digest when no v2 identity fields are present", () => {
    const legacy = computeCodingToolApprovalKey({
      ...base,
      securityContext: {
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
      },
    });
    const same = computeCodingToolApprovalKey({
      ...base,
      securityContext: {
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
      },
    });
    expect(same).toBe(legacy);
  });
});
