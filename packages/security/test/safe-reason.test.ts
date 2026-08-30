import { describe, expect, it } from "vitest";
import { evaluateSecurityPolicy } from "../src/index.js";

describe("safe security reasons", () => {
  it("never echo invocation-shaped secrets", () => {
    const decision = evaluateSecurityPolicy({
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      riskLevel: "CRITICAL",
      requiredCapabilities: ["SHELL_EXEC"],
    });
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain("SECRET_COMMAND_9A_123");
    expect(serialized).not.toContain("SECRET_PATH_9A_456");
    expect(serialized).not.toContain("SECRET_TOKEN_9A_789");
    expect(serialized).not.toContain("/absolute/host/path");
  });
});
