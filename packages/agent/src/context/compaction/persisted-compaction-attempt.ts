import { createHash } from "node:crypto";

import type { ModelRef } from "@caelush/ai";
import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import type {
  ContextArtifact,
  ContextArtifactCreateInput,
  ContextArtifactStorePort,
} from "../artifacts/context-artifact.js";
import { digestJsonValue } from "../../messages/canonical-json.js";
import { createSemanticCheckpointDraft } from "./semantic-checkpoint-draft.js";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  type ContextSummarizationResult,
} from "./context-compaction-contracts.js";
import {
  createCompactionAttemptArtifactId,
  deriveCompactionRetryGeneration,
  deriveCompactionAttemptIdentity,
  evaluateCompactionRetryEligibility,
  type ContextCompactionRetryAuthorization,
} from "./compaction-attempt.js";

export const COMPACTION_RETRY_MINIMUM_SOURCE_GROWTH_TOKENS = 8_192;
const ATTEMPT_KIND = "context-compaction-attempt";
const SUBCALL_KIND = "context-compaction-subcall";
const SUMMARY_KIND = "context-compaction-summary";
const FAILURE_KIND = "context-compaction-failure-baseline";
export const CONTEXT_SUMMARY_COST_VERSION = "CONTEXT_SUMMARY_UTF8_V1" as const;
const MAX_ATTEMPT_SCAN_PAGES = 20;
export const MAX_PERSISTED_COMPACTION_SUBCALLS = 16;

type AttemptArtifactRecord =
  | {
      readonly version: 1;
      readonly recordType: "ATTEMPT";
      readonly attemptId: string;
      readonly state: "START" | "RESULT";
      readonly retryGeneration?: number;
      readonly sourceCoverageDigest: string;
      readonly sourceTokens: number;
      readonly outcome?: "COMPACTED" | "FAILED";
      readonly failureFamily?: string;
      readonly checkpointId?: string;
      readonly activationOperationId?: string;
    }
  | {
      readonly version: 1;
      readonly recordType: "SUBCALL";
      readonly attemptId: string;
      readonly callOrdinal: number;
      readonly state: "START" | "RESULT";
      readonly requestFingerprint: string;
      readonly outcome?: "ACCEPTED" | "FALLBACK_REQUIRED";
    }
  | {
      readonly version: 1;
      readonly recordType: "FAILURE_BASELINE";
      readonly attemptId: string;
      readonly sourceCoverageDigest: string;
      readonly sourceTokens: number;
      readonly minimumGrowthTokens: number;
      readonly retryGeneration: number;
      readonly failureFamily: string;
    };

export interface PersistedCompactionAttempt {
  readonly attemptId: string;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceCoverageDigest: string;
  readonly sourceTokens: number;
  readonly retryGeneration: number;
}

export type BeginPersistedCompactionAttemptResult =
  | { readonly kind: "CLAIMED"; readonly attempt: PersistedCompactionAttempt }
  | {
      readonly kind: "BLOCKED";
      readonly reason:
        "SAME_FAILED_SOURCE" | "INSUFFICIENT_SOURCE_GROWTH" | "ATTEMPT_ALREADY_CLAIMED";
    };

export type BeginPersistedCompactionSubcallResult =
  | { readonly kind: "CLAIMED" }
  | { readonly kind: "BLOCKED"; readonly reason: "SUBCALL_ALREADY_STARTED" };

export type BeginNextPersistedCompactionSubcallResult =
  | { readonly kind: "CLAIMED"; readonly callOrdinal: number }
  | {
      readonly kind: "BLOCKED";
      readonly reason: "SUBCALL_ALREADY_STARTED";
      readonly callOrdinal?: number;
      readonly requestFingerprint?: string;
    };

