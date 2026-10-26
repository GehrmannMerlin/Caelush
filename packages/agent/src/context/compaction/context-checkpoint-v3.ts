import type { ModelRef } from "@caelush/ai";
import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import type {
  ContextCheckpointId,
  ContextCompactionReason,
  ContextSummaryPromptVersion,
  ContextCheckpointRecordV2,
  LegacyContextCheckpointRecordV1,
} from "./context-compaction-contracts.js";
import type { ContextSourceCoverage } from "./context-source-coverage.js";
import type { StructuredCheckpointV2 } from "../checkpoint/structured-checkpoint.js";

/** `DEEP` is a historical label; new V2 retention writes use explicit outcomes. */
export type CompactionTargetStatus = "DEEP" | "PREFERRED" | "ELASTIC" | "FLOOR_LIMITED";

export type NewCompactionTargetStatus = Exclude<CompactionTargetStatus, "DEEP">;

export interface ContextCheckpointRecordV3 {
  readonly checkpointId: ContextCheckpointId;
  readonly schemaVersion: 3;
  readonly ownerRunId: RunId;
  readonly ownerStepSequence: number;
  readonly sessionId: SessionId;
  readonly previousCheckpointId?: ContextCheckpointId;
  readonly activationOperationId: string;
  readonly coverage: ContextSourceCoverage;
  readonly structuredCheckpoint: StructuredCheckpointV2;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly modelRef: ModelRef;
  readonly summaryPromptVersion: ContextSummaryPromptVersion;
  readonly sourceDigest: string;
  readonly checkpointDigest: string;
  readonly degraded: boolean;
  readonly reason: ContextCompactionReason;
  readonly targetStatus: CompactionTargetStatus;
  readonly createdAt: TimestampMs;
}

export type ContextCheckpointCreateInputV3 = Omit<
  ContextCheckpointRecordV3,
  "schemaVersion" | "targetStatus"
> & { readonly targetStatus: NewCompactionTargetStatus };

export interface ContextCheckpointSessionCandidates {
  readonly records: readonly (
    ContextCheckpointRecordV3 | ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1
  )[];
  readonly nextCursor?: string;
}

/** Session-scoped read/write capability for the V3 checkpoint envelope. */
export interface ContextCheckpointV3RepositoryPort {
  getById(checkpointId: string): Promise<ContextCheckpointRecordV3 | undefined>;
  listCandidatesBySession(input: {
    readonly sessionId: SessionId;
    readonly throughRunId: RunId;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ContextCheckpointSessionCandidates>;
}

export function assertContextCheckpointRecordV3(
  value: unknown,
): asserts value is ContextCheckpointRecordV3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("ContextCheckpointRecordV3 must be an object.");
  }
  const checkpoint = value as Record<string, unknown>;
  if (
    checkpoint.schemaVersion !== 3 ||
    typeof checkpoint.checkpointId !== "string" ||
    checkpoint.checkpointId.trim().length === 0 ||
    typeof checkpoint.ownerRunId !== "string" ||
    checkpoint.ownerRunId.length === 0 ||
    typeof checkpoint.sessionId !== "string" ||
    checkpoint.sessionId.length === 0 ||
    typeof checkpoint.activationOperationId !== "string" ||
    checkpoint.activationOperationId.length === 0 ||
    !Number.isSafeInteger(checkpoint.ownerStepSequence) ||
    (checkpoint.ownerStepSequence as number) < 1 ||
    !Number.isSafeInteger(checkpoint.tokensBefore) ||
    (checkpoint.tokensBefore as number) < 0 ||
    !Number.isSafeInteger(checkpoint.tokensAfter) ||
    (checkpoint.tokensAfter as number) < 0 ||
    typeof checkpoint.degraded !== "boolean" ||
    (checkpoint.targetStatus !== "DEEP" &&
      checkpoint.targetStatus !== "PREFERRED" &&
      checkpoint.targetStatus !== "ELASTIC" &&
      checkpoint.targetStatus !== "FLOOR_LIMITED")
  ) {
    throw new TypeError("ContextCheckpointRecordV3 fields are invalid.");
  }
}
