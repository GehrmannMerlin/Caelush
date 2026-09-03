export type ContextItemType =
  | "GOAL"
  | "EXECUTION_UNIT"
  | "CHECKPOINT"
  | "WORLD_STATE"
  | "OBSERVATION"
  | "MEMORY"
  | "RELEVANT_FILE"
  | "EPHEMERAL";

export type ContextRetention =
  "PINNED" | "REHYDRATABLE" | "RECENT" | "COMPRESSIBLE" | "RETRIEVABLE" | "EPHEMERAL";

export type ContextPriorityClass = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
export type ContextCacheStability = "STABLE" | "SEMI_STABLE" | "DYNAMIC";
export type ContextSensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE";

export interface ContextItem {
  readonly id: string;
  readonly type: ContextItemType;
  readonly sourceRef: string;
  readonly scope: "RUN" | "PROJECT" | "GLOBAL";
  readonly retention: ContextRetention;
  readonly priorityClass: ContextPriorityClass;
  readonly tokenEstimate: number;
  readonly cacheStability: ContextCacheStability;
  readonly freshness: "CURRENT" | "STALE" | "UNKNOWN";
  readonly sensitivity: ContextSensitivity;
  readonly atomicGroupId?: string;
  readonly whyLoaded: string;
  readonly createdSequence: number;
  readonly updatedSequence: number;
  readonly content?: string;
  readonly contentRef?: string;
}

export function createContextItem(input: ContextItem): ContextItem {
  if (input.id.trim() === "" || input.sourceRef.trim() === "") {
    throw new RangeError("ContextItem id and sourceRef must not be empty");
  }
  if (!Number.isSafeInteger(input.tokenEstimate) || input.tokenEstimate < 0) {
    throw new RangeError("ContextItem tokenEstimate must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(input.createdSequence) ||
    !Number.isSafeInteger(input.updatedSequence)
  ) {
    throw new RangeError("ContextItem sequences must be safe integers");
  }
  return Object.freeze({
    ...input,
    ...(input.content === undefined ? {} : { content: input.content }),
  });
}
