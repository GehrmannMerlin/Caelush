import type { RunId } from "@caelush/protocol";

import { assertPromptSurfaceEpochWithSnapshots } from "./prompt-surface.js";
import type { PromptSurfaceAnchor, PromptSurfaceEpochWithSnapshots } from "./prompt-surface.js";

export interface PromptSurfaceModelMessage {
  readonly role: "user";
  readonly content: string;
  readonly source: {
    readonly kind: "RUNTIME_CONTEXT_SNAPSHOT";
    readonly runId: RunId;
    readonly epochId: string;
    readonly ordinal: number;
    readonly anchor: PromptSurfaceAnchor;
    readonly sourceStepSequence: number;
    readonly contentHash: string;
  };
}

const EMPTY_PROJECTION: readonly PromptSurfaceModelMessage[] = Object.freeze([]);

/** Project one complete, verified Prompt Surface into sourced user-role model input. */
export function projectPromptSurface(
  surface: PromptSurfaceEpochWithSnapshots | undefined,
): readonly PromptSurfaceModelMessage[] {
  if (surface === undefined) return EMPTY_PROJECTION;
  assertPromptSurfaceEpochWithSnapshots(surface);

  return Object.freeze(
    surface.snapshots.map((snapshot) =>
      Object.freeze({
        role: "user" as const,
        content: snapshot.content,
        source: Object.freeze({
          kind: snapshot.kind,
          runId: snapshot.runId,
          epochId: snapshot.epochId,
          ordinal: snapshot.ordinal,
          anchor: snapshot.anchor,
          sourceStepSequence: snapshot.sourceStepSequence,
          contentHash: snapshot.contentHash,
        }),
      }),
    ),
  );
}
