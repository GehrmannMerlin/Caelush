export interface ContextBuildTraceInput {
  readonly [key: string]: unknown;
  readonly contextWindow: number;
  readonly effectiveInputLimit: number;
  readonly estimatedInputTokens: number;
  readonly systemTokens: number;
  readonly goalTokens: number;
  readonly checkpointTokens: number;
  readonly recentTailTokens: number;
  readonly projectTokens: number;
  readonly fileTokens: number;
  readonly observationTokens: number;
  readonly memoryTokens: number;
  /**
   * The Tool guidance block's own token estimate.
   *
   * Present because Phase 4E moved Coding Tool guidance out of the provider-visible tool description
   * and into this build. It is a *subset* of `systemTokens` — the block is part of the system message —
   * and it is reported separately so a reader can see how much of the system context is guidance
   * rather than project facts.
   *
   * Optional and defaulting to `0` so an existing trace input that predates the field keeps compiling
   * and keeps meaning what it meant: no guidance block.
   */
  readonly toolGuidanceTokens?: number;
  readonly droppedItems: number;
  readonly truncatedItems: number;
  readonly pressureRatio: number;
  readonly checkpointId?: string;
  readonly compactionCount: number;
  readonly loadedFileCount: number;
  readonly observationCount: number;
}

export interface ContextBuildTrace {
  readonly contextWindow: number;
  readonly effectiveInputLimit: number;
  readonly estimatedInputTokens: number;
  readonly systemTokens: number;
  readonly goalTokens: number;
  readonly checkpointTokens: number;
  readonly recentTailTokens: number;
  readonly projectTokens: number;
  readonly fileTokens: number;
  readonly observationTokens: number;
  readonly memoryTokens: number;
  readonly toolGuidanceTokens: number;
  readonly droppedItems: number;
  readonly truncatedItems: number;
  readonly pressureRatio: number;
  readonly checkpointId?: string;
  readonly compactionCount: number;
  readonly loadedFileCount: number;
  readonly observationCount: number;
}

export function createContextBuildTrace(input: ContextBuildTraceInput): ContextBuildTrace {
  const toolGuidanceTokens = input.toolGuidanceTokens ?? 0;
  const numeric = [
    "contextWindow",
    "effectiveInputLimit",
    "estimatedInputTokens",
    "systemTokens",
    "goalTokens",
    "checkpointTokens",
    "recentTailTokens",
    "projectTokens",
    "fileTokens",
    "observationTokens",
    "memoryTokens",
    "droppedItems",
    "truncatedItems",
    "compactionCount",
    "loadedFileCount",
    "observationCount",
  ] as const;
  for (const key of numeric) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new RangeError(`${key} must be a non-negative safe integer`);
    }
  }
  if (!Number.isSafeInteger(toolGuidanceTokens) || toolGuidanceTokens < 0) {
    throw new RangeError("toolGuidanceTokens must be a non-negative safe integer");
  }
  if (!Number.isFinite(input.pressureRatio) || input.pressureRatio < 0) {
    throw new RangeError("pressureRatio must be non-negative");
  }
  return Object.freeze({
    contextWindow: input.contextWindow,
    effectiveInputLimit: input.effectiveInputLimit,
    estimatedInputTokens: input.estimatedInputTokens,
    systemTokens: input.systemTokens,
    goalTokens: input.goalTokens,
    checkpointTokens: input.checkpointTokens,
    recentTailTokens: input.recentTailTokens,
    projectTokens: input.projectTokens,
    fileTokens: input.fileTokens,
    observationTokens: input.observationTokens,
    memoryTokens: input.memoryTokens,
    toolGuidanceTokens,
    droppedItems: input.droppedItems,
    truncatedItems: input.truncatedItems,
    pressureRatio: input.pressureRatio,
    ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
    compactionCount: input.compactionCount,
    loadedFileCount: input.loadedFileCount,
    observationCount: input.observationCount,
  });
}
