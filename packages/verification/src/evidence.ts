import {
  MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES,
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

export type VerificationEvidenceEncodingReasonCode =
  "VERIFICATION_EVIDENCE_ENCODING_ERROR" | "VERIFICATION_EVIDENCE_SIZE_ERROR";

/** A bounded, safe classification for evidence that cannot cross the Protocol boundary. */
export class VerificationEvidenceEncodingError extends Error {
  constructor(readonly reasonCode: VerificationEvidenceEncodingReasonCode) {
    super("Verification evidence could not be encoded within its protocol contract.");
    this.name = "VerificationEvidenceEncodingError";
  }
}

/** Validate evidence at its producer boundary, before a caller reaches a durable store. */
export function parseVerificationEvidence(value: unknown): VerificationEvidence {
  try {
    const parsed = VerificationEvidenceSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    const exceedsDetailsLimit = parsed.error.issues.some(
      (issue) => issue.message === "Evidence details exceed the serialized UTF-8 byte limit",
    );
    throw new VerificationEvidenceEncodingError(
      exceedsDetailsLimit
        ? "VERIFICATION_EVIDENCE_SIZE_ERROR"
        : "VERIFICATION_EVIDENCE_ENCODING_ERROR",
    );
  } catch (error) {
    if (error instanceof VerificationEvidenceEncodingError) throw error;
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
  }
}

export function serializedJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    if (error instanceof VerificationEvidenceEncodingError) throw error;
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
  }
}

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
  return parseVerificationEvidence({
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
): { text: string; source: string } | undefined {
  if (value === undefined) return undefined;
  const redacted = sanitizer.redactText(value);
  return { text: boundUtf8(redacted, maxBytes).text, source: redacted };
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
  const base: JsonObject = {
    label: input.label,
    candidateHash: input.candidateHash,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    totalOutputBytes: input.totalOutputBytes,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(stdout === undefined ? {} : { stdout: "" }),
    ...(stderr === undefined ? {} : { stderr: "" }),
  };
  const detailsFor = (stdoutText: string, stderrText: string): JsonObject => {
    const stdoutOmitted =
      stdout === undefined
        ? 0
        : Buffer.byteLength(stdout.source, "utf8") - Buffer.byteLength(stdoutText, "utf8");
    const stderrOmitted =
      stderr === undefined
        ? 0
        : Buffer.byteLength(stderr.source, "utf8") - Buffer.byteLength(stderrText, "utf8");
    return {
      ...base,
      omittedBytes: input.omittedBytes + stdoutOmitted + stderrOmitted,
      truncated: stdoutOmitted > 0 || stderrOmitted > 0,
      ...(stdout === undefined ? {} : { stdout: stdoutText }),
      ...(stderr === undefined ? {} : { stderr: stderrText }),
    };
  };
  let stdoutText = "";
  let stderrText = "";
  if (stdout !== undefined) {
    stdoutText = fitJsonPrefix(stdout.text, (candidate) => detailsFor(candidate, stderrText));
  }
  if (stderr !== undefined) {
    stderrText = fitJsonPrefix(stderr.text, (candidate) => detailsFor(stdoutText, candidate));
  }
  const details = detailsFor(stdoutText, stderrText);
  return parseVerificationEvidence({
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
    const projectedToolName =
      toolName === undefined || toolName.length === 0 ? "unknown_tool" : toolName;
    const redacted = input.sanitizer.redactText(observation.content);
    const source = boundUtf8(
      redacted,
      Math.min(MAX_TOOL_OBSERVATION_CONTENT_BYTES, remainingBytes),
    ).text;
    const base: JsonObject = {
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
    };
    const detailsFor = (content: string): JsonObject => ({
      ...base,
      content,
      contentOmittedBytes: Buffer.byteLength(redacted, "utf8") - Buffer.byteLength(content, "utf8"),
      contentTruncated: Buffer.byteLength(redacted, "utf8") > Buffer.byteLength(content, "utf8"),
    });
    const content = fitJsonPrefix(source, (candidate) => detailsFor(candidate));
    const details = detailsFor(content);
    remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(content, "utf8"));
    return parseVerificationEvidence({
      id: input.evidenceIdFactory(),
      planId: input.planId,
      checkId: input.checkId,
      kind: "COMMAND" as const,
      summary: `Agent tool observation: ${projectedToolName}`,
      details,
      capturedAt: input.capturedAt,
    });
  });
}

function fitJsonPrefix(source: string, makeValue: (prefix: string) => unknown): string {
  const characters = [...source];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      serializedJsonBytes(makeValue(characters.slice(0, middle).join(""))) <=
      MAX_VERIFICATION_EVIDENCE_DETAILS_BYTES
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("");
}

function boundUtf8(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let text = "";
  for (const character of value) {
    if (Buffer.byteLength(text + character, "utf8") > maxBytes) break;
    text += character;
  }
  return { text, truncated: true };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}
