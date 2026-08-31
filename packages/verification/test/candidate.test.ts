import { createVerificationCheckId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  computeVerificationCandidateHash,
  createVerificationCandidate,
  type VerificationCandidateInput,
} from "../src/index.js";

function input(overrides: Partial<VerificationCandidateInput> = {}): VerificationCandidateInput {
  return {
    checkId: createVerificationCheckId(),
    executable: "pnpm",
    args: ["run", "test"],
    workdir: "packages/app",
    provenance: {
      ecosystem: "NODE",
      resolver: "NODE_PACKAGE_SCRIPT@phase-11b.v1",
      evidencePath: "package.json",
      scriptName: "test",
    },
    securityInputs: [
      { kind: "SCRIPT", label: "pretest", body: "echo pre", workdir: "packages/app" },
      { kind: "SCRIPT", label: "test", body: "vitest", workdir: "packages/app" },
      { kind: "SCRIPT", label: "posttest", body: "echo post", workdir: "packages/app" },
    ],
    ...overrides,
  };
}

describe("verification command candidates", () => {
  it("hashes the logical candidate deterministically", () => {
    const first = input();
    const second = { ...first, args: [...first.args], securityInputs: [...first.securityInputs] };
    expect(computeVerificationCandidateHash(first)).toBe(computeVerificationCandidateHash(second));
    expect(createVerificationCandidate(first).candidateHash).toBe(
      createVerificationCandidate(second).candidateHash,
    );
    expect(computeVerificationCandidateHash({ ...first, workdir: "." })).not.toBe(
      computeVerificationCandidateHash(first),
    );
  });

  it("keeps the complete ordered lifecycle bodies only on the ephemeral candidate", () => {
    const candidate = createVerificationCandidate(input());
    expect(candidate.securityInputs.map((item) => item.label)).toEqual([
      "pretest",
      "test",
      "posttest",
    ]);
    expect(candidate.candidateHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
