import { describe, expect, it } from "vitest";
import type { ToolSecurityFacts } from "@caelush/coding-agent";
import { evaluateInputSecurityPolicy } from "../src/index.js";

/**
 * The facts this fixture builds, named with the canonical Coding vocabulary.
 *
 * It is the single-path subset of `ToolSecurityFacts` — the two fields the input policy reads for a
 * path (`shellCommand`, `structuralPreview` and `opaqueInput` are what a Tool's own projector adds and
 * are covered by the Gate suite). Naming the subset is also what keeps the fixture assignable to the
 * policy's structural input type: the Coding vocabulary types `structuralPreview` with the AI core's
 * `JsonObject` and the policy types it with Protocol's, and only a value that carries the field would
 * have to reconcile the two.
 */
type SinglePathFacts = Pick<ToolSecurityFacts, "resourceAccesses" | "secretScanInputs">;

const facts = (path: string, operation: "READ" | "WRITE" = "READ"): SinglePathFacts => ({
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