/** Durable START claim, fixed failure-baseline check, and replay-safe attempt identity. */
export async function beginPersistedCompactionAttempt(input: {
  readonly store: ContextArtifactStorePort;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceCoverageDigest: string;
  readonly sourceTokens: number;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
  readonly authorization?: ContextCompactionRetryAuthorization;
}): Promise<BeginPersistedCompactionAttemptResult> {
  assertSource(input.sourceCoverageDigest, input.sourceTokens);
  const failureSourceRef = failureBaselineSourceRef(input.sessionId);
  const previousFailure =
    input.authorization === undefined
      ? await latestFailureBaseline(input.store, failureSourceRef)
      : await failureBaselineForAttempt(
          input.store,
          failureSourceRef,
          input.authorization.previousAttemptId,
        );
  let retryGeneration = 0;
  const priorLocalResultReusable =
    previousFailure !== undefined &&
    previousFailure.sourceCoverageDigest === input.sourceCoverageDigest &&
    previousFailure.sourceTokens === input.sourceTokens &&
    isLocallyReplannableFailure(previousFailure.failureFamily) &&
    ((await hasReusableAcceptedSummary(input.store, previousFailure.attemptId)) ||
      !(await hasPersistedCompactionSubcall(input.store, previousFailure.attemptId)));
  if (previousFailure !== undefined && !priorLocalResultReusable) {
    const explicitRetry =
      input.authorization === undefined
        ? undefined
        : {
            kind: "EXPLICIT_RETRY" as const,
            requestId: input.authorization.requestId,
            retryGeneration: deriveCompactionRetryGeneration(input.authorization.requestId),
          };
    const eligibility = evaluateCompactionRetryEligibility({
      failureBaseline: {
        sourceCoverageDigest: previousFailure.sourceCoverageDigest,
        sourceTokens: previousFailure.sourceTokens,
        minimumGrowthTokens: previousFailure.minimumGrowthTokens,
        retryGeneration: previousFailure.retryGeneration,
      },
      candidateSource: {
        sourceCoverageDigest: input.sourceCoverageDigest,
        sourceTokens: input.sourceTokens,
      },
      ...(explicitRetry === undefined ? {} : { authorization: explicitRetry }),
    });
    if (!eligibility.eligible) {
      return Object.freeze({
        kind: "BLOCKED",
        reason:
          eligibility.reason === "SAME_FAILED_SOURCE"
            ? "SAME_FAILED_SOURCE"
            : "INSUFFICIENT_SOURCE_GROWTH",
      });
    }
    retryGeneration = explicitRetry?.retryGeneration ?? 0;
  } else if (input.authorization !== undefined) {
    throw new TypeError(
      "Explicit retry does not reference a failed compaction attempt in this Session.",
    );
  }

  const identity = deriveCompactionAttemptIdentity({
    sessionId: input.sessionId,
    sourceKey: input.sourceCoverageDigest,
    retryGeneration,
    failureFamily: "AUTOMATIC_ATTEMPT",
  });
  const existing = await listAttemptRecords(input.store, identity.attemptId);
  if (existing.length > 0) {
    const subcalls = existing.filter((record) => record.recordType === "SUBCALL");
    const hasCommitted = existing.some(
      (record) =>
        record.recordType === "ATTEMPT" &&
        record.state === "RESULT" &&
        record.outcome === "COMPACTED",
    );
    const terminalFailure = existing.find(
      (record) =>
        record.recordType === "ATTEMPT" && record.state === "RESULT" && record.outcome === "FAILED",
    );
    const localTerminalFailure =
      terminalFailure?.recordType === "ATTEMPT" &&
      isLocallyReplannableFailure(terminalFailure.failureFamily ?? "");
    const untouchedAttempt =
      terminalFailure === undefined &&
      previousFailure === undefined &&
      input.authorization === undefined;
    if (subcalls.length === 0 && !hasCommitted && (localTerminalFailure || untouchedAttempt)) {
      return Object.freeze({
        kind: "CLAIMED",
        attempt: Object.freeze({
          attemptId: identity.attemptId,
          runId: input.runId,
          sessionId: input.sessionId,
          sourceCoverageDigest: input.sourceCoverageDigest,
          sourceTokens: input.sourceTokens,
          retryGeneration,
        }),
      });
    }
    if (await hasReusableAcceptedSummary(input.store, identity.attemptId)) {
      const typedSubcalls = subcalls.filter(
        (record): record is Extract<AttemptArtifactRecord, { recordType: "SUBCALL" }> =>
          record.recordType === "SUBCALL",
      );
      const hasUnknownBoundary = await Promise.all(
        typedSubcalls
          .filter((record) => record.state === "START" && !hasPersistedResult(subcalls, record))
          .map((record) =>
            hasPersistedSummaryForFingerprint(input.store, record.requestFingerprint),
          ),
      ).then((settled) => settled.some((hasSummary) => !hasSummary));
      if (!hasUnknownBoundary && !hasCommitted) {
        return Object.freeze({
          kind: "CLAIMED",
          attempt: Object.freeze({
            attemptId: identity.attemptId,
            runId: input.runId,
            sessionId: input.sessionId,
            sourceCoverageDigest: input.sourceCoverageDigest,
            sourceTokens: input.sourceTokens,
            retryGeneration,
          }),
        });
      }
    }
    return Object.freeze({ kind: "BLOCKED", reason: "ATTEMPT_ALREADY_CLAIMED" });
  }
  const start: AttemptArtifactRecord = Object.freeze({
    version: 1,
    recordType: "ATTEMPT",
    attemptId: identity.attemptId,
    state: "START",
    retryGeneration,
    sourceCoverageDigest: input.sourceCoverageDigest,
    sourceTokens: input.sourceTokens,
  });
  const claimed = await input.store.claim(
    artifactInput({
      runId: input.runId,
      kind: ATTEMPT_KIND,
      sourceRef: identity.attemptId,
      record: start,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
    }),
  );
  if (claimed.kind !== "CREATED") {
    return Object.freeze({ kind: "BLOCKED", reason: "ATTEMPT_ALREADY_CLAIMED" });
  }
  return Object.freeze({
    kind: "CLAIMED",
    attempt: Object.freeze({
      attemptId: identity.attemptId,
      runId: input.runId,
      sessionId: input.sessionId,
      sourceCoverageDigest: input.sourceCoverageDigest,
      sourceTokens: input.sourceTokens,
      retryGeneration,
    }),
  });
}

