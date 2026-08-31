import {
  createVerificationCheckId,
  createVerificationPlanId,
  type VerificationCheck,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { javaProjectCheckResolver, type VerificationProjectProfile } from "../src/index.js";

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

function profile(tooling: VerificationProjectProfile["tooling"]): VerificationProjectProfile {
  return { ecosystems: ["JAVA"], packageManager: { name: "UNKNOWN" }, tooling, isMonorepo: false };
}

describe("Java project verification resolver", () => {
  it("uses Maven offline test and build commands", () => {
    const tooling = [{ name: "maven", evidencePaths: ["pom.xml"] }];
    const test = javaProjectCheckResolver.resolve(check("TEST"), profile(tooling));
    const build = javaProjectCheckResolver.resolve(check("BUILD"), profile(tooling));
    expect(test.kind === "READY" && [test.candidate.executable, ...test.candidate.args]).toEqual([
      "mvn",
      "-o",
      "test",
    ]);
    expect(build.kind === "READY" && [build.candidate.executable, ...build.candidate.args]).toEqual(
      ["mvn", "-o", "-DskipTests", "package"],
    );
  });

  it("uses Gradle offline test and build commands", () => {
    const tooling = [{ name: "gradle", evidencePaths: ["build.gradle"] }];
    const test = javaProjectCheckResolver.resolve(check("TEST"), profile(tooling));
    const build = javaProjectCheckResolver.resolve(check("BUILD"), profile(tooling));
    expect(test.kind === "READY" && test.candidate.args).toEqual(["--offline", "test"]);
    expect(build.kind === "READY" && build.candidate.args).toEqual(["--offline", "build"]);
  });

  it("is conservative for lint, typecheck, missing, or ambiguous tooling", () => {
    expect(
      javaProjectCheckResolver.resolve(
        check("LINT"),
        profile([{ name: "maven", evidencePaths: ["pom.xml"] }]),
      ),
    ).toEqual({
      kind: "UNAVAILABLE",
      reason: "TOOLING_UNAVAILABLE",
    });
    expect(
      javaProjectCheckResolver.resolve(
        check("TYPECHECK"),
        profile([{ name: "gradle", evidencePaths: ["build.gradle"] }]),
      ),
    ).toEqual({
      kind: "UNAVAILABLE",
      reason: "TOOLING_UNAVAILABLE",
    });
    expect(javaProjectCheckResolver.resolve(check("TEST"), profile([]))).toEqual({
      kind: "UNAVAILABLE",
      reason: "TOOLING_UNAVAILABLE",
    });
    expect(
      javaProjectCheckResolver.resolve(
        check("TEST"),
        profile([
          { name: "maven", evidencePaths: ["pom.xml"] },
          { name: "gradle", evidencePaths: ["build.gradle"] },
        ]),
      ),
    ).toEqual({ kind: "UNAVAILABLE", reason: "TOOLING_UNAVAILABLE" });
  });
});
