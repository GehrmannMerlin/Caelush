import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import type {
  ContextArtifact,
  ContextArtifactCreateInput,
  ContextArtifactStorePort,
} from "../artifacts/context-artifact.js";
import { digestJsonValue } from "../../messages/canonical-json.js";
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
const FAILURE_KIND = "context-compaction-failure-baseline";
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
  if (previousFailure !== undefined) {
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
  await input.store.claim(
    createPersistedCompactionAttemptTerminalArtifact({
      attempt: input.attempt,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
      outcome: input.outcome,
    }),
  );
  if (input.outcome === "COMPACTED") return;
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

/** Record a result without persisting semantic summary text or a provider exception. */
export async function finishPersistedCompactionSubcall(input: {
  readonly store: ContextArtifactStorePort;
  readonly attempt: PersistedCompactionAttempt;
  readonly callOrdinal: number;
  readonly requestFingerprint: string;
  readonly outcome: "ACCEPTED" | "FALLBACK_REQUIRED";
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
}): Promise<void> {
  assertSubcallIdentity(input.callOrdinal, input.requestFingerprint);
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

export function createPersistedCompactionAttemptTerminalArtifact(input: {
  readonly attempt: PersistedCompactionAttempt;
  readonly createdSequence: number;
  readonly createdAt: TimestampMs;
  readonly outcome: "COMPACTED" | "FAILED";
  readonly checkpointId?: string;
  readonly activationOperationId?: string;
}): ContextArtifactCreateInput {
  if (
    input.outcome === "COMPACTED" &&
    (input.checkpointId === undefined || input.activationOperationId === undefined)
  ) {
    throw new TypeError("A successful compaction attempt must reference its activation.");
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
  readonly kind: typeof ATTEMPT_KIND | typeof SUBCALL_KIND | typeof FAILURE_KIND;
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
  const artifacts = await listArtifacts(store, ATTEMPT_KIND, attemptId);
  return Object.freeze(artifacts.map((artifact) => parseAttemptRecord(artifact.content)));
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
