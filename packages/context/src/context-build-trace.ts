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
  readonly droppedItems: number;
  readonly truncatedItems: number;
  readonly pressureRatio: number;
  readonly checkpointId?: string;
  readonly compactionCount: number;
  readonly loadedFileCount: number;
  readonly observationCount: number;
}

export function createContextBuildTrace(input: ContextBuildTraceInput): ContextBuildTrace {
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
    droppedItems: input.droppedItems,
    truncatedItems: input.truncatedItems,
    pressureRatio: input.pressureRatio,
    ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
    compactionCount: input.compactionCount,
    loadedFileCount: input.loadedFileCount,
    observationCount: input.observationCount,
  });
}
