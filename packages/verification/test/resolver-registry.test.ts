import {
  createVerificationCheckId,
  createVerificationPlanId,
  type VerificationCheck,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ProjectCheckResolverRegistry, type VerificationProjectProfile } from "../src/index.js";

const check: VerificationCheck = {
  id: createVerificationCheckId(),
  planId: createVerificationPlanId(),
  ordinal: 0,
  stage: "FAST_STATIC",
  requirement: "IF_AVAILABLE",
  spec: { kind: "PROJECT", purpose: "LINT", source: "SYSTEM" },
  status: "PENDING",
  createdAt: 1_700_000_000_000,
};

const profile: VerificationProjectProfile = {
  ecosystems: ["PYTHON"],
  packageManager: { name: "UNKNOWN" },
  tooling: [],
  isMonorepo: false,
};

describe("project check resolver registry", () => {
  it("dispatches supported project ecosystems and conservatively rejects unsupported ones", () => {
    expect(new ProjectCheckResolverRegistry().resolve(check, profile)).toEqual({
      kind: "UNAVAILABLE",
      reason: "UNSUPPORTED_ECOSYSTEM",
    });
  });

  it("does not resolve non-project checks as project commands", () => {
    expect(
      new ProjectCheckResolverRegistry().resolve(
        { ...check, spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" } },
        { ...profile, ecosystems: ["NODE"] },
      ),
    ).toEqual({ kind: "UNAVAILABLE", reason: "UNSUPPORTED_ECOSYSTEM" });
  });
});
