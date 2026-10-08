import type { RunId } from "@caelush/protocol";

import { assertPromptSurfaceEpochWithSnapshots } from "./prompt-surface.js";
import type { PromptSurfaceAnchor, PromptSurfaceEpochWithSnapshots } from "./prompt-surface.js";
import { renderPromptSurfaceRecord } from "./prompt-surface-v3.js";

export interface PromptSurfaceModelMessage {
  readonly role: "user";
  readonly content: string;
  readonly source: {
    readonly kind:
      "RUNTIME_CONTEXT_SNAPSHOT" | "RUNTIME_CONTEXT_BASELINE" | "RUNTIME_CONTEXT_DELTA";
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

  if (surface.formatVersion === 3) {
    return Object.freeze(
      (surface.records ?? [])
        .filter((record) => record.kind !== "NOOP")
        .map((record) =>
          Object.freeze({
            role: "user" as const,
            content: renderPromptSurfaceRecord(record.kind as "BASELINE" | "DELTA", record.updates),
            source: Object.freeze({
              kind:
                record.kind === "BASELINE"
                  ? ("RUNTIME_CONTEXT_BASELINE" as const)
                  : ("RUNTIME_CONTEXT_DELTA" as const),
              runId: record.runId,
              epochId: record.epochId,
              ordinal: record.ordinal,
              anchor: record.anchor,
              sourceStepSequence: record.sourceStepSequence,
              contentHash: record.contentHash,
            }),
          }),
        ),
    );
  }

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
