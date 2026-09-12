import type { ModelUsage } from "@caelush/ai";

export interface NormalizedLLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly confidence: "EXACT" | "CONSERVATIVE" | "UNKNOWN";
  readonly exceedsReservation?: boolean;
}

export function normalizeLLMUsageForBudget(
  usage: ModelUsage | undefined,
  reservation: { readonly reservedTotalTokens?: number } = {},
): NormalizedLLMUsage {
  if (usage === undefined) return { confidence: "UNKNOWN" };
  const inputTokens = safeField(usage.inputTokens);
  const outputTokens = safeField(usage.outputTokens);
  const reportedTotal = safeField(usage.totalTokens);
  if (
    (usage.inputTokens !== undefined && inputTokens === undefined) ||
    (usage.outputTokens !== undefined && outputTokens === undefined) ||
    (usage.totalTokens !== undefined && reportedTotal === undefined) ||
    (usage.cachedInputTokens !== undefined && safeField(usage.cachedInputTokens) === undefined) ||
    (usage.reasoningTokens !== undefined && safeField(usage.reasoningTokens) === undefined)
  ) {
    return { confidence: "CONSERVATIVE" };
  }

  const splitTotal =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : safeSum(inputTokens, outputTokens);
  let totalTokens = reportedTotal ?? splitTotal;
  let confidence: NormalizedLLMUsage["confidence"] = "EXACT";
  if (reportedTotal !== undefined && splitTotal !== undefined && reportedTotal !== splitTotal) {
    totalTokens = Math.max(reportedTotal, splitTotal);
    confidence = "CONSERVATIVE";
  } else if (totalTokens === undefined) {
    confidence = "CONSERVATIVE";
  }
  const result: NormalizedLLMUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    confidence,
    ...(totalTokens !== undefined &&
    reservation.reservedTotalTokens !== undefined &&
    totalTokens > reservation.reservedTotalTokens
      ? { exceedsReservation: true }
      : {}),
  };
  return result;
}

function safeField(value: number | undefined): number | undefined {
  return value === undefined || !Number.isSafeInteger(value) || value < 0 ? undefined : value;
}

function safeSum(left: number, right: number): number | undefined {
  if (left > Number.MAX_SAFE_INTEGER - right) return undefined;
  return left + right;
}