/** A RESULT closes the attempt; failures also freeze the token/frontier baseline for future retries. */
export async function finishPersistedCompactionAttempt(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
  readonly outcome: "COMPACTED" | "FAILED";
  readonly failureFamily?: string;
}): Promise<void> {
  if (input.outcome === "FAILED") {
    const records = await listArtifacts(input.store, ATTEMPT_KIND, input.attempt.attemptId);
    const alreadyCommitted = records.some((artifact) => {
      const record = parseAttemptRecord(artifact.content);
      return (
        record.recordType === "ATTEMPT" &&
        record.state === "RESULT" &&
        record.outcome === "COMPACTED"
      );
    });
    // The authoritative V3 transaction may have committed before its read-back failed. Its
    // COMPACTED terminal fact wins; never append a contradictory FAILED result afterward.
    if (alreadyCommitted) return;
  }
  await input.store.claim(
    createPersistedCompactionAttemptTerminalArtifact({
      attempt: input.attempt,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
      outcome: input.outcome,
      ...(input.failureFamily === undefined ? {} : { failureFamily: input.failureFamily }),
    }),
  );
  if (
    input.outcome === "COMPACTED" ||
    (input.failureFamily !== undefined && isLocallyReplannableFailure(input.failureFamily))
  )
    return;
  await recordPersistedCompactionFailureBaseline({
    store: input.store,
    attempt: input.attempt,
    createdSequence: input.createdSequence,
    createdAt: input.createdAt,
    failureFamily: input.failureFamily ?? "CANDIDATE_NOT_FIT",
  });
}

/**
 * Freeze the source-growth baseline even when a provider call has an unknown outcome.
 * The START claim remains open in that case, so its subcalls are never resent; the separate
 * baseline prevents a changed source digest from turning every tiny message into a new attempt.
 */
export async function recordPersistedCompactionFailureBaseline(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
  readonly failureFamily: string;
}): Promise<void> {
  const failure: AttemptArtifactRecord = Object.freeze({
    version: 1,
    recordType: "FAILURE_BASELINE",
    attemptId: input.attempt.attemptId,
    sourceCoverageDigest: input.attempt.sourceCoverageDigest,
    sourceTokens: input.attempt.sourceTokens,
    minimumGrowthTokens: COMPACTION_RETRY_MINIMUM_SOURCE_GROWTH_TOKENS,
    // Automatic growth retries advance from generation zero. An explicit request id is itself
    // the stable generation identity, so a later automatic baseline must not compare unlike
    // generation spaces.
    retryGeneration: 0,
    failureFamily: input.failureFamily,
  });
  await input.store.claim(
    artifactInput({
      runId: input.attempt.runId,
      kind: FAILURE_KIND,
      sourceRef: failureBaselineSourceRef(input.attempt.sessionId),
      record: failure,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
    }),
  );
}

/** Claim one bounded summary Gateway call before any Provider I/O may start. */
export async function beginPersistedCompactionSubcall(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  /** Contiguous attempt-local call ordinal, starting at zero. */
  readonly callOrdinal: number;
  readonly requestFingerprint: string;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}): Promise<BeginPersistedCompactionSubcallResult> {
  assertSubcallIdentity(input.callOrdinal, input.requestFingerprint);
  const sourceRef = subcallSourceRef(input.attempt.attemptId, input.callOrdinal);
  const existing = await listArtifacts(input.store, SUBCALL_KIND, sourceRef);
  if (existing.length > 0) {
    const record = parseAttemptRecord(existing[0]!.content);
    if (
      record.recordType !== "SUBCALL" ||
      record.attemptId !== input.attempt.attemptId ||
      record.callOrdinal !== input.callOrdinal ||
      record.requestFingerprint !== input.requestFingerprint
    ) {
      throw new TypeError("Persisted compaction subcall identity conflicts with its claim.");
    }
    return Object.freeze({ kind: "BLOCKED", reason: "SUBCALL_ALREADY_STARTED" });
  }
  const start: AttemptArtifactRecord = Object.freeze({
    version: 1,
    recordType: "SUBCALL",
    attemptId: input.attempt.attemptId,
    callOrdinal: input.callOrdinal,
    state: "START",
    requestFingerprint: input.requestFingerprint,
  });
  const claim = await input.store.claim(
    artifactInput({
      runId: input.attempt.runId,
      kind: SUBCALL_KIND,
      sourceRef,
      record: start,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
    }),
  );
  return claim.kind === "CREATED"
    ? Object.freeze({ kind: "CLAIMED" })
    : Object.freeze({ kind: "BLOCKED", reason: "SUBCALL_ALREADY_STARTED" });
}

