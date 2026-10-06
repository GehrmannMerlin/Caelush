import type { RunId } from "@caelush/protocol";

import type {
  PromptSurfaceEpoch,
  PromptSurfaceEpochId,
  PromptSurfaceEpochWithSnapshots,
  PromptSurfaceSnapshot,
} from "./prompt-surface.js";

export type PromptSurfaceAppendResult = "APPENDED" | "IDEMPOTENT";

/** Durable host port for the run-scoped model-input projection. */
export interface PromptSurfaceStorePort {
  getCurrent(runId: RunId): Promise<PromptSurfaceEpoch | undefined>;
  createEpoch(epoch: PromptSurfaceEpoch): Promise<void>;
  /**
   * Append only while the caller's freshly computed current identity still matches the frozen
   * persisted epoch. Callers must not copy this identity from storage without comparing it with the
   * current model, tool schema, stable head, and cache settings.
   */
  appendSnapshot(
    snapshot: PromptSurfaceSnapshot,
    expectedCurrentEpoch: PromptSurfaceEpoch,
  ): Promise<PromptSurfaceAppendResult>;
  readEpoch(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
  ): Promise<PromptSurfaceEpochWithSnapshots | undefined>;
}
