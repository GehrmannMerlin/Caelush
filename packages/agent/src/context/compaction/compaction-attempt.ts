import type { SessionId } from "@caelush/protocol";

import { digestJsonValue } from "../../messages/canonical-json.js";
import { createContextArtifactId } from "../item/context-item.js";

export type CompactionFailureFamily =
  | "SUMMARY_UNAVAILABLE"
  | "CANDIDATE_NOT_FIT"
  | "ACTIVATION_FAILED"
  | "PROVIDER_OVERFLOW"
  | "AUTOMATIC_ATTEMPT";

export interface CompactionAttemptIdentity {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly sourceKey: string;
  readonly retryGeneration: number;
  readonly failureFamily: CompactionFailureFamily;
  readonly attemptId: string;
}

/** User-authorized, idempotent retry of a persisted failed compaction attempt. */
export interface ContextCompactionRetryAuthorization {
  readonly previousAttemptId: string;
  readonly requestId: string;
}

export function deriveCompactionAttemptIdentity(input: {
  readonly sessionId: SessionId;
  readonly sourceKey: string;
  readonly retryGeneration: number;
  readonly failureFamily: CompactionFailureFamily;
}): CompactionAttemptIdentity {
  if (typeof input.sessionId !== "string" || input.sessionId.trim().length === 0) {
    throw new TypeError("Compaction attempt Session identity is invalid.");
  }
  if (typeof input.sourceKey !== "string" || input.sourceKey.trim().length === 0) {
    throw new TypeError("Compaction attempt source identity is invalid.");
  }
  if (!Number.isSafeInteger(input.retryGeneration) || input.retryGeneration < 0) {
    throw new RangeError("Compaction retry generation must be a non-negative safe integer.");
  }
  if (
    ![
      "SUMMARY_UNAVAILABLE",
      "CANDIDATE_NOT_FIT",
      "ACTIVATION_FAILED",
      "PROVIDER_OVERFLOW",
      "AUTOMATIC_ATTEMPT",
    ].includes(input.failureFamily)
  ) {
    throw new TypeError("Compaction failure family is unsupported.");
  }
  const identity = {
    version: 1 as const,
    sessionId: input.sessionId,
    sourceKey: input.sourceKey,
    retryGeneration: input.retryGeneration,
    failureFamily: input.failureFamily,
  };
  return Object.freeze({
    ...identity,
    attemptId: `compaction-attempt:v1:${digestJsonValue(identity as never)}`,
  });
}

/** Stable, bounded retry generation derived from a persisted user request id. */
export function deriveCompactionRetryGeneration(requestId: string): number {
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    throw new TypeError(
      "Compaction retry requestId must be a non-empty persisted user request id.",
    );
  }
  // Thirteen hexadecimal digits provide a deterministic 52-bit positive safe integer. Using the
  // request identity makes replay of one submitted retry idempotent while separate submissions
  // produce independent attempt identities without a process-local counter.
  const generation = Number.parseInt(digestJsonValue({ requestId }).slice(0, 13), 16);
  return generation === 0 ? 1 : generation;
}

/** Global deterministic IDs let the artifact claim coordinate retries across Runs in one Session. */
export function createCompactionAttemptArtifactId(input: {
  readonly kind:
    | "context-compaction-attempt"
    | "context-compaction-subcall"
    | "context-compaction-failure-baseline";
  readonly sourceRef: string;
  readonly content: string;
}) {
  return createContextArtifactId(
    `artifact:compaction-attempt:v1:${digestJsonValue(input as never)}`,
  );
}

export type CompactionRetryDecisionReason =
  | "EXPLICIT_RETRY"
  | "SAME_FAILED_SOURCE"
  | "INSUFFICIENT_SOURCE_GROWTH"
  | "SOURCE_GROWTH_THRESHOLD_REACHED";

export interface CompactionRetryEligibility {
  readonly eligible: boolean;
  readonly reason: CompactionRetryDecisionReason;
}

/** Compare every automatic retry with the immutable baseline captured at failure time. */
export function evaluateCompactionRetryEligibility(input: {
  readonly failureBaseline: {
    readonly sourceCoverageDigest: string;
    readonly sourceTokens: number;
    readonly minimumGrowthTokens: number;
    readonly retryGeneration?: number;
  };
  readonly candidateSource: {
    readonly sourceCoverageDigest: string;
    readonly sourceTokens: number;
  };
  readonly authorization?: {
    readonly kind: "EXPLICIT_RETRY";
    readonly requestId: string;
    readonly retryGeneration: number;
  };
}): CompactionRetryEligibility {
  assertNonNegativeSafeInteger(input.failureBaseline.sourceTokens, "failure source tokens");
  assertNonNegativeSafeInteger(input.candidateSource.sourceTokens, "candidate source tokens");
  if (
    !Number.isSafeInteger(input.failureBaseline.minimumGrowthTokens) ||
    input.failureBaseline.minimumGrowthTokens < 1
  ) {
    throw new RangeError("minimumGrowthTokens must be a positive safe integer.");
  }
  const baselineGeneration = input.failureBaseline.retryGeneration ?? 0;
  assertNonNegativeSafeInteger(baselineGeneration, "failure retry generation");
  if (input.authorization !== undefined) {
    if (
      input.authorization.kind !== "EXPLICIT_RETRY" ||
      input.authorization.requestId.trim().length === 0 ||
      !Number.isSafeInteger(input.authorization.retryGeneration) ||
      input.authorization.retryGeneration <= baselineGeneration
    ) {
      throw new TypeError("Explicit compaction retry authorization is invalid.");
    }
    return Object.freeze({ eligible: true, reason: "EXPLICIT_RETRY" });
  }
  if (input.candidateSource.sourceCoverageDigest === input.failureBaseline.sourceCoverageDigest) {
    return Object.freeze({ eligible: false, reason: "SAME_FAILED_SOURCE" });
  }
  const growth = input.candidateSource.sourceTokens - input.failureBaseline.sourceTokens;
  return growth >= input.failureBaseline.minimumGrowthTokens
    ? Object.freeze({ eligible: true, reason: "SOURCE_GROWTH_THRESHOLD_REACHED" })
    : Object.freeze({ eligible: false, reason: "INSUFFICIENT_SOURCE_GROWTH" });
}

/** START without RESULT is an uncertain provider boundary and may never be resent automatically. */
export function mayStartCompactionSubcall(input: {
  readonly hasStart: boolean;
  readonly hasResult: boolean;
}): boolean {
  return !input.hasStart && !input.hasResult;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
