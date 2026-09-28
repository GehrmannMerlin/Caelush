import {
  VerificationEvidenceSchema,
  type VerificationCheck,
  type JsonObject,
  type VerificationEvidence,
  type VerificationPlan,
} from "@caelush/protocol";
import type {
  VerificationCommandEvidenceInput,
  VerificationDiscoveryEvidenceInput,
  VerificationToolObservationInput,
  VerificationEvidenceSanitizer,
} from "./contracts.js";

export const MAX_VERIFICATION_OUTPUT_SNIPPET_BYTES = 16 * 1024;
export const MAX_TOOL_OBSERVATION_EVIDENCE_COUNT = 32;
export const MAX_TOOL_OBSERVATION_CONTENT_BYTES = 8 * 1024;
export const MAX_TOOL_OBSERVATION_TOTAL_CONTENT_BYTES = 24 * 1024;

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

/**
 * Project durable Agent Tool observations into bounded verification evidence.
 *
 * This is deliberately not a second Tool execution path. It reads already-settled observations,
 * copies only safe scalar facts, redacts and bounds the observed text, and leaves invocation
 * arguments out of the review bundle entirely.
 */
export function createToolObservationEvidence(input: {
  readonly planId: VerificationPlan["id"];
  readonly checkId: VerificationCheck["id"];
  readonly candidateHash: string;
  readonly capturedAt: VerificationEvidence["capturedAt"];
  readonly evidenceIdFactory: () => VerificationEvidence["id"];
  readonly observations: readonly VerificationToolObservationInput[];
  readonly sanitizer: VerificationEvidenceSanitizer;
}): readonly VerificationEvidence[] {
  const ordered = [...input.observations]
    .sort(
      (left, right) =>
        left.observation.createdAt - right.observation.createdAt ||
        left.observation.id.localeCompare(right.observation.id),
    )
    .slice(-MAX_TOOL_OBSERVATION_EVIDENCE_COUNT);
  let remainingBytes = MAX_TOOL_OBSERVATION_TOTAL_CONTENT_BYTES;
  return ordered.map(({ observation, toolName, invocationStatus }) => {
    const projectedToolName = toolName === undefined || toolName.length === 0 ? "unknown_tool" : toolName;
    const redacted = input.sanitizer.redactText(observation.content);
    const bounded = input.sanitizer.boundText(
      redacted,
      Math.min(MAX_TOOL_OBSERVATION_CONTENT_BYTES, remainingBytes),
    );
    remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(bounded.text, "utf8"));

    const details: JsonObject = {
      source: "AGENT_TOOL_OBSERVATION",
      candidateHash: input.candidateHash,
      observationId: observation.id,
      stepId: observation.stepId,
      toolInvocationId: observation.toolInvocationId,
      toolName: projectedToolName,
      observationCreatedAt: observation.createdAt,
      isError: observation.isError,
      ...(invocationStatus === undefined ? {} : { invocationStatus }),
      ...(observation.details?.status === "RUNNING" || observation.details?.status === "EXITED"
        ? { status: observation.details.status }
        : {}),
      ...(isSafeInteger(observation.details?.exitCode)
        ? { exitCode: observation.details.exitCode as number }
        : {}),
      ...(isSafeNonNegativeInteger(observation.details?.totalOutputBytes)
        ? { totalOutputBytes: observation.details.totalOutputBytes as number }
        : {}),
      ...(isSafeNonNegativeInteger(observation.details?.omittedBytes)
        ? { omittedBytes: observation.details.omittedBytes as number }
        : {}),
      content: bounded.text,
      contentOmittedBytes: bounded.omittedBytes,
      contentTruncated: bounded.truncated,
    };
    return {
      id: input.evidenceIdFactory(),
      planId: input.planId,
      checkId: input.checkId,
      kind: "COMMAND" as const,
      summary: `Agent tool observation: ${projectedToolName}`,
      details,
      capturedAt: input.capturedAt,
    } satisfies VerificationEvidence;
  });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}
