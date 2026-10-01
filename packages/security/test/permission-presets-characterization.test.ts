import { describe, expect, it } from "vitest";
import { evaluateSecurityPolicy, type SecurityPolicyInput } from "../src/index.js";

function evaluate(
  permissionProfile: SecurityPolicyInput["permissionProfile"],
  approvalPolicy: SecurityPolicyInput["approvalPolicy"],
  riskLevel: SecurityPolicyInput["riskLevel"],
  requiredCapabilities: SecurityPolicyInput["requiredCapabilities"],
) {
  return evaluateSecurityPolicy({
    permissionProfile,
    approvalPolicy,
    riskLevel,
    requiredCapabilities,
  });
}

describe("pre-permission-preset behavior characterization", () => {
  it("keeps the current workspace-write shell approval boundary", () => {
    expect(
      evaluate("PROJECT_ACCESS", "DANGEROUS_ONLY", "LOW", ["SHELL_EXEC", "PROCESS_START"]),
    ).toMatchObject({
      kind: "REQUIRE_APPROVAL",
      reasonCode: "UNCONFINED_EXECUTION_REQUIRES_REVIEW",
    });
  });

  it("keeps the current Full Access unconfined shell allow behavior", () => {
    expect(
      evaluate("FULL_ACCESS", "NEVER_ASK", "CRITICAL", ["SHELL_EXEC", "PROCESS_START"]),
    ).toMatchObject({ kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY" });
  });

  it("keeps missing capabilities denied before approval policy evaluation", () => {
    expect(evaluate("READ_ONLY", "ALWAYS_ASK", "LOW", ["FS_WRITE"])).toMatchObject({
      kind: "DENY",
      reasonCode: "MISSING_REQUIRED_CAPABILITY",
    });
  });

  it("keeps current dangerous-only approval for high-risk structured Tools", () => {
    expect(evaluate("PROJECT_ACCESS", "DANGEROUS_ONLY", "HIGH", ["FS_WRITE"])).toMatchObject({
      kind: "REQUIRE_APPROVAL",
      reasonCode: "DANGEROUS_ACTION_REQUIRES_REVIEW",
    });
  });
});
