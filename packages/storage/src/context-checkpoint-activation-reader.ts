import type {
  ApplicableContextCheckpoint,
  ContextCheckpointActivationReaderPort,
  ContextCheckpointRecordV2,
  ContextCheckpointRecordV3,
  PromptSurfaceStorePort,
} from "@caelush/agent";
import {
  applyPromptSurfaceSectionUpdates,
  canonicalJsonText,
  promptSurfaceEpochIdentity,
} from "@caelush/agent";
import { RUN_EVENT_SCHEMA_REGISTRY, type RunEvent } from "@caelush/protocol";
import type { SessionId } from "@caelush/protocol";

import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError } from "./errors.js";
import { createPromptSurfaceActivationFingerprint } from "./context-compaction-commit-store.js";

interface HistoricalCompletionRow {
  readonly event_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly step_id: string | null;
  readonly event_schema_version: number;
  readonly data_json: string;
}

/** Read-only proof adapter for historical activation and future V3 operation proofs. */
export class SqliteContextCheckpointActivationReader implements ContextCheckpointActivationReaderPort {
  constructor(
    private readonly database: CaelushDatabase,
    private readonly promptSurface: PromptSurfaceStorePort,
  ) {}

  async isActivated(input: {
    readonly checkpoint: ApplicableContextCheckpoint;
    readonly sessionId: SessionId;
  }): Promise<boolean> {
    const checkpoint = input.checkpoint;
    if (
      checkpoint.schemaVersion === 3 &&
      String(input.sessionId) !== String(checkpoint.sessionId)
    ) {
      return false;
    }
    if (checkpoint.schemaVersion === 3) {
      // The durable operation proof is introduced with the atomic activation transaction. Until
      // that table exists, a V3 envelope alone is deliberately insufficient evidence.
      const proofTable = this.database.client
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'context_compaction_activations'",
        )
        .get();
      if (proofTable === undefined) return false;
      return this.hasV3OperationProof(checkpoint);
    }
    if (checkpoint.schemaVersion === 1) return false;
    return this.hasV2SurfaceProof(checkpoint, input.sessionId);
  }

  private async hasV2SurfaceProof(
    checkpoint: ContextCheckpointRecordV2,
    sessionId: SessionId,
  ): Promise<boolean> {
    const owner = this.database.client
      .prepare("SELECT session_id FROM agent_runs WHERE id = ?")
      .get(checkpoint.runId) as { readonly session_id: string } | undefined;
    if (owner === undefined || String(owner.session_id) !== String(sessionId)) return false;
    const rows = this.database.client
      .prepare(
        `SELECT event_id, run_id, session_id, step_id, event_schema_version, data_json
         FROM agent_events WHERE run_id = ? AND event_type = 'context.compaction.completed'
         ORDER BY aggregate_sequence DESC`,
      )
      .all(checkpoint.runId) as unknown as HistoricalCompletionRow[];
    const matches = rows
      .map((row) => ({ row, event: decodeCompletion(row) }))
      .filter(({ event }) => {
        if (event.type !== "context.compaction.completed") return false;
        const payload = event.payload as { readonly checkpointId?: unknown };
        return payload.checkpointId === String(checkpoint.checkpointId);
      });
    if (matches.length === 0) return false;
    if (matches.length !== 1) {
      throw new StorageConflictError(
        "Historical Context Checkpoint has multiple completion events.",
      );
    }
    const { row, event } = matches[0]!;
    if (
      event.type !== "context.compaction.completed" ||
      row.session_id !== owner.session_id ||
      row.step_id === null ||
      !matchesV1CompletionPayload(event, checkpoint)
    ) {
      return false;
    }
    const step = this.database.client
      .prepare("SELECT sequence FROM agent_steps WHERE id = ? AND run_id = ?")
      .get(row.step_id, checkpoint.runId) as { readonly sequence: number } | undefined;
    if (step === undefined) return false;
    const epoch = await this.promptSurface.getCurrent(checkpoint.runId);
    if (
      epoch === undefined ||
      epoch.formatVersion !== 3 ||
      epoch.resetReason !== "COMPACTION_COMMITTED" ||
      epoch.createdStepSequence !== step.sequence
    ) {
      return false;
    }
    const completeEpoch = await this.promptSurface.readEpoch(checkpoint.runId, epoch.epochId);
    if (completeEpoch === undefined) return false;
    const baseline = completeEpoch.records?.[0];
    if (
      baseline === undefined ||
      baseline.ordinal !== 1 ||
      baseline.kind !== "BASELINE" ||
      baseline.sourceStepSequence !== step.sequence
    ) {
      return false;
    }
    return (
      completeEpoch.sectionStates?.some((state) =>
        sectionContainsCheckpoint(state.content, checkpoint.structuredCheckpoint),
      ) ?? false
    );
  }

  private async hasV3OperationProof(checkpoint: ContextCheckpointRecordV3): Promise<boolean> {
    const proof = this.database.client
      .prepare(
        `SELECT checkpoint_id, session_id, owner_run_id, owner_step_sequence,
                operation_id, epoch_id, baseline_fingerprint
         FROM context_compaction_activations WHERE operation_id = ?`,
      )
      .get(checkpoint.activationOperationId) as
      | {
          readonly checkpoint_id: string;
          readonly session_id: string;
          readonly owner_run_id: string;
          readonly owner_step_sequence: number;
          readonly operation_id: string;
          readonly epoch_id: string;
          readonly baseline_fingerprint: string;
        }
      | undefined;
    if (
      proof !== undefined &&
      proof.checkpoint_id === String(checkpoint.checkpointId) &&
      proof.session_id === String(checkpoint.sessionId) &&
      proof.owner_run_id === String(checkpoint.ownerRunId) &&
      proof.owner_step_sequence === checkpoint.ownerStepSequence &&
      proof.operation_id === checkpoint.activationOperationId &&
      proof.epoch_id.length > 0 &&
      /^sha256:[0-9a-f]{64}$/.test(proof.baseline_fingerprint)
    ) {
      const epoch = await this.promptSurface.readEpoch(
        checkpoint.ownerRunId,
        proof.epoch_id as import("@caelush/agent").PromptSurfaceEpochId,
      );
      const baseline = epoch?.records?.[0];
      const sectionStates =
        baseline?.kind === "BASELINE"
          ? applyPromptSurfaceSectionUpdates([], "BASELINE", baseline.updates)
          : undefined;
      return (
        epoch !== undefined &&
        epoch.formatVersion === 3 &&
        String(epoch.runId) === String(checkpoint.ownerRunId) &&
        String(epoch.epochId) === proof.epoch_id &&
        epoch.resetReason === "COMPACTION_COMMITTED" &&
        epoch.createdStepSequence === checkpoint.ownerStepSequence &&
        baseline !== undefined &&
        baseline.ordinal === 1 &&
        baseline.kind === "BASELINE" &&
        baseline.sourceStepSequence === checkpoint.ownerStepSequence &&
        sectionStates !== undefined &&
        createPromptSurfaceActivationFingerprint({
          newEpoch: promptSurfaceEpochIdentity(epoch),
          baseline,
          expectedSectionStates: sectionStates,
        }) === proof.baseline_fingerprint
      );
    }
    return false;
  }
}