/** Use a new bounded ordinal only after every prior provider boundary is known. */
export async function beginNextPersistedCompactionSubcall(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  readonly requestFingerprint: string;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}): Promise<BeginNextPersistedCompactionSubcallResult> {
  assertFingerprint(input.requestFingerprint, "requestFingerprint");
  const recordsByOrdinal = new Map<number, readonly AttemptArtifactRecord[]>();
  for (let callOrdinal = 0; callOrdinal < MAX_PERSISTED_COMPACTION_SUBCALLS; callOrdinal += 1) {
    const sourceRef = subcallSourceRef(input.attempt.attemptId, callOrdinal);
    const records = (await listArtifacts(input.store, SUBCALL_KIND, sourceRef)).map((artifact) =>
      parseAttemptRecord(artifact.content),
    );
    if (
      records.some(
        (record) =>
          record.recordType !== "SUBCALL" ||
          record.attemptId !== input.attempt.attemptId ||
          record.callOrdinal !== callOrdinal,
      )
    ) {
      throw new TypeError("Persisted compaction subcall ordinal is inconsistent.");
    }
    const start = records.find(
      (record): record is Extract<AttemptArtifactRecord, { recordType: "SUBCALL" }> =>
        record.recordType === "SUBCALL" && record.state === "START",
    );
    const hasStart = start !== undefined;
    const hasResult = records.some(
      (record) => record.recordType === "SUBCALL" && record.state === "RESULT",
    );
    if (hasStart && !hasResult) {
      return Object.freeze({
        kind: "BLOCKED",
        reason: "SUBCALL_ALREADY_STARTED",
        callOrdinal,
        requestFingerprint: start.requestFingerprint,
      });
    }
    if (records.length > 0 && !hasStart) {
      throw new TypeError("Persisted compaction subcall result has no START claim.");
    }
    recordsByOrdinal.set(callOrdinal, records);
  }

  for (let callOrdinal = 0; callOrdinal < MAX_PERSISTED_COMPACTION_SUBCALLS; callOrdinal += 1) {
    const records = recordsByOrdinal.get(callOrdinal) ?? [];
    if (records.some((record) => record.recordType === "SUBCALL" && record.state === "RESULT")) {
      if (
        records.some(
          (record) =>
            record.recordType === "SUBCALL" &&
            record.requestFingerprint === input.requestFingerprint,
        )
      ) {
        return Object.freeze({
          kind: "BLOCKED",
          reason: "SUBCALL_ALREADY_STARTED",
          callOrdinal,
          requestFingerprint: input.requestFingerprint,
        });
      }
      continue;
    }
    const claim = await beginPersistedCompactionSubcall({
      ...input,
      callOrdinal,
    });
    if (claim.kind === "CLAIMED") return Object.freeze({ kind: "CLAIMED", callOrdinal });
    return claim;
  }
  return Object.freeze({ kind: "BLOCKED", reason: "SUBCALL_ALREADY_STARTED" });
}

/** Record a result without persisting semantic summary text or a provider exception. */
export async function finishPersistedCompactionSubcall(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  readonly callOrdinal: number;
  readonly requestFingerprint: string;
  readonly outcome: "ACCEPTED" | "FALLBACK_REQUIRED";
  readonly acceptedResult?: ContextSummarizationResult;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}): Promise<void> {
  assertSubcallIdentity(input.callOrdinal, input.requestFingerprint);
  if (input.outcome === "ACCEPTED") {
    if (input.acceptedResult === undefined) {
      throw new TypeError("Accepted compaction summary is missing its bounded result.");
    }
    await persistAcceptedSummaryArtifact({
      store: input.store,
      attempt: input.attempt,
      requestFingerprint: input.requestFingerprint,
      acceptedResult: input.acceptedResult,
      createdAt: input.createdAt,
    });
  } else if (input.acceptedResult !== undefined) {
    throw new TypeError("Fallback compaction result cannot carry a reusable summary.");
  }
  const sourceRef = subcallSourceRef(input.attempt.attemptId, input.callOrdinal);
  const existing = await listArtifacts(input.store, SUBCALL_KIND, sourceRef);
  const records = existing.map((artifact) => parseAttemptRecord(artifact.content));
  for (const record of records) {
    if (
      record.recordType !== "SUBCALL" ||
      record.attemptId !== input.attempt.attemptId ||
      record.callOrdinal !== input.callOrdinal ||
      record.requestFingerprint !== input.requestFingerprint
    ) {
      throw new TypeError("Persisted compaction subcall result conflicts with its START.");
    }
    if (record.state === "RESULT") {
      if (record.outcome !== input.outcome) {
        throw new TypeError("Persisted compaction subcall has a conflicting RESULT.");
      }
      return;
    }
  }
  if (!records.some((record) => record.recordType === "SUBCALL" && record.state === "START")) {
    throw new TypeError("Compaction subcall RESULT has no durable START claim.");
  }
  const result: AttemptArtifactRecord = Object.freeze({
    version: 1,
    recordType: "SUBCALL",
    attemptId: input.attempt.attemptId,
    callOrdinal: input.callOrdinal,
    state: "RESULT",
    requestFingerprint: input.requestFingerprint,
    outcome: input.outcome,
  });
  await input.store.claim(
    artifactInput({
      runId: input.attempt.runId,
      kind: SUBCALL_KIND,
      sourceRef,
      record: result,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
    }),
  );
}

/** Read only a fully validated semantic draft whose exact request identity is known. */
export async function readPersistedAcceptedSummary(input: {
  readonly store: ContextArtifactStorePort;
  readonly requestFingerprint: string;
  readonly modelRef: ModelRef;
  readonly sourceDigest: string;
}): Promise<ContextSummarizationResult | undefined> {
  assertFingerprint(input.requestFingerprint, "requestFingerprint");
  const cached = await readValidatedAcceptedSummaryArtifact(input.store, input.requestFingerprint);
  if (cached === undefined) return undefined;
  const record = cached.record;
  if (
    record.sourceDigest !== input.sourceDigest ||
    record.modelRef.provider !== input.modelRef.provider ||
    record.modelRef.model !== input.modelRef.model ||
    record.promptVersion !== CONTEXT_SUMMARY_PROMPT_VERSION ||
    record.costVersion !== CONTEXT_SUMMARY_COST_VERSION
  ) {
    throw new TypeError("Persisted compaction summary does not match its source or model.");
  }
  return Object.freeze({
    semantic: record.semantic,
    modelRef: record.modelRef,
    finishReason: "STOP",
    summaryPromptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
    sourceDigest: record.sourceDigest,
    semanticDigest: record.semanticDigest,
  });
}

