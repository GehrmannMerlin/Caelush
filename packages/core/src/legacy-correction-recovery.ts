import { createHash } from "node:crypto";
import type { RunId, TimestampMs } from "@caelush/protocol";
import {
  RunCorrectionRecoveryRecordV1Schema,
  type RunCorrectionRecoveryRecordV1,
} from "@caelush/protocol";

export interface ResourceCorrectionRecoveryPolicy {
  readonly authority: "DAEMON_AUTO_CORRECTION_V1";
}

/** Create the deterministic, auditable V1 → V2 decision for one accepted safe boundary. */
export function createLegacyCorrectionRecoveryRecord(input: {
  readonly runId: RunId;
  readonly sourceStepId?: string;
  readonly stateRevision: number;
  readonly continuationRevision: number;
  readonly committedAt: TimestampMs;
  readonly authority: ResourceCorrectionRecoveryPolicy["authority"];
}): RunCorrectionRecoveryRecordV1 {
  const identity = [
    String(input.runId),
    input.sourceStepId ?? "NO_SOURCE_STEP",
    String(input.stateRevision),
    String(input.continuationRevision),
    "LEGACY_NO_PROGRESS",
    input.authority,
  ];
  return RunCorrectionRecoveryRecordV1Schema.parse({
    version: 1,
    runId: input.runId,
    decisionId: createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex"),
    ...(input.sourceStepId === undefined ? {} : { sourceStepId: input.sourceStepId }),
    stateRevision: input.stateRevision,
    continuationRevision: input.continuationRevision,
    reason: "LEGACY_NO_PROGRESS",
    fromCorrectionVersion: "HISTORICAL_V1",
    effectiveCorrectionVersion: "AUTONOMOUS_CORRECTION_V2",
    authority: input.authority,
    committedAt: input.committedAt,
  });
}

export function assertCorrectionRecoveryBelongsToRun(
  runId: RunId,
  value: RunCorrectionRecoveryRecordV1,
): void {
  const record = RunCorrectionRecoveryRecordV1Schema.parse(value);
  if (
    record.runId !== runId ||
    record.fromCorrectionVersion !== "HISTORICAL_V1" ||
    record.effectiveCorrectionVersion !== "AUTONOMOUS_CORRECTION_V2"
  ) {
    throw new TypeError("Resource correction recovery decision does not belong to this Run.");
  }
}
