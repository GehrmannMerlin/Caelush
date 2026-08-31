import { createHash } from "node:crypto";
import type { VerificationCommandCandidate, VerificationCandidateInput } from "./contracts.js";

function canonicalCandidateContent(input: VerificationCandidateInput): string {
  return JSON.stringify({
    resolver: input.provenance.resolver,
    ecosystem: input.provenance.ecosystem,
    evidencePath: input.provenance.evidencePath ?? null,
    scriptName: input.provenance.scriptName ?? null,
    executable: input.executable,
    args: [...input.args],
    workdir: input.workdir,
    securityInputs: input.securityInputs.map((item) => ({
      kind: item.kind,
      label: item.label,
      body: item.body,
      workdir: item.workdir,
    })),
  });
}

export function computeVerificationCandidateHash(input: VerificationCandidateInput): string {
  return createHash("sha256").update(canonicalCandidateContent(input), "utf8").digest("hex");
}

export function createVerificationCandidate(
  input: VerificationCandidateInput,
): VerificationCommandCandidate {
  return {
    ...input,
    args: [...input.args],
    securityInputs: input.securityInputs.map((item) => ({ ...item })),
    candidateHash: computeVerificationCandidateHash(input),
  };
}
