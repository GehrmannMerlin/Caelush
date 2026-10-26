import type {
  ContextCheckpointCreateInputV3,
  ContextCheckpointRecordV3,
  ContextSourceCoverage,
  StructuredCheckpointV2,
} from "@caelush/agent";
import {
  assertContextCheckpointRecordV3,
  assertContextSourceCoverage,
  createContextCheckpointId,
  createContextSummaryPromptVersion,
  createStructuredCheckpointV2,
} from "@caelush/agent";
import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import { StorageDecodeError } from "./errors.js";

interface PersistedModelRef {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
}

export interface ContextCheckpointV3Row {
  readonly id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly previous_checkpoint_id: string | null;
  readonly owner_step_sequence: number;
  readonly activation_operation_id: string;
  readonly coverage_digest: string;
  readonly source_sequence_from: null;
  readonly source_sequence_to: null;
  readonly tokens_before: number;
  readonly tokens_after: number;
  readonly summary_version: 3;
  readonly model_ref_json: string;
  readonly created_at_ms: number;
  readonly data_json: string;
  readonly read_file_refs_json: string;
  readonly changed_file_refs_json: string;
}

interface ContextCheckpointV3Envelope {
  readonly version: 3;
  readonly coverage: ContextSourceCoverage;
  readonly structuredCheckpoint: StructuredCheckpointV2;
  readonly summaryPromptVersion: number;
  readonly sourceDigest: string;
  readonly checkpointDigest: string;
  readonly degraded: boolean;
  readonly reason: ContextCheckpointRecordV3["reason"];
  readonly targetStatus: ContextCheckpointRecordV3["targetStatus"];
}

export const CONTEXT_CHECKPOINT_V3_SELECT = `SELECT id, run_id, session_id,
  previous_checkpoint_id, owner_step_sequence, activation_operation_id, coverage_digest,
  source_sequence_from, source_sequence_to, tokens_before, tokens_after, summary_version,
  model_ref_json, created_at_ms, data_json, read_file_refs_json, changed_file_refs_json
  FROM context_checkpoints`;

export function encodeContextCheckpointV3(
  input: ContextCheckpointCreateInputV3,
): ContextCheckpointV3Envelope {
  assertContextCheckpointRecordV3({ ...input, schemaVersion: 3 });
  assertContextSourceCoverage(input.coverage);
  if (input.structuredCheckpoint.sourceCoverage.coverageDigest !== input.coverage.coverageDigest) {
    throw new TypeError("Context Checkpoint V3 payload coverage does not match its envelope.");
  }
  if (
    input.structuredCheckpoint.sourceCoverage.sessionId !== input.sessionId ||
    input.coverage.sessionId !== input.sessionId
  ) {
    throw new TypeError("Context Checkpoint V3 coverage belongs to another Session.");
  }
  assertModelRef(input.modelRef);
  return Object.freeze({
    version: 3,
    coverage: input.coverage,
    structuredCheckpoint: createStructuredCheckpointV2(input.structuredCheckpoint),
    summaryPromptVersion: input.summaryPromptVersion,
    sourceDigest: requiredDigest(input.sourceDigest, "sourceDigest"),
    checkpointDigest: requiredDigest(input.checkpointDigest, "checkpointDigest"),
    degraded: input.degraded,
    reason: input.reason,
    targetStatus: input.targetStatus,
  });
}

export function decodeContextCheckpointV3(row: ContextCheckpointV3Row): ContextCheckpointRecordV3 {
  try {
    assertV3Row(row);
    const envelope = parseEnvelope(JSON.parse(row.data_json));
    const coverage = envelope.coverage;
    assertContextSourceCoverage(coverage);
    const structuredCheckpoint = createStructuredCheckpointV2(envelope.structuredCheckpoint);
    if (
      coverage.coverageDigest !== row.coverage_digest ||
      coverage.sessionId !== row.session_id ||
      structuredCheckpoint.sourceCoverage.coverageDigest !== coverage.coverageDigest
    ) {
      throw new Error("V3 coverage digest or Session identity does not match its row.");
    }
    const modelRef = parseModelRef(JSON.parse(row.model_ref_json));
    const record: ContextCheckpointRecordV3 = Object.freeze({
      checkpointId: createContextCheckpointId(row.id),
      schemaVersion: 3,
      ownerRunId: row.run_id as RunId,
      ownerStepSequence: row.owner_step_sequence,
      sessionId: row.session_id as SessionId,
      ...(row.previous_checkpoint_id === null
        ? {}
        : { previousCheckpointId: createContextCheckpointId(row.previous_checkpoint_id) }),
      activationOperationId: row.activation_operation_id,
      coverage,
      structuredCheckpoint,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
      modelRef,
      summaryPromptVersion: createContextSummaryPromptVersion(envelope.summaryPromptVersion),
      sourceDigest: requiredDigest(envelope.sourceDigest, "sourceDigest"),
      checkpointDigest: requiredDigest(envelope.checkpointDigest, "checkpointDigest"),
      degraded: envelope.degraded,
      reason: envelope.reason,
      targetStatus: envelope.targetStatus,
      createdAt: row.created_at_ms as TimestampMs,
    });
    assertContextCheckpointRecordV3(record);
    return record;
  } catch (error) {
    if (error instanceof StorageDecodeError) throw error;
    throw new StorageDecodeError("Context Checkpoint V3", row.id, "context_checkpoints", {
      cause: error,
    });
  }
}

