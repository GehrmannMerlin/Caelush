import {
  createVerificationCheckId,
  createVerificationPlanId,
  type VerificationCheck,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { rustProjectCheckResolver, type VerificationProjectProfile } from "../src/index.js";

function check(purpose: "LINT" | "TYPECHECK" | "TEST" | "BUILD"): VerificationCheck {
  return {
    id: createVerificationCheckId(),
    planId: createVerificationPlanId(),
    ordinal: 0,
    stage: "FAST_STATIC",
    requirement: "IF_AVAILABLE",
    spec: { kind: "PROJECT", purpose, source: "SYSTEM" },
    status: "PENDING",
    createdAt: 1_700_000_000_000,
  };
}

const profile: VerificationProjectProfile = {
  ecosystems: ["RUST"],
  packageManager: { name: "UNKNOWN" },
  tooling: [{ name: "cargo", evidencePaths: ["Cargo.toml"] }],
  isMonorepo: false,
};

describe("Rust project verification resolver", () => {
  it.each([
    ["TYPECHECK", ["check", "--offline"]],
    ["TEST", ["test", "--offline"]],
    ["BUILD", ["build", "--offline"]],
  ] as const)("resolves %s with Cargo offline", (purpose, args) => {
    const result = rustProjectCheckResolver.resolve(check(purpose), profile);
    expect(result.kind).toBe("READY");
    if (result.kind !== "READY") return;
    expect(result.candidate.executable).toBe("cargo");
    expect(result.candidate.args).toEqual(args);
    expect(result.candidate.provenance.evidencePath).toBe("Cargo.toml");
  });

  it("does not guess clippy for lint", () => {
    expect(rustProjectCheckResolver.resolve(check("LINT"), profile)).toEqual({
      kind: "UNAVAILABLE",
      reason: "TOOLING_UNAVAILABLE",
    });
  });
});
