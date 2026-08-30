import { describe, expect, it } from "vitest";
import {
  SecurityPolicyInputError,
  evaluateSecurityPolicy,
  type SecurityPolicyInput,
} from "../src/index.js";

const valid: SecurityPolicyInput = {
  permissionProfile: "READ_ONLY",
  approvalPolicy: "DANGEROUS_ONLY",
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
};

describe("security policy input validation", () => {
  it.each([
    null,
    [],
    { ...valid, permissionProfile: "ADMIN" },
    { ...valid, approvalPolicy: "AUTO" },
    { ...valid, riskLevel: "EXTREME" },
    { ...valid, requiredCapabilities: ["NETWORK_ADMIN"] },
    { ...valid, extra: "reject me" },
  ])("rejects malformed policy input without exposing provider details", (input) => {
    expect(() => evaluateSecurityPolicy(input as never)).toThrow(SecurityPolicyInputError);
    expect(() => evaluateSecurityPolicy(input as never)).toThrow(
      "Security policy input is invalid.",
    );
  });
});
