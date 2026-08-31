import {
  VerificationEvidenceSchema,
  type JsonObject,
  type VerificationEvidence,
} from "@caelush/protocol";
import type {
  VerificationCommandEvidenceInput,
  VerificationDiscoveryEvidenceInput,
  VerificationEvidenceSanitizer,
} from "./contracts.js";

export const MAX_VERIFICATION_OUTPUT_SNIPPET_BYTES = 16 * 1024;

export function createDiscoveryEvidence(
  input: VerificationDiscoveryEvidenceInput,
): VerificationEvidence {
  const details: JsonObject = {
    available: input.available ?? true,
    resolver: input.resolver,
    ecosystem: input.ecosystem,
    ...(input.packageScope === undefined ? {} : { packageScope: input.packageScope }),
    ...(input.evidencePath === undefined ? {} : { evidencePath: input.evidencePath }),
    ...(input.packageManager === undefined ? {} : { packageManager: input.packageManager }),
    ...(input.scriptName === undefined ? {} : { scriptName: input.scriptName }),
    ...(input.candidateHash === undefined ? {} : { candidateHash: input.candidateHash }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.available === false && input.reason !== undefined
      ? { unavailableReason: input.reason }
      : {}),
    ...(input.securityReasonCode === undefined
      ? {}
      : { securityReasonCode: input.securityReasonCode }),
  };
  return VerificationEvidenceSchema.parse({
    id: input.id,
    planId: input.planId,
    checkId: input.checkId,
    kind: "DISCOVERY",
    summary:
      input.available === false
        ? "Project verification command unavailable"
        : "Project verification command discovered",
    details,
    capturedAt: input.capturedAt,
  });
}

function normalizeOutput(
  value: string | undefined,
  sanitizer: VerificationEvidenceSanitizer,
  maxBytes: number,
): { text: string; omittedBytes: number; truncated: boolean } | undefined {
  if (value === undefined) return undefined;
  const redacted = sanitizer.redactText(value);
  return sanitizer.boundText(redacted, maxBytes);
}

export function createCommandEvidence(
  input: VerificationCommandEvidenceInput,
  sanitizer: VerificationEvidenceSanitizer,
): VerificationEvidence {
  const stdout = normalizeOutput(
    input.stdout,
    sanitizer,
    MAX_VERIFICATION_OUTPUT_SNIPPET_BYTES / 2,
  );
  const stderr = normalizeOutput(
    input.stderr,
    sanitizer,
    MAX_VERIFICATION_OUTPUT_SNIPPET_BYTES / 2,
  );
  const details: JsonObject = {
    label: input.label,
    candidateHash: input.candidateHash,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    totalOutputBytes: input.totalOutputBytes,
    omittedBytes: input.omittedBytes + (stdout?.omittedBytes ?? 0) + (stderr?.omittedBytes ?? 0),
    truncated: (stdout?.truncated ?? false) || (stderr?.truncated ?? false),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(stdout === undefined ? {} : { stdout: stdout.text }),
    ...(stderr === undefined ? {} : { stderr: stderr.text }),
  };
  return VerificationEvidenceSchema.parse({
    id: input.id,
    planId: input.planId,
    checkId: input.checkId,
    kind: "COMMAND",
    summary: input.label,
    details,
    capturedAt: input.capturedAt,
  });
}
