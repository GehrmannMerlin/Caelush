import { describe, expect, it } from "vitest";

import {
  assertModelUsage,
  MODEL_USAGE_FIELDS,
  normalizeModelUsage,
} from "../src/models/model-usage.js";
import type { ModelUsage } from "../src/models/model-usage.js";

const completeUsage = {
  inputTokens: 1_000,
  outputTokens: 100,
  totalTokens: 1_100,
  cachedInputTokens: 970,
  reasoningTokens: 10,
  cacheMissInputTokens: 30,
  cacheWriteInputTokens: 7,
} as ModelUsage;

describe("ModelUsage cache buckets", () => {
  it("validates and normalizes all provider-neutral usage fields in canonical order", () => {
    expect(() => assertModelUsage(completeUsage)).not.toThrow();
    expect(MODEL_USAGE_FIELDS).toEqual([
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cachedInputTokens",
      "reasoningTokens",
      "cacheMissInputTokens",
      "cacheWriteInputTokens",
    ]);
    expect(normalizeModelUsage(completeUsage)).toEqual(completeUsage);
    expect(Object.keys(normalizeModelUsage(completeUsage) ?? {})).toEqual(MODEL_USAGE_FIELDS);
  });

  it.each([
    { cacheMissInputTokens: -1 },
    { cacheMissInputTokens: 1.5 },
    { cacheWriteInputTokens: -1 },
    { cacheWriteInputTokens: 1.5 },
  ])("rejects invalid cache counters: %o", (counters) => {
    expect(() => assertModelUsage({ ...completeUsage, ...counters })).toThrow(TypeError);
  });

  it("rejects unknown fields rather than silently changing the usage contract", () => {
    expect(() => assertModelUsage({ ...completeUsage, providerCacheTokens: 5 })).toThrow(TypeError);
  });
});
