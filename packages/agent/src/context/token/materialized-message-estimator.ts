import type { AIMessage, ModelDescriptor } from "@caelush/ai";

import type { ContextTokenEstimatorPort } from "./context-token-estimator.js";

/**
 * The one price of a provider-shaped message sequence.
 *
 * Both the Context report and the pre-selection candidate estimate must price **the same object**:
 * the sequence the provider will receive. Pricing the durable record instead charged message ids,
 * run/session ids, observation references and projection fingerprints that never reach the wire — a
 * 1M-token window could then look exhausted while the real request still had 200k of room.
 *
 * `stableJson` keeps the byte count deterministic across key order, so two turns that send the same
 * messages price identically.
 */
export function estimateAIMessages(
  messages: readonly AIMessage[],
  model: ModelDescriptor,
  estimator: ContextTokenEstimatorPort,
): number {
  const estimate = messages.length === 0 ? 0 : estimator.estimateText(stableJson(messages), model);
  if (!Number.isSafeInteger(estimate) || estimate < 0) {
    throw new TypeError("Materialized token estimate is invalid.");
  }
  return estimate;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
