import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  beginPersistedCompactionAttempt,
  beginPersistedCompactionSubcall,
  createPersistedCompactionAttemptTerminalArtifact,
  deriveCompactionRetryGeneration,
  deriveCompactionAttemptIdentity,
  digestJsonValue,
  evaluateCompactionRetryEligibility,
  finishPersistedCompactionSubcall,
  finishPersistedCompactionAttempt,
  mayStartCompactionSubcall,
  recordPersistedCompactionFailureBaseline,
} from "@caelush/agent";
import type {
  ContextArtifact,
  ContextArtifactCreateInput,
  ContextArtifactStorePort,
} from "@caelush/agent";
import { createTimestampMs } from "@caelush/protocol";
import {
  beginNextPersistedCompactionSubcall,
  readPersistedAcceptedSummary,
} from "../../src/context/compaction/persisted-compaction-attempt.js";

const sessionId = "session:attempt-test" as never;

describe("persistent compaction attempt identity", () => {
  it("does not retry the same failed source after an engine restart", () => {
    const first = deriveCompactionAttemptIdentity({
      sessionId,
      sourceKey: "source:stable",
      retryGeneration: 0,
      failureFamily: "SUMMARY_UNAVAILABLE",
    });
    const afterRestart = deriveCompactionAttemptIdentity({
      sessionId,
      sourceKey: "source:stable",
      retryGeneration: 0,
      failureFamily: "SUMMARY_UNAVAILABLE",
    });

    expect(afterRestart).toEqual(first);
    expect(
      evaluateCompactionRetryEligibility({
        failureBaseline: {
          sourceCoverageDigest: "coverage:1",
          sourceTokens: 20_000,
          minimumGrowthTokens: 8_192,
        },
        candidateSource: { sourceCoverageDigest: "coverage:1", sourceTokens: 20_000 },
      }),
    ).toEqual({ eligible: false, reason: "SAME_FAILED_SOURCE" });
  });

  it("measures small growth against the fixed failed baseline even as source keys change", () => {
    const baseline = {
      sourceCoverageDigest: "coverage:at-failure",
      sourceTokens: 20_000,
      minimumGrowthTokens: 8_192,
    };
    for (const growth of [1, 100, 8_191]) {
      expect(
        evaluateCompactionRetryEligibility({
          failureBaseline: baseline,
          candidateSource: {
            sourceCoverageDigest: `new-moving-key:${growth}`,
            sourceTokens: baseline.sourceTokens + growth,
          },
        }),
      ).toEqual({ eligible: false, reason: "INSUFFICIENT_SOURCE_GROWTH" });
    }
    expect(
      evaluateCompactionRetryEligibility({
        failureBaseline: baseline,
        candidateSource: {
          sourceCoverageDigest: "different-source-key-after-growth",
          sourceTokens: baseline.sourceTokens + 8_192,
        },
      }),
    ).toEqual({ eligible: true, reason: "SOURCE_GROWTH_THRESHOLD_REACHED" });
  });

  it("uses a new explicit retry generation while replaying one request idempotently", () => {
    const first = deriveCompactionAttemptIdentity({
      sessionId,
      sourceKey: "source:failed",
      retryGeneration: 1,
      failureFamily: "SUMMARY_UNAVAILABLE",
    });
    const replay = deriveCompactionAttemptIdentity({
      sessionId,
      sourceKey: "source:failed",
      retryGeneration: 1,
      failureFamily: "SUMMARY_UNAVAILABLE",
    });
    const nextRequest = deriveCompactionAttemptIdentity({
      sessionId,
      sourceKey: "source:failed",
      retryGeneration: 2,
      failureFamily: "SUMMARY_UNAVAILABLE",
    });

    expect(replay.attemptId).toBe(first.attemptId);
    expect(nextRequest.attemptId).not.toBe(first.attemptId);
    expect(
      evaluateCompactionRetryEligibility({
        failureBaseline: {
          sourceCoverageDigest: "same",
          sourceTokens: 20_000,
          minimumGrowthTokens: 8_192,
          retryGeneration: 1,
        },
        candidateSource: { sourceCoverageDigest: "same", sourceTokens: 20_000 },
        authorization: { kind: "EXPLICIT_RETRY", requestId: "request:new", retryGeneration: 2 },
      }),
    ).toEqual({ eligible: true, reason: "EXPLICIT_RETRY" });
  });

  it("does not resend a started provider subcall whose result is unknown", () => {
    expect(mayStartCompactionSubcall({ hasStart: false, hasResult: false })).toBe(true);
    expect(mayStartCompactionSubcall({ hasStart: true, hasResult: false })).toBe(false);
    expect(mayStartCompactionSubcall({ hasStart: true, hasResult: true })).toBe(false);
  });

  it("keeps an unknown thrown attempt on a fixed failure baseline", async () => {
    const store = createMemoryArtifactStore();
    const first = await beginPersistedCompactionAttempt({
      store,
      runId: "run:attempt-test" as never,
      sessionId,
      sourceCoverageDigest: "coverage:failure",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(1),
    });
    expect(first.kind).toBe("CLAIMED");
    if (first.kind !== "CLAIMED") return;

    await recordPersistedCompactionFailureBaseline({
      store,
      attempt: first.attempt,
      createdSequence: 1,
      createdAt: createTimestampMs(2),
      failureFamily: "UNKNOWN_OUTCOME",
    });

    const belowThreshold = await beginPersistedCompactionAttempt({
      store,
      runId: "run:attempt-test" as never,
      sessionId,
      sourceCoverageDigest: "coverage:failure-plus-8191",
      sourceTokens: 28_191,
      createdSequence: 2,
      createdAt: createTimestampMs(3),
    });
    expect(belowThreshold).toMatchObject({
      kind: "BLOCKED",
      reason: "INSUFFICIENT_SOURCE_GROWTH",
    });

    const atThreshold = await beginPersistedCompactionAttempt({
      store,
      runId: "run:attempt-test" as never,
      sessionId,
      sourceCoverageDigest: "coverage:failure-plus-8192",
      sourceTokens: 28_192,
      createdSequence: 3,
      createdAt: createTimestampMs(4),
    });
    expect(atThreshold.kind).toBe("CLAIMED");
  });

  it("authorizes one idempotent retry of a failed source from a new persisted request", async () => {
    const store = createMemoryArtifactStore();
    const failed = await beginPersistedCompactionAttempt({
      store,
      runId: "run:first" as never,
      sessionId,
      sourceCoverageDigest: "coverage:failed",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(10),
    });
    expect(failed.kind).toBe("CLAIMED");
    if (failed.kind !== "CLAIMED") return;
    await recordPersistedCompactionFailureBaseline({
      store,
      attempt: failed.attempt,
      createdSequence: 1,
      createdAt: createTimestampMs(11),
      failureFamily: "SUMMARY_UNAVAILABLE",
    });

    const retryRequestId = "submission:explicit-retry-1";
    const authorization = {
      previousAttemptId: failed.attempt.attemptId,
      requestId: retryRequestId,
    };
    const retry = await beginPersistedCompactionAttempt({
      store,
      runId: "run:retry" as never,
      sessionId,
      sourceCoverageDigest: "coverage:failed",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(12),
      authorization,
    });
    expect(retry.kind).toBe("CLAIMED");

    const replay = await beginPersistedCompactionAttempt({
      store,
      runId: "run:retry" as never,
      sessionId,
      sourceCoverageDigest: "coverage:failed",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(13),
      authorization,
    });
    expect(replay).toMatchObject({ kind: "BLOCKED", reason: "ATTEMPT_ALREADY_CLAIMED" });
    expect(deriveCompactionRetryGeneration(retryRequestId)).toBe(
      deriveCompactionRetryGeneration(retryRequestId),
    );
    expect(() => deriveCompactionRetryGeneration(" ")).toThrow("requestId");
  });

  it("claims each summary subcall once and blocks an unknown START on restart", async () => {
    const store = createMemoryArtifactStore();
    const claim = await beginPersistedCompactionAttempt({
      store,
      runId: "run:subcall" as never,
      sessionId,
      sourceCoverageDigest: "coverage:subcall",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(20),
    });
    if (claim.kind !== "CLAIMED") throw new Error("attempt should be claimed");
    const input = {
      store,
      attempt: claim.attempt,
      callOrdinal: 0,
      requestFingerprint: `sha256:${"a".repeat(64)}`,
      createdSequence: 1,
      createdAt: createTimestampMs(21),
    };

    await expect(beginPersistedCompactionSubcall(input)).resolves.toEqual({ kind: "CLAIMED" });
    await expect(beginPersistedCompactionSubcall(input)).resolves.toEqual({
      kind: "BLOCKED",
      reason: "SUBCALL_ALREADY_STARTED",
    });
    await expect(beginPersistedCompactionSubcall({ ...input, callOrdinal: 16 })).rejects.toThrow(
      "subcall limit",
    );
  });

  it("keeps an atomic COMPACTED terminal result when a later failure is observed", async () => {
    const store = createMemoryArtifactStore();
    const claim = await beginPersistedCompactionAttempt({
      store,
      runId: "run:committed-attempt" as never,
      sessionId,
      sourceCoverageDigest: "coverage:committed-attempt",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(28),
    });
    if (claim.kind !== "CLAIMED") throw new Error("attempt should be claimed");
    await store.claim(
      createPersistedCompactionAttemptTerminalArtifact({
        attempt: claim.attempt,
        createdSequence: 1,
        createdAt: createTimestampMs(29),
        outcome: "COMPACTED",
        checkpointId: "checkpoint:committed",
        activationOperationId: "operation:committed",
      }),
    );

    await finishPersistedCompactionAttempt({
      store,
      attempt: claim.attempt,
      createdSequence: 1,
      createdAt: createTimestampMs(30),
      outcome: "FAILED",
      failureFamily: "CANDIDATE_NOT_FIT",
    });

    const attempts = await store.listBySourceRef({
      kind: "context-compaction-attempt",
      sourceRef: claim.attempt.attemptId,
    });
    const records = await Promise.all(
      attempts.records.map(async (metadata) => {
        const artifact = await store.readInternal(metadata.artifactId);
        if (artifact === undefined) throw new Error("attempt fixture disappeared");
        return JSON.parse(artifact.content) as Record<string, unknown>;
      }),
    );
    expect(records.filter((record) => record.state === "RESULT")).toEqual([
      expect.objectContaining({ outcome: "COMPACTED" }),
    ]);
  });

  it("allows a local failure with no provider subcall to be replanned without source growth", async () => {
    const store = createMemoryArtifactStore();
    const first = await beginPersistedCompactionAttempt({
      store,
      runId: "run:local-replan-first" as never,
      sessionId,
      sourceCoverageDigest: "coverage:local-replan",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(24),
    });
    if (first.kind !== "CLAIMED") throw new Error("attempt should be claimed");

    await finishPersistedCompactionAttempt({
      store,
      attempt: first.attempt,
      createdSequence: 1,
      createdAt: createTimestampMs(25),
      outcome: "FAILED",
      failureFamily: "NO_COMPRESSIBLE_HISTORY",
    });

    await expect(
      beginPersistedCompactionAttempt({
        store,
        runId: "run:local-replan-second" as never,
        sessionId,
        sourceCoverageDigest: "coverage:local-replan",
        sourceTokens: 20_000,
        createdSequence: 2,
        createdAt: createTimestampMs(26),
      }),
    ).resolves.toMatchObject({ kind: "CLAIMED" });
  });

  it("reports the identity of an unknown START without claiming a different summary request", async () => {
    const store = createMemoryArtifactStore();
    const claim = await beginPersistedCompactionAttempt({
      store,
      runId: "run:unknown-start" as never,
      sessionId,
      sourceCoverageDigest: "coverage:unknown-start",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(25),
    });
    if (claim.kind !== "CLAIMED") throw new Error("attempt should be claimed");
    const unknownFingerprint = `sha256:${"a".repeat(64)}`;
    const retryFingerprint = `sha256:${"b".repeat(64)}`;
    await beginPersistedCompactionSubcall({
      store,
      attempt: claim.attempt,
      callOrdinal: 0,
      requestFingerprint: unknownFingerprint,
      createdSequence: 1,
      createdAt: createTimestampMs(26),
    });

    await expect(
      beginNextPersistedCompactionSubcall({
        store,
        attempt: claim.attempt,
        requestFingerprint: retryFingerprint,
        createdSequence: 1,
        createdAt: createTimestampMs(27),
      }),
    ).resolves.toEqual({
      kind: "BLOCKED",
      reason: "SUBCALL_ALREADY_STARTED",
      callOrdinal: 0,
      requestFingerprint: unknownFingerprint,
    });
  });

  it("persists the bounded accepted semantic draft before closing the summary subcall", async () => {
    const store = createMemoryArtifactStore();
    const claim = await beginPersistedCompactionAttempt({
      store,
      runId: "run:summary-artifact" as never,
      sessionId,
      sourceCoverageDigest: "coverage:summary-artifact",
      sourceTokens: 20_000,
      createdSequence: 1,
      createdAt: createTimestampMs(30),
    });
    if (claim.kind !== "CLAIMED") throw new Error("attempt should be claimed");
    const fingerprint = `sha256:${"b".repeat(64)}`;
    const subcall = {
      store,
      attempt: claim.attempt,
      callOrdinal: 0,
      requestFingerprint: fingerprint,
      createdSequence: 1,
      createdAt: createTimestampMs(31),
    };
    await beginPersistedCompactionSubcall(subcall);

    await finishPersistedCompactionSubcall({
      ...subcall,
      outcome: "ACCEPTED",
      acceptedResult: (() => {
        const semantic = {
          constraints: ["keep the task intact"],
          completedWork: [],
          inProgress: ["validate compaction"],
          blocked: [],
          importantDiscoveries: [],
          keyDecisions: [],
          criticalReferences: [],
          nextIntent: "continue validation",
        };
        return {
          semantic,
          modelRef: { provider: "test", model: "summary", baseUrl: "https://secret.invalid" },
          finishReason: "STOP",
          summaryPromptVersion: 4,
          sourceDigest: "c".repeat(64),
          semanticDigest: digestJsonValue(semantic),
        };
      })(),
    });

    const summaries = await store.listBySourceRef({
      kind: "context-compaction-summary",
      sourceRef: `compaction-summary:${fingerprint}`,
    });
    expect(summaries.records).toHaveLength(1);
    const summary = await store.readInternal(summaries.records[0]!.artifactId);
    expect(summary?.content).not.toContain("secret.invalid");
    await expect(
      readPersistedAcceptedSummary({
        store,
        requestFingerprint: fingerprint,
        modelRef: { provider: "test", model: "summary" },
        sourceDigest: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ semantic: { nextIntent: "continue validation" } });

    await finishPersistedCompactionAttempt({
      store,
      attempt: claim.attempt,
      createdSequence: 1,
      createdAt: createTimestampMs(32),
      outcome: "FAILED",
      failureFamily: "PROTECTED_CONTENT_MISSING",
    });
    await expect(
      beginPersistedCompactionAttempt({
        store,
        runId: "run:summary-replan" as never,
        sessionId,
        sourceCoverageDigest: "coverage:summary-artifact",
        sourceTokens: 20_000,
        createdSequence: 2,
        createdAt: createTimestampMs(33),
      }),
    ).resolves.toMatchObject({ kind: "CLAIMED" });

    store.corruptContentHash(summaries.records[0]!.artifactId);
    await expect(
      readPersistedAcceptedSummary({
        store,
        requestFingerprint: fingerprint,
        modelRef: { provider: "test", model: "summary" },
        sourceDigest: "c".repeat(64),
      }),
    ).rejects.toThrow("content hash");
  });
});

function createMemoryArtifactStore(): ContextArtifactStorePort & {
  corruptContentHash(artifactId: ContextArtifact["artifactId"]): void;
} {
  const records = new Map<string, ContextArtifact>();
  const metadata = (artifact: ContextArtifact) => {
    const { content: _content, ...entry } = artifact;
    void _content;
    return Object.freeze(entry);
  };
  const save = async (input: ContextArtifactCreateInput) => {
    const artifactId = input.artifactId;
    if (artifactId === undefined) throw new TypeError("attempt fixture requires deterministic IDs");
    const existing = records.get(String(artifactId));
    if (existing !== undefined) return { kind: "EXISTING" as const, artifact: existing };
    const artifact = Object.freeze({
      ...input,
      artifactId,
      contentHash: createHash("sha256").update(input.content, "utf8").digest("hex"),
      byteLength: new TextEncoder().encode(input.content).byteLength,
    });
    records.set(String(artifactId), artifact);
    return { kind: "CREATED" as const, artifact };
  };
  return {
    corruptContentHash(artifactId) {
      const record = records.get(String(artifactId));
      if (record === undefined) throw new Error("artifact missing");
      records.set(String(artifactId), Object.freeze({ ...record, contentHash: "corrupt" }));
    },
    createOrGet: async (input) => (await save(input)).artifact,
    claim: save,
    listBySourceRef: async ({ kind, sourceRef, cursor, limit = 20 }) => {
      const entries = [...records.values()]
        .filter((record) => record.kind === kind && record.sourceRef === sourceRef)
        .sort((left, right) => String(left.artifactId).localeCompare(String(right.artifactId)))
        .filter((record) => cursor === undefined || String(record.artifactId) > cursor)
        .slice(0, limit + 1);
      const selected = entries.slice(0, limit);
      return {
        records: Object.freeze(selected.map(metadata)),
        ...(entries.length > limit && selected.length > 0
          ? { nextCursor: String(selected.at(-1)!.artifactId) }
          : {}),
      };
    },
    getMetadata: async (artifactId) => {
      const record = records.get(String(artifactId));
      return record === undefined ? undefined : metadata(record);
    },
    readInternal: async (artifactId) => records.get(String(artifactId)),
    readSafeProjection: async (artifactId, maxBytes) => {
      const record = records.get(String(artifactId));
      if (record === undefined) return undefined;
      return new TextEncoder().encode(record.content).byteLength <= maxBytes
        ? record.content
        : undefined;
    },
  };
}