/** A successful provider result is reusable only when the complete draft artifact exists. */
export async function hasReusableAcceptedSummary(
  store: ContextArtifactStorePort,
  attemptId: string,
): Promise<boolean> {
  const records = await listAttemptRecords(store, attemptId);
  const subcalls = records.filter(
    (record): record is Extract<AttemptArtifactRecord, { recordType: "SUBCALL" }> =>
      record.recordType === "SUBCALL",
  );
  for (const record of subcalls) {
    try {
      if (await hasPersistedSummaryForFingerprint(store, record.requestFingerprint)) return true;
    } catch {
      // Malformed or mismatched cached output is never evidence that an unknown call is reusable.
    }
  }
  return false;
}

/** Whether this attempt crossed a summary provider boundary, settled or otherwise. */
export async function hasPersistedCompactionSubcall(
  store: ContextArtifactStorePort,
  attemptId: string,
): Promise<boolean> {
  return (await listAttemptRecords(store, attemptId)).some(
    (record) => record.recordType === "SUBCALL",
  );
}

async function hasPersistedSummaryForFingerprint(
  store: ContextArtifactStorePort,
  requestFingerprint: string,
): Promise<boolean> {
  return (await readValidatedAcceptedSummaryArtifact(store, requestFingerprint)) !== undefined;
}

async function readValidatedAcceptedSummaryArtifact(
  store: ContextArtifactStorePort,
  requestFingerprint: string,
): Promise<
  | {
      readonly artifact: ContextArtifact;
      readonly record: ReturnType<typeof parseAcceptedSummaryArtifact>;
    }
  | undefined
> {
  const sourceRef = summarySourceRef(requestFingerprint);
  const page = await store.listBySourceRef({ kind: SUMMARY_KIND, sourceRef, limit: 2 });
  if (page.nextCursor !== undefined || page.records.length > 1) {
    throw new TypeError("Persisted compaction summary identity is ambiguous.");
  }
  const metadata = page.records[0];
  if (metadata === undefined) return undefined;
  const artifact = await store.readInternal(metadata.artifactId);
  if (
    artifact === undefined ||
    artifact.kind !== SUMMARY_KIND ||
    artifact.sourceRef !== sourceRef ||
    artifact.sensitivity !== "INTERNAL" ||
    artifact.mimeType !== "application/json" ||
    String(artifact.artifactId) !==
      String(
        createCompactionAttemptArtifactId({
          kind: SUMMARY_KIND,
          sourceRef,
          content: artifact.content,
        }),
      )
  ) {
    throw new TypeError("Persisted compaction summary artifact failed its identity check.");
  }
  const byteLength = new TextEncoder().encode(artifact.content).byteLength;
  const contentHash = createHash("sha256").update(artifact.content, "utf8").digest("hex");
  if (
    byteLength > 32_768 ||
    artifact.byteLength !== byteLength ||
    artifact.contentHash !== contentHash
  ) {
    throw new TypeError("Persisted compaction summary content hash or byte length is invalid.");
  }
  const record = parseAcceptedSummaryArtifact(artifact.content);
  if (record.requestFingerprint !== requestFingerprint) {
    throw new TypeError("Persisted compaction summary request fingerprint does not match.");
  }
  return Object.freeze({ artifact, record });
}

function hasPersistedResult(
  subcalls: readonly Extract<AttemptArtifactRecord, { recordType: "SUBCALL" }>[],
  start: Extract<AttemptArtifactRecord, { recordType: "SUBCALL" }>,
): boolean {
  return subcalls.some(
    (result) =>
      result.state === "RESULT" &&
      result.callOrdinal === start.callOrdinal &&
      result.requestFingerprint === start.requestFingerprint,
  );
}

export function createPersistedCompactionAttemptTerminalArtifact(input: {
  readonly attempt: PersistedCompactionAttempt;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
  readonly outcome: "COMPACTED" | "FAILED";
  readonly failureFamily?: string;
  readonly checkpointId?: string;
  readonly activationOperationId?: string;
}): ContextArtifactCreateInput {
  if (
    input.outcome === "COMPACTED" &&
    (input.checkpointId === undefined || input.activationOperationId === undefined)
  ) {
    throw new TypeError("A successful compaction attempt must reference its activation.");
  }
  if (
    input.failureFamily !== undefined &&
    (input.outcome !== "FAILED" ||
      input.failureFamily.trim().length === 0 ||
      input.failureFamily.length > 128)
  ) {
    throw new TypeError("A failed compaction attempt has an invalid failure family.");
  }
  const result: AttemptArtifactRecord = Object.freeze({
    version: 1,
    recordType: "ATTEMPT",
    attemptId: input.attempt.attemptId,
    state: "RESULT",
    sourceCoverageDigest: input.attempt.sourceCoverageDigest,
    sourceTokens: input.attempt.sourceTokens,
    retryGeneration: input.attempt.retryGeneration,
    outcome: input.outcome,
    ...(input.failureFamily === undefined ? {} : { failureFamily: input.failureFamily }),
    ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
    ...(input.activationOperationId === undefined
      ? {}
      : { activationOperationId: input.activationOperationId }),
  });
  return artifactInput({
    runId: input.attempt.runId,
    kind: ATTEMPT_KIND,
    sourceRef: input.attempt.attemptId,
    record: result,
    createdSequence: input.createdSequence,
    createdAt: input.createdAt,
  });
}