function assertV3Row(row: ContextCheckpointV3Row): void {
  if (
    row.summary_version !== 3 ||
    row.source_sequence_from !== null ||
    row.source_sequence_to !== null ||
    !Number.isSafeInteger(row.owner_step_sequence) ||
    row.owner_step_sequence < 1 ||
    !Number.isSafeInteger(row.tokens_before) ||
    row.tokens_before < 0 ||
    !Number.isSafeInteger(row.tokens_after) ||
    row.tokens_after < 0 ||
    !Number.isSafeInteger(row.created_at_ms) ||
    row.created_at_ms < 0 ||
    row.id.length === 0 ||
    row.run_id.length === 0 ||
    row.session_id.length === 0 ||
    row.activation_operation_id.length === 0 ||
    !/^[a-f0-9]{64}$/.test(row.coverage_digest)
  ) {
    throw new TypeError("Context Checkpoint V3 row fields are invalid.");
  }
}

function parseEnvelope(value: unknown): ContextCheckpointV3Envelope {
  const record = recordValue(value);
  exactKeys(record, [
    "version",
    "coverage",
    "structuredCheckpoint",
    "summaryPromptVersion",
    "sourceDigest",
    "checkpointDigest",
    "degraded",
    "reason",
    "targetStatus",
  ]);
  if (
    record.version !== 3 ||
    typeof record.degraded !== "boolean" ||
    !isCompactionReason(record.reason) ||
    (record.targetStatus !== "DEEP" && record.targetStatus !== "FLOOR_LIMITED")
  ) {
    throw new TypeError("Context Checkpoint V3 envelope is invalid.");
  }
  return {
    version: 3,
    coverage: record.coverage as ContextSourceCoverage,
    structuredCheckpoint: record.structuredCheckpoint as StructuredCheckpointV2,
    summaryPromptVersion: record.summaryPromptVersion as number,
    sourceDigest: record.sourceDigest as string,
    checkpointDigest: record.checkpointDigest as string,
    degraded: record.degraded,
    reason: record.reason,
    targetStatus: record.targetStatus,
  };
}

function parseModelRef(value: unknown): PersistedModelRef {
  const record = recordValue(value);
  if (
    Object.keys(record).some((key) => key !== "provider" && key !== "model" && key !== "baseUrl") ||
    !Object.hasOwn(record, "provider") ||
    !Object.hasOwn(record, "model")
  ) {
    throw new TypeError("Context Checkpoint V3 model reference has an invalid shape.");
  }
  assertModelRef(record as unknown as PersistedModelRef);
  return Object.freeze({
    provider: record.provider as string,
    model: record.model as string,
    ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl as string }),
  });
}

function assertModelRef(value: PersistedModelRef): void {
  if (
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    (value.baseUrl !== undefined && typeof value.baseUrl !== "string")
  ) {
    throw new TypeError("Context Checkpoint V3 model reference is invalid.");
  }
}

function requiredDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`Context Checkpoint V3 ${field} is invalid.`);
  }
  return value;
}

function isCompactionReason(value: unknown): value is ContextCheckpointRecordV3["reason"] {
  return (
    value === "PROACTIVE_PRESSURE" ||
    value === "SELECTION_PRESSURE" ||
    value === "FORCED_PROVIDER_OVERFLOW"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Context Checkpoint V3 value must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError("Context Checkpoint V3 value has an invalid shape.");
  }
}
