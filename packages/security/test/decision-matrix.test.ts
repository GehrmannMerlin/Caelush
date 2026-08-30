import { describe, expect, it } from "vitest";
import {
  evaluateSecurityPolicy,
  type SecurityPolicyInput,
  type SecurityDecision,
} from "../src/index.js";

function input(
  permissionProfile: SecurityPolicyInput["permissionProfile"],
  approvalPolicy: SecurityPolicyInput["approvalPolicy"],
  riskLevel: SecurityPolicyInput["riskLevel"],
  requiredCapabilities: SecurityPolicyInput["requiredCapabilities"] = [],
): SecurityPolicyInput {
  return { permissionProfile, approvalPolicy, riskLevel, requiredCapabilities };
}

function expectDecision(
  actual: SecurityDecision,
  kind: SecurityDecision["kind"],
  reasonCode: SecurityDecision["reasonCode"],
): void {
  expect(actual.kind).toBe(kind);
  expect(actual.reasonCode).toBe(reasonCode);
  expect(actual.safeReason.length).toBeGreaterThan(0);
}

describe("security policy decision matrix", () => {
  it.each([
    ["READ_ONLY", ["FS_WRITE"]],
    ["PROJECT_ACCESS", ["WEB_SEARCH"]],
  ] as const)("denies missing capabilities before approval for %s", (profile, required) => {
    const decision = evaluateSecurityPolicy(input(profile, "ALWAYS_ASK", "LOW", required));
    expectDecision(decision, "DENY", "MISSING_REQUIRED_CAPABILITY");
  });

  it("always asks for any capability-authorized Tool", () => {
    for (const riskLevel of ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const) {
      expectDecision(
        evaluateSecurityPolicy(input("READ_ONLY", "ALWAYS_ASK", riskLevel, ["FS_READ"])),
        "REQUIRE_APPROVAL",
        "APPROVAL_POLICY_REQUIRES_REVIEW",
      );
    }
  });

  it.each(["LOW", "MEDIUM"] as const)("allows %s under DANGEROUS_ONLY", (riskLevel) => {
    expectDecision(
      evaluateSecurityPolicy(input("READ_ONLY", "DANGEROUS_ONLY", riskLevel, ["FS_READ"])),
      "ALLOW",
      "ALLOWED_BY_POLICY",
    );
  });

  it.each(["HIGH", "CRITICAL"] as const)("asks for %s under DANGEROUS_ONLY", (riskLevel) => {
    expectDecision(
      evaluateSecurityPolicy(input("READ_ONLY", "DANGEROUS_ONLY", riskLevel, ["FS_READ"])),
      "REQUIRE_APPROVAL",
      "DANGEROUS_ACTION_REQUIRES_REVIEW",
    );
  });

  it("allows capability-authorized structured Tools under NEVER_ASK", () => {
    expectDecision(
      evaluateSecurityPolicy(
        input("PROJECT_ACCESS", "NEVER_ASK", "HIGH", ["FS_WRITE", "FS_DELETE"]),
      ),
      "ALLOW",
      "ALLOWED_BY_POLICY",
    );
  });

  it.each(["ALWAYS_ASK", "DANGEROUS_ONLY"] as const)(
    "requires approval for PROJECT_ACCESS unconfined process under %s",
    (approvalPolicy) => {
      expectDecision(
        evaluateSecurityPolicy(
          input("PROJECT_ACCESS", approvalPolicy, "CRITICAL", ["SHELL_EXEC", "PROCESS_START"]),
        ),
        "REQUIRE_APPROVAL",
        "UNCONFINED_EXECUTION_REQUIRES_REVIEW",
      );
    },
  );

  it("denies PROJECT_ACCESS unconfined process under NEVER_ASK", () => {
    expectDecision(
      evaluateSecurityPolicy(
        input("PROJECT_ACCESS", "NEVER_ASK", "LOW", ["SHELL_EXEC", "PROCESS_START"]),
      ),
      "DENY",
      "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL",
    );
  });

  it("allows FULL_ACCESS unconfined process under NEVER_ASK", () => {
    expectDecision(
      evaluateSecurityPolicy(input("FULL_ACCESS", "NEVER_ASK", "CRITICAL", ["SHELL_EXEC"])),
      "ALLOW",
      "ALLOWED_BY_POLICY",
    );
  });

  it("evaluates unknown future metadata without Tool-name allowlists", () => {
    expectDecision(
      evaluateSecurityPolicy(input("READ_ONLY", "DANGEROUS_ONLY", "LOW")),
      "ALLOW",
      "ALLOWED_BY_POLICY",
    );
    expectDecision(
      evaluateSecurityPolicy(input("FULL_ACCESS", "DANGEROUS_ONLY", "LOW", ["OUTSIDE_WORKSPACE"])),
      "ALLOW",
      "ALLOWED_BY_POLICY",
    );
  });
});