function artifactInput(input: {
  readonly runId: RunId;
  readonly kind:
    typeof ATTEMPT_KIND | typeof SUBCALL_KIND | typeof SUMMARY_KIND | typeof FAILURE_KIND;
  readonly sourceRef: string;
  readonly record: AttemptArtifactRecord;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}): ContextArtifactCreateInput {
  const content = JSON.stringify(input.record);
  return Object.freeze({
    artifactId: createCompactionAttemptArtifactId({
      kind: input.kind,
      sourceRef: input.sourceRef,
      content,
    }),
    runId: input.runId,
    kind: input.kind,
    sourceRef: input.sourceRef,
    content,
    mimeType: "application/json",
    sensitivity: "INTERNAL",
    // Operation facts are Session scoped, not positions in the owner Run's conversation.
    createdSequence: 1,
    createdAt: input.createdAt,
  });
}

async function persistAcceptedSummaryArtifact(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  readonly requestFingerprint: string;
  readonly acceptedResult: ContextSummarizationResult;
  readonly createdAt: TimestampMs;
}): Promise<void> {
  const semantic = createSemanticCheckpointDraft(input.acceptedResult.semantic);
  const semanticDigest = digestJsonValue(JSON.parse(JSON.stringify(semantic)) as never);
  if (
    input.acceptedResult.finishReason !== "STOP" ||
    input.acceptedResult.summaryPromptVersion !== CONTEXT_SUMMARY_PROMPT_VERSION ||
    input.acceptedResult.semanticDigest !== semanticDigest ||
    input.acceptedResult.modelRef.provider.trim().length === 0 ||
    input.acceptedResult.modelRef.provider.length > 256 ||
    input.acceptedResult.modelRef.model.trim().length === 0 ||
    input.acceptedResult.modelRef.model.length > 256 ||
    !/^[0-9a-f]{64}$/.test(input.acceptedResult.sourceDigest)
  ) {
    throw new TypeError("Accepted compaction summary failed its durable validation.");
  }
  const record = {
    version: 1,
    requestFingerprint: input.requestFingerprint,
    promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
    costVersion: CONTEXT_SUMMARY_COST_VERSION,
    modelRef: {
      provider: input.acceptedResult.modelRef.provider,
      model: input.acceptedResult.modelRef.model,
    },
    finishReason: "STOP",
    sourceDigest: input.acceptedResult.sourceDigest,
    semanticDigest,
    semantic,
  } as const;
  const content = JSON.stringify(record);
  if (new TextEncoder().encode(content).byteLength > 32_768) {
    throw new TypeError("Accepted compaction summary artifact exceeds its byte bound.");
  }
  const result = await input.store.claim({
    artifactId: createCompactionAttemptArtifactId({
      kind: SUMMARY_KIND,
      sourceRef: summarySourceRef(input.requestFingerprint),
      content,
    }),
    runId: input.attempt.runId,
    kind: SUMMARY_KIND,
    sourceRef: summarySourceRef(input.requestFingerprint),
    content,
    mimeType: "application/json",
    sensitivity: "INTERNAL",
    createdSequence: 1,
    createdAt: input.createdAt,
  });
  if (result.artifact.content !== content) {
    throw new TypeError("Persisted compaction summary fingerprint has conflicting content.");
  }
}

