import {
  assertPromptSurfaceEpoch,
  assertPromptSurfaceEpochWithSnapshots,
  assertPromptSurfaceSnapshot,
  type PromptSurfaceEpoch,
  type PromptSurfaceEpochId,
  type PromptSurfaceEpochWithSnapshots,
  type PromptSurfaceStorePort,
} from "@caelush/agent";
import type { RunId } from "@caelush/protocol";

export interface PromptSurfaceMemoryStore extends PromptSurfaceStorePort {
  inspect(runId: RunId): PromptSurfaceEpochWithSnapshots | undefined;
  corruptLatestSnapshot(runId: RunId): void;
}

/** A small deterministic test double for the production storage port. */
export function createPromptSurfaceMemoryStore(): PromptSurfaceMemoryStore {
  const byRun = new Map<string, PromptSurfaceEpochWithSnapshots[]>();
  return {
    inspect(runId) {
      return byRun.get(runId)?.at(-1);
    },
    corruptLatestSnapshot(runId) {
      const epochs = byRun.get(runId);
      const current = epochs?.at(-1);
      const lastSnapshot = current?.snapshots.at(-1);
      if (epochs === undefined || current === undefined || lastSnapshot === undefined) {
        throw new Error("no Prompt Surface snapshot to corrupt");
      }
      const corrupted = Object.freeze({
        ...current,
        snapshots: Object.freeze([
          ...current.snapshots.slice(0, -1),
          Object.freeze({ ...lastSnapshot, content: `${lastSnapshot.content} corrupted` }),
        ]),
      });
      epochs[epochs.length - 1] = corrupted;
    },
    async getCurrent(runId) {
      const current = byRun.get(runId)?.at(-1);
      if (current === undefined) return undefined;
      return {
        runId: current.runId,
        epochId: current.epochId,
        modelRef: current.modelRef,
        stableHeadFingerprint: current.stableHeadFingerprint,
        toolSchemaFingerprint: current.toolSchemaFingerprint,
        cacheSettingsFingerprint: current.cacheSettingsFingerprint,
        resetReason: current.resetReason,
        createdStepSequence: current.createdStepSequence,
        createdAt: current.createdAt,
      };
    },
    async createEpoch(epoch) {
      assertPromptSurfaceEpoch(epoch);
      const epochs = byRun.get(epoch.runId) ?? [];
      const existing = epochs.find((candidate) => candidate.epochId === epoch.epochId);
      if (existing !== undefined) {
        if (!sameEpoch(existing, epoch)) throw new Error("test epoch conflict");
        return;
      }
      if ((epochs.at(-1)?.createdStepSequence ?? 0) > epoch.createdStepSequence) {
        throw new Error("test epoch sequence moved backwards");
      }
      epochs.push(Object.freeze({ ...epoch, snapshots: Object.freeze([]) }));
      byRun.set(epoch.runId, epochs);
    },
    async appendSnapshot(snapshot, expectedCurrentEpoch) {
      assertPromptSurfaceSnapshot(snapshot);
      const current = byRun.get(snapshot.runId)?.at(-1);
      if (
        current === undefined ||
        current.epochId !== expectedCurrentEpoch.epochId ||
        current.epochId !== snapshot.epochId
      ) {
        throw new Error("test append did not target the current epoch");
      }
      const existing = current.snapshots.find(
        (candidate) => candidate.sourceStepSequence === snapshot.sourceStepSequence,
      );
      if (existing !== undefined) {
        if (
          existing.contentHash !== snapshot.contentHash ||
          !sameAnchor(existing.anchor, snapshot.anchor)
        ) {
          throw new Error("test source Step snapshot conflict");
        }
        return "IDEMPOTENT";
      }
      const updated = Object.freeze({
        ...current,
        snapshots: Object.freeze([...current.snapshots, snapshot]),
      });
      assertPromptSurfaceEpochWithSnapshots(updated);
      const epochs = byRun.get(snapshot.runId)!;
      epochs[epochs.length - 1] = updated;
      return "APPENDED";
    },
    async readEpoch(runId: RunId, epochId: PromptSurfaceEpochId) {
      return byRun.get(runId)?.find((candidate) => candidate.epochId === epochId);
    },
  };
}

function sameAnchor(
  left: PromptSurfaceEpochWithSnapshots["snapshots"][number]["anchor"],
  right: PromptSurfaceEpochWithSnapshots["snapshots"][number]["anchor"],
): boolean {
  return (
    left.messageId === right.messageId &&
    left.runId === right.runId &&
    left.conversationTurnId === right.conversationTurnId &&
    left.sequence === right.sequence
  );
}

function sameEpoch(left: PromptSurfaceEpoch, right: PromptSurfaceEpoch): boolean {
  return (
    left.runId === right.runId &&
    left.epochId === right.epochId &&
    left.createdStepSequence === right.createdStepSequence &&
    left.resetReason === right.resetReason &&
    left.stableHeadFingerprint === right.stableHeadFingerprint &&
    left.toolSchemaFingerprint === right.toolSchemaFingerprint &&
    left.cacheSettingsFingerprint === right.cacheSettingsFingerprint &&
    left.modelRef.provider === right.modelRef.provider &&
    left.modelRef.model === right.modelRef.model
  );
}