function decodeCompletion(row: HistoricalCompletionRow): RunEvent {
  try {
    return RUN_EVENT_SCHEMA_REGISTRY.parse(JSON.parse(row.data_json));
  } catch (error) {
    throw new StorageDecodeError("RunEvent", row.event_id, "agent_events", { cause: error });
  }
}

function matchesV1CompletionPayload(
  event: Extract<RunEvent, { readonly type: "context.compaction.completed" }>,
  checkpoint: ContextCheckpointRecordV2,
): boolean {
  if (event.schemaVersion !== 1) return false;
  return (
    canonicalJsonText(event.payload as never) ===
    canonicalJsonText({
      checkpointId: String(checkpoint.checkpointId),
      reason: checkpoint.reason,
      sourceSequenceFrom: checkpoint.sourceRange.firstSequence,
      sourceSequenceTo: checkpoint.sourceRange.lastSequence,
      tokensBefore: checkpoint.tokensBefore,
      tokensAfter: checkpoint.tokensAfter,
      degraded: checkpoint.degraded,
    } as never)
  );
}

function sectionContainsCheckpoint(content: string, checkpoint: unknown): boolean {
  const cdata = /<!\[CDATA\[([\s\S]*)\]\]>/.exec(content)?.[1];
  if (cdata === undefined) return false;
  const restored = cdata.replaceAll("]]]]><![CDATA[>", "]]>");
  const prefix = "RECOVERY SUMMARY (NON-AUTHORITATIVE): ";
  if (!restored.startsWith(prefix)) return false;
  try {
    const serialized = JSON.parse(restored.slice(prefix.length)) as unknown;
    return canonicalJsonText(serialized as never) === canonicalJsonText(checkpoint as never);
  } catch {
    return false;
  }
}