function parseAcceptedSummaryArtifact(value: string): {
  readonly requestFingerprint: string;
  readonly promptVersion: number;
  readonly costVersion: string;
  readonly modelRef: ModelRef;
  readonly sourceDigest: string;
  readonly semanticDigest: string;
  readonly semantic: ContextSummarizationResult["semantic"];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("Persisted compaction summary artifact is malformed.", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Persisted compaction summary artifact is invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (new TextEncoder().encode(value).byteLength > 32_768) {
    throw new TypeError("Persisted compaction summary artifact exceeds its byte bound.");
  }
  const expectedKeys = [
    "version",
    "requestFingerprint",
    "promptVersion",
    "costVersion",
    "modelRef",
    "finishReason",
    "sourceDigest",
    "semanticDigest",
    "semantic",
  ].sort();
  const actualKeys = Object.keys(candidate).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    candidate.version !== 1 ||
    typeof candidate.requestFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(candidate.requestFingerprint) ||
    !Number.isSafeInteger(candidate.promptVersion) ||
    (candidate.promptVersion as number) < 1 ||
    typeof candidate.costVersion !== "string" ||
    candidate.costVersion.length === 0 ||
    candidate.costVersion.length > 64 ||
    candidate.finishReason !== "STOP" ||
    typeof candidate.sourceDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.sourceDigest) ||
    typeof candidate.semanticDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.semanticDigest) ||
    candidate.modelRef === null ||
    typeof candidate.modelRef !== "object" ||
    Array.isArray(candidate.modelRef)
  ) {
    throw new TypeError("Persisted compaction summary artifact fields are invalid.");
  }
  const modelRef = candidate.modelRef as Record<string, unknown>;
  if (
    typeof modelRef.provider !== "string" ||
    modelRef.provider.trim().length === 0 ||
    modelRef.provider.length > 256 ||
    typeof modelRef.model !== "string" ||
    modelRef.model.trim().length === 0 ||
    modelRef.model.length > 256 ||
    Object.keys(modelRef).some((key) => !["provider", "model"].includes(key))
  ) {
    throw new TypeError("Persisted compaction summary model reference is invalid.");
  }
  const semantic = createSemanticCheckpointDraft(candidate.semantic);
  if (digestJsonValue(JSON.parse(JSON.stringify(semantic)) as never) !== candidate.semanticDigest) {
    throw new TypeError("Persisted compaction summary semantic digest does not match.");
  }
  return Object.freeze({
    requestFingerprint: candidate.requestFingerprint,
    promptVersion: candidate.promptVersion as number,
    costVersion: candidate.costVersion,
    modelRef: modelRef as unknown as ModelRef,
    sourceDigest: candidate.sourceDigest,
    semanticDigest: candidate.semanticDigest,
    semantic,
  });
}

