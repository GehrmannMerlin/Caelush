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
  spec: { kind: "PROJECT", purpose: "TEST", source: "SYSTEM" },
  status: "PENDING",
  createdAt: 1_700_000_000_000,
};

const profile = (ecosystem: string): VerificationProjectProfile => ({
  ecosystems: [ecosystem],
  packageManager: { name: "UNKNOWN" },
  tooling: [],
  isMonorepo: false,
});

describe("unsupported project verification ecosystems", () => {
  it.each(["PYTHON", "GO"])("does not guess commands for %s", (ecosystem) => {
    expect(new ProjectCheckResolverRegistry().resolve(check, profile(ecosystem))).toEqual({
      kind: "UNAVAILABLE",
      reason: "ECOSYSTEM_UNSUPPORTED",
    });
  });
});
