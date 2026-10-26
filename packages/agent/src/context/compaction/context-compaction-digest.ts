import type { JsonValue } from "@caelush/ai";

import { digestJsonValue } from "../../messages/canonical-json.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type {
  ContextCheckpointRecordV2,
  ContextMessageRange,
} from "./context-compaction-contracts.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { ContextCheckpointRecordV3 } from "./context-checkpoint-v3.js";
import type { ContextSourceCoverage } from "./context-source-coverage.js";
import type { StructuredCheckpointV2 } from "../checkpoint/structured-checkpoint.js";

/** The stable canonical envelope version for Phase 8D durable compaction digests. */
export const CONTEXT_COMPACTION_DIGEST_VERSION = "context-checkpoint-v2-digest-v1" as const;
export const CONTEXT_COMPACTION_DIGEST_V3_VERSION = "context-checkpoint-v3-digest-v1" as const;

export interface ContextCompactionDigestBuilder {
  source(input: {
    readonly semanticSourceDigest: string;
    readonly previousCheckpoint?: ContextCheckpointRecordV2;
    readonly newSourceMessages: readonly StoredAgentMessage[];
    readonly newSourceRange: ContextMessageRange;
    readonly cumulativeSourceRange: ContextMessageRange;
  }): string;
  checkpoint(input: {
    readonly structuredCheckpoint: StructuredCheckpoint;
    readonly sourceRange: ContextMessageRange;
  }): string;
}

export interface ContextCompactionDigestBuilderV3 {
  source(input: {
    readonly semanticSourceDigest: string;
    readonly previousCheckpoint?: ContextCheckpointRecordV2 | ContextCheckpointRecordV3;
    readonly newSourceMessages: readonly StoredAgentMessage[];
    readonly sourceCoverageDelta: readonly ContextMessageRange[];
    readonly cumulativeCoverage: ContextSourceCoverage;
  }): string;
  checkpoint(input: {
    readonly structuredCheckpoint: StructuredCheckpointV2;
    readonly coverage: ContextSourceCoverage;
  }): string;
}

/**
 * Build the two durable V2 digests without making Storage a Context authority.
 *
 * The semantic source digest binds the safe model-visible content produced by the
 * Phase 8C serializer. This outer digest binds the trusted predecessor, durable
 * message envelope identities/versions, and incremental ranges around it.
 */
export function createContextCompactionDigestBuilder(): ContextCompactionDigestBuilder {
  return Object.freeze({
    source(input: Parameters<ContextCompactionDigestBuilder["source"]>[0]): string {
      return digestJsonValue(
        toJson({
          digestVersion: CONTEXT_COMPACTION_DIGEST_VERSION,
          semanticSourceDigest: input.semanticSourceDigest,
          previousCheckpoint:
            input.previousCheckpoint === undefined
              ? null
              : {
                  checkpointId: String(input.previousCheckpoint.checkpointId),
                  checkpointDigest: input.previousCheckpoint.checkpointDigest,
                  sourceRange: input.previousCheckpoint.sourceRange,
                },
          newSourceMessages: input.newSourceMessages.map((stored) => ({
            messageId: String(stored.message.id),
            sequence: stored.sequence,
            schemaVersion: stored.schemaVersion,
            modelProjectionVersion: stored.modelProjectionVersion ?? null,
          })),
          newSourceRange: input.newSourceRange,
          cumulativeSourceRange: input.cumulativeSourceRange,
        }),
      );
    },
    checkpoint(input: Parameters<ContextCompactionDigestBuilder["checkpoint"]>[0]): string {
      return digestJsonValue(
        toJson({
          digestVersion: CONTEXT_COMPACTION_DIGEST_VERSION,
          schemaVersion: 2,
          sourceRange: input.sourceRange,
          structuredCheckpoint: input.structuredCheckpoint,
        }),
      );
    },
  });
}

/** Canonical multi-range digest builder; owner Run identity is deliberately outside coverage. */
export function createContextCompactionDigestBuilderV3(): ContextCompactionDigestBuilderV3 {
  return Object.freeze({
    source(input: Parameters<ContextCompactionDigestBuilderV3["source"]>[0]): string {
      return digestJsonValue(
        toJson({
          digestVersion: CONTEXT_COMPACTION_DIGEST_V3_VERSION,
          semanticSourceDigest: input.semanticSourceDigest,
          previousCheckpoint:
            input.previousCheckpoint === undefined
              ? null
              : input.previousCheckpoint.schemaVersion === 3
                ? {
                    checkpointId: String(input.previousCheckpoint.checkpointId),
                    checkpointDigest: input.previousCheckpoint.checkpointDigest,
                    coverage: input.previousCheckpoint.coverage,
                  }
                : {
                    checkpointId: String(input.previousCheckpoint.checkpointId),
                    checkpointDigest: input.previousCheckpoint.checkpointDigest,
                    sourceRange: input.previousCheckpoint.sourceRange,
                  },
          newSourceMessages: input.newSourceMessages.map((stored) => ({
            messageId: String(stored.message.id),
            runId: String(stored.message.runId),
            conversationTurnId: String(stored.message.conversationTurnId),
            sequence: stored.sequence,
            schemaVersion: stored.schemaVersion,
            modelProjectionVersion: stored.modelProjectionVersion ?? null,
          })),
          sourceCoverageDelta: input.sourceCoverageDelta,
          cumulativeCoverage: input.cumulativeCoverage,
        }),
      );
    },
    checkpoint(input: Parameters<ContextCompactionDigestBuilderV3["checkpoint"]>[0]): string {
      return digestJsonValue(
        toJson({
          digestVersion: CONTEXT_COMPACTION_DIGEST_V3_VERSION,
          schemaVersion: 3,
          coverage: input.coverage,
          structuredCheckpoint: input.structuredCheckpoint,
        }),
      );
    },
  });
}

function toJson(value: unknown): JsonValue {
  return value as JsonValue;
}