function assertFingerprint(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 fingerprint.`);
  }
}

function summarySourceRef(requestFingerprint: string): string {
  return `compaction-summary:${requestFingerprint}`;
}

function isLocallyReplannableFailure(failureFamily: string): boolean {
  return [
    "CANDIDATE_NOT_FIT",
    "NO_COMPRESSIBLE_HISTORY",
    "INSUFFICIENT_GAIN",
    "REQUEST_TOO_LARGE",
    "INSUFFICIENT_REDUCTION",
    "PROTECTED_CONTENT_MISSING",
  ].includes(failureFamily);
}

async function latestFailureBaseline(
  store: ContextArtifactStorePort,
  sourceRef: string,
): Promise<Extract<AttemptArtifactRecord, { recordType: "FAILURE_BASELINE" }> | undefined> {
  const artifacts = await listArtifacts(store, FAILURE_KIND, sourceRef);
  const candidates: Array<{
    readonly artifact: ContextArtifact;
    readonly record: Extract<AttemptArtifactRecord, { recordType: "FAILURE_BASELINE" }>;
  }> = [];
  for (const artifact of artifacts) {
    const record = parseAttemptRecord(artifact.content);
    if (record.recordType === "FAILURE_BASELINE") candidates.push({ artifact, record });
  }
  candidates.sort((left, right) =>
    left.artifact.createdAt === right.artifact.createdAt
      ? compareStrings(String(left.artifact.artifactId), String(right.artifact.artifactId))
      : left.artifact.createdAt < right.artifact.createdAt
        ? -1
        : 1,
  );
  return candidates.at(-1)?.record;
}

async function failureBaselineForAttempt(
  store: ContextArtifactStorePort,
  sourceRef: string,
  attemptId: string,
): Promise<Extract<AttemptArtifactRecord, { recordType: "FAILURE_BASELINE" }> | undefined> {
  const [artifacts, attemptRecords] = await Promise.all([
    listArtifacts(store, FAILURE_KIND, sourceRef),
    listAttemptRecords(store, attemptId),
  ]);
  const start = attemptRecords.find(
    (record): record is Extract<AttemptArtifactRecord, { recordType: "ATTEMPT" }> =>
      record.recordType === "ATTEMPT" && record.state === "START",
  );
  if (start === undefined) return undefined;
  const terminal = attemptRecords.find(
    (record) => record.recordType === "ATTEMPT" && record.state === "RESULT",
  );
  if (terminal?.recordType === "ATTEMPT" && terminal.outcome === "COMPACTED") {
    throw new TypeError("A completed compaction attempt cannot authorize an explicit retry.");
  }
  const matching = artifacts
    .map((artifact) => ({ artifact, record: parseAttemptRecord(artifact.content) }))
    .filter(
      (
        entry,
      ): entry is {
        readonly artifact: ContextArtifact;
        readonly record: Extract<AttemptArtifactRecord, { recordType: "FAILURE_BASELINE" }>;
      } => entry.record.recordType === "FAILURE_BASELINE" && entry.record.attemptId === attemptId,
    )
    .filter(
      (entry) =>
        entry.record.sourceCoverageDigest === start.sourceCoverageDigest &&
        entry.record.sourceTokens === start.sourceTokens,
    )
    .sort((left, right) =>
      left.artifact.createdAt === right.artifact.createdAt
        ? compareStrings(String(left.artifact.artifactId), String(right.artifact.artifactId))
        : left.artifact.createdAt < right.artifact.createdAt
          ? -1
          : 1,
    );
  return matching.at(-1)?.record;
}

async function listAttemptRecords(
  store: ContextArtifactStorePort,
  attemptId: string,
): Promise<readonly AttemptArtifactRecord[]> {
  const [attempts, ...subcallsByOrdinal] = await Promise.all([
    listArtifacts(store, ATTEMPT_KIND, attemptId),
    ...Array.from({ length: MAX_PERSISTED_COMPACTION_SUBCALLS }, (_, callOrdinal) =>
      listArtifacts(store, SUBCALL_KIND, subcallSourceRef(attemptId, callOrdinal)),
    ),
  ]);
  return Object.freeze(
    [...attempts, ...subcallsByOrdinal.flat()].map((artifact) =>
      parseAttemptRecord(artifact.content),
    ),
  );
}

async function listArtifacts(
  store: ContextArtifactStorePort,
  kind: string,
  sourceRef: string,
): Promise<readonly ContextArtifact[]> {
  const result: ContextArtifact[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_ATTEMPT_SCAN_PAGES; pageNumber += 1) {
    const page = await store.listBySourceRef({
      kind,
      sourceRef,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
    });
    for (const metadata of page.records) {
      const artifact = await store.readInternal(metadata.artifactId);
      if (artifact === undefined) throw new Error("Compaction attempt artifact disappeared.");
      result.push(artifact);
    }
    cursor = page.nextCursor;
    if (cursor === undefined) return Object.freeze(result);
  }
  throw new RangeError("Compaction attempt history exceeds its bounded page limit.");
}

function parseAttemptRecord(value: string): AttemptArtifactRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("Persisted compaction attempt record is malformed.", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Persisted compaction attempt record is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.recordType !== "string" ||
    typeof record.attemptId !== "string"
  ) {
    throw new TypeError("Persisted compaction attempt record fields are invalid.");
  }
  if (record.recordType === "SUBCALL") {
    if (
      !Number.isSafeInteger(record.callOrdinal) ||
      (record.callOrdinal as number) < 0 ||
      (record.callOrdinal as number) >= MAX_PERSISTED_COMPACTION_SUBCALLS ||
      (record.state !== "START" && record.state !== "RESULT") ||
      typeof record.requestFingerprint !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(record.requestFingerprint) ||
      (record.state === "RESULT" &&
        record.outcome !== "ACCEPTED" &&
        record.outcome !== "FALLBACK_REQUIRED")
    ) {
      throw new TypeError("Persisted compaction subcall fields are invalid.");
    }
    return record as AttemptArtifactRecord;
  }
  if (
    typeof record.sourceCoverageDigest !== "string" ||
    !Number.isSafeInteger(record.sourceTokens) ||
    (record.sourceTokens as number) < 0
  ) {
    throw new TypeError("Persisted compaction attempt source fields are invalid.");
  }
  if (record.recordType === "ATTEMPT") {
    if (
      (record.state !== "START" && record.state !== "RESULT") ||
      (record.retryGeneration !== undefined &&
        (typeof record.retryGeneration !== "number" ||
          !Number.isSafeInteger(record.retryGeneration) ||
          record.retryGeneration < 0)) ||
      (record.state === "RESULT" &&
        record.outcome !== "COMPACTED" &&
        record.outcome !== "FAILED") ||
      (record.failureFamily !== undefined &&
        (record.state !== "RESULT" ||
          record.outcome !== "FAILED" ||
          typeof record.failureFamily !== "string" ||
          record.failureFamily.trim().length === 0 ||
          record.failureFamily.length > 128)) ||
      (record.checkpointId !== undefined && typeof record.checkpointId !== "string") ||
      (record.activationOperationId !== undefined &&
        typeof record.activationOperationId !== "string")
    ) {
      throw new TypeError("Persisted compaction attempt state is invalid.");
    }
    return record as AttemptArtifactRecord;
  }
  if (
    record.recordType === "FAILURE_BASELINE" &&
    Number.isSafeInteger(record.minimumGrowthTokens) &&
    Number.isSafeInteger(record.retryGeneration) &&
    typeof record.failureFamily === "string"
  ) {
    return record as AttemptArtifactRecord;
  }
  throw new TypeError("Persisted compaction attempt record type is unsupported.");
}

function assertSource(digest: string, tokens: number): void {
  if (digest.trim().length === 0 || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError("Compaction source coverage identity is invalid.");
  }
}

function failureBaselineSourceRef(sessionId: SessionId): string {
  return `compaction-attempt:failure:${String(sessionId)}`;
}

function subcallSourceRef(attemptId: string, callOrdinal: number): string {
  return `${attemptId}:subcall:${String(callOrdinal).padStart(2, "0")}`;
}

function assertSubcallIdentity(callOrdinal: number, requestFingerprint: string): void {
  if (
    !Number.isSafeInteger(callOrdinal) ||
    callOrdinal < 0 ||
    callOrdinal >= MAX_PERSISTED_COMPACTION_SUBCALLS
  ) {
    throw new RangeError(
      `Compaction summary subcall limit is ${MAX_PERSISTED_COMPACTION_SUBCALLS}.`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(requestFingerprint)) {
    throw new TypeError("Compaction summary subcall fingerprint is invalid.");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createCompactionSourceCoverageDigest(input: {
  readonly messageRefs: readonly {
    readonly runId: string;
    readonly conversationTurnId: string;
    readonly messageId: string;
    readonly sequence: number;
  }[];
}): string {
  return `sha256:${digestJsonValue(input as never)}`;
}
