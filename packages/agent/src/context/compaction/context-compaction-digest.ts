import type { JsonValue } from "@caelush/ai";

import { digestJsonValue } from "../../messages/canonical-json.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type {
  ContextCheckpointRecordV2,
  ContextMessageRange,
} from "./context-compaction-contracts.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";

/** The stable canonical envelope version for Phase 8D durable compaction digests. */
export const CONTEXT_COMPACTION_DIGEST_VERSION = "context-checkpoint-v2-digest-v1" as const;

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
          newSourceMessages: input.newSourceMessages
            .map((stored) => ({
              messageId: String(stored.message.id),
              sequence: stored.sequence,
              schemaVersion: stored.schemaVersion,
              modelProjectionVersion: stored.modelProjectionVersion ?? null,
            }))
            .sort(compareMessageEnvelope),
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

function compareMessageEnvelope(
  left: {
    readonly messageId: string;
    readonly sequence: number;
    readonly schemaVersion: number;
    readonly modelProjectionVersion: number | null;
  },
  right: {
    readonly messageId: string;
    readonly sequence: number;
    readonly schemaVersion: number;
    readonly modelProjectionVersion: number | null;
  },
): number {
  return left.sequence - right.sequence || compareStrings(left.messageId, right.messageId);
}

function toJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
