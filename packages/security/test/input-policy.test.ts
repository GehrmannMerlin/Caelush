import { describe, expect, it } from "vitest";
import type { ToolSecurityFacts } from "@caelush/tools";
import { evaluateInputSecurityPolicy } from "../src/index.js";

const facts = (path: string, operation: "READ" | "WRITE" = "READ"): ToolSecurityFacts => ({
  resourceAccesses: [{ operation, path }],
  secretScanInputs: [],
});

describe("input-aware security policy", () => {
  it("requires review for sensitive resources even when base metadata would allow", () => {
    expect(
      evaluateInputSecurityPolicy(facts(".env"), {
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
      }).kind,
    ).toBe("REQUIRE_APPROVAL");
  });

  it("denies sensitive resources under NEVER_ASK", () => {
    expect(
      evaluateInputSecurityPolicy(facts(".env", "WRITE"), {
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "NEVER_ASK",
      }).kind,
    ).toBe("DENY");
  });

  it("keeps normal resources unrestricted and template env files ordinary", () => {
    expect(
      evaluateInputSecurityPolicy(facts("src/app.ts"), {
        permissionProfile: "READ_ONLY",
        approvalPolicy: "DANGEROUS_ONLY",
      }).kind,
    ).toBe("NO_ADDITIONAL_RESTRICTION");
    expect(
      evaluateInputSecurityPolicy(facts(".env.example"), {
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
      }).kind,
    ).toBe("NO_ADDITIONAL_RESTRICTION");
  });
});
