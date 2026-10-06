/** Provider counters observed in OpenAI-compatible raw usage chunks. */
export interface OpenAICompatibleRawUsage {
  readonly promptTokens?: number;
  readonly cacheHitTokens?: number;
  readonly cacheMissTokens?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
}

/** Parse only cache-relevant and durable-token counters from one raw usage object. */
export function parseOpenAICompatibleRawUsage(
  value: unknown,
): OpenAICompatibleRawUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("OpenAI-compatible usage was malformed.");

  const promptDetails = readOptionalRecord(value, "prompt_tokens_details");
  const completionDetails = readOptionalRecord(value, "completion_tokens_details");
  const providerHitTokens = readCount(value, "prompt_cache_hit_tokens");
  const standardHitTokens =
    promptDetails === undefined ? undefined : readCount(promptDetails, "cached_tokens");
  const promptTokens = readCount(value, "prompt_tokens");
  const cacheMissTokens = readCount(value, "prompt_cache_miss_tokens");
  const completionTokens = readCount(value, "completion_tokens");
  const reasoningTokens =
    completionDetails === undefined ? undefined : readCount(completionDetails, "reasoning_tokens");

  if (
    providerHitTokens !== undefined &&
    standardHitTokens !== undefined &&
    providerHitTokens !== standardHitTokens
  ) {
    throw new Error("OpenAI-compatible cache-hit counters disagreed.");
  }
  const cacheHitTokens = providerHitTokens ?? standardHitTokens;

  const usage: OpenAICompatibleRawUsage = {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(cacheHitTokens === undefined ? {} : { cacheHitTokens }),
    ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };

  return Object.keys(usage).length === 0 ? undefined : usage;
}

function readOptionalRecord(
  record: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("OpenAI-compatible usage details were malformed.");
  return value;
}

function readCount(record: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("OpenAI-compatible usage counter was invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
