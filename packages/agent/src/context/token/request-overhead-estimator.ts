import type { AIToolSpec, ModelDescriptor } from "@caelush/ai";

import {
  createUtf8HeuristicTokenEstimator,
  type ContextTokenEstimatorPort,
} from "./context-token-estimator.js";

export interface ContextRequestOverhead {
  readonly toolSchemaTokens: number;
  readonly protocolOverheadTokens: number;
  readonly totalTokens: number;
}

export interface ContextRequestOverheadEstimatorPort {
  estimate(input: {
    readonly model: ModelDescriptor;
    readonly tools: readonly AIToolSpec[];
  }): ContextRequestOverhead;
}

export interface ContextRequestOverheadEstimatorOptions {
  readonly tokenEstimator?: ContextTokenEstimatorPort;
  readonly protocolOverheadTokens?: number;
}

export function createContextRequestOverheadEstimator(
  options: ContextRequestOverheadEstimatorOptions = {},
): ContextRequestOverheadEstimatorPort {
  const tokenEstimator = options.tokenEstimator ?? createUtf8HeuristicTokenEstimator();
  const protocolOverheadTokens = options.protocolOverheadTokens ?? 0;
  assertNonNegativeSafeInteger(protocolOverheadTokens, "protocolOverheadTokens");
  return Object.freeze({
    estimate(input: {
      readonly model: ModelDescriptor;
      readonly tools: readonly AIToolSpec[];
    }): ContextRequestOverhead {
      let toolSchemaTokens = 0;
      for (const tool of input.tools)
        toolSchemaTokens += tokenEstimator.estimateAIToolSpec(tool, input.model);
      const totalTokens = toolSchemaTokens + protocolOverheadTokens;
      if (!Number.isSafeInteger(totalTokens))
        throw new RangeError("Request overhead exceeds safe integer range.");
      return Object.freeze({ toolSchemaTokens, protocolOverheadTokens, totalTokens });
    },
  });
}

export function assertContextRequestOverhead(
  value: unknown,
): asserts value is ContextRequestOverhead {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Context request overhead must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  for (const key of ["toolSchemaTokens", "protocolOverheadTokens", "totalTokens"]) {
    if (!Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0) {
      throw new TypeError(`Context request overhead ${key} must be a non-negative safe integer.`);
    }
  }
  if (
    (candidate.toolSchemaTokens as number) + (candidate.protocolOverheadTokens as number) !==
    candidate.totalTokens
  ) {
    throw new TypeError("Context request overhead totalTokens must equal its components.");
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new RangeError(`${label} must be a non-negative safe integer.`);
}
