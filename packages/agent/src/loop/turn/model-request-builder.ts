import { validateAIModelRequest } from "@caelush/ai";
import type {
  AIModelRequest,
  AIModelSettings,
  AIToolChoice,
  AIToolSpec,
  ModelDescriptor,
} from "@caelush/ai";

import type { PreparedModelContext } from "../types.js";
import { resolveAdaptiveContextBudget } from "../../context/policy/context-policy.js";

/**
 * The frozen model request builder contract.
 *
 * It turns a prepared context plus a model authority into one provider-independent
 * {@link AIModelRequest}. It is a pure function of its input: no clock, no identifier
 * factory, no catalog lookup, no filesystem and no provider dialect.
 *
 * Two rules are frozen here because they are correctness rules, not conveniences:
 *
 * ```text
 * tools present      → toolChoice defaults to AUTO
 * tools absent/empty → no toolChoice at all
 * ```
 *
 * and one absence is frozen too:
 *
 * ```text
 * provider-native cache
 * ```
 *
 * Provider cache control is a dialect concern. It belongs to the AI adapter that speaks
 * that dialect, and it must never appear in a provider-independent builder — a
 * `cache_control` marker or a cache point emitted here would be one provider's wire
 * format leaking into the general kernel.
 */
export interface ModelRequestBuilderInput {
  readonly context: PreparedModelContext;
  readonly model: ModelDescriptor;
  readonly tools: readonly AIToolSpec[];
  readonly settings?: AIModelSettings;
}

/** Build one model request from prepared context and a resolved model authority. */
export interface ModelRequestBuilder {
  build(input: ModelRequestBuilderInput): AIModelRequest;
}

/** Create the frozen model request builder. */
export function createModelRequestBuilder(): ModelRequestBuilder {
  return {
    build(input: ModelRequestBuilderInput): AIModelRequest {
      return buildModelRequest(input);
    },
  };
}

/**
 * Build one provider-independent model request.
 *
 * Tool order is the caller's catalog order and is never sorted, so a stable tool prefix
 * stays byte-identical across turns. The request is validated against the resolved
 * descriptor, which is what rejects a capability the model does not have, a tool
 * definition the request shape cannot carry, or an output ceiling above the model's own.
 */
export function buildModelRequest(input: ModelRequestBuilderInput): AIModelRequest {
  const tools = input.tools.length === 0 ? undefined : input.tools;
  const toolChoice: AIToolChoice | undefined = tools === undefined ? undefined : { type: "AUTO" };
  const settings = resolveRequestSettings(input);

  const request: AIModelRequest = {
    model: input.model.ref,
    messages: input.context.messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(settings === undefined ? {} : { settings }),
  };

  validateAIModelRequest(request, input.model);
  return request;
}

function resolveRequestSettings(input: ModelRequestBuilderInput): AIModelSettings | undefined {
  const { requestBudget, report } = input.context;
  if (requestBudget.version === "LEGACY_FULL_OUTPUT_V1") return input.settings;

  assertPositiveSafeInteger(requestBudget.outputReserveTokens, "outputReserveTokens");
  assertPositiveSafeInteger(requestBudget.safetyReserveTokens, "safetyReserveTokens");
  assertNonNegativeSafeInteger(report.estimatedInputTokens, "estimatedInputTokens");
  assertNonNegativeSafeInteger(report.requestOverheadTokens, "requestOverheadTokens");

  const resolvedBudget = resolveAdaptiveContextBudget({
    contextWindowTokens: input.model.limits.contextWindowTokens,
    maxOutputTokens: input.model.limits.maxOutputTokens,
    ...(input.settings?.maxOutputTokens === undefined
      ? {}
      : { configuredOutputCeiling: input.settings.maxOutputTokens }),
    requestOverheadTokens: report.requestOverheadTokens,
  });
  if (
    requestBudget.outputReserveTokens !== resolvedBudget.outputReserveTokens ||
    requestBudget.safetyReserveTokens !== resolvedBudget.safetyReserveTokens ||
    report.effectiveInputLimitTokens !== resolvedBudget.effectiveInputLimitTokens
  ) {
    throw new RangeError("Prepared context request budget does not match its resolved policy.");
  }

  const contextOutputHeadroom =
    input.model.limits.contextWindowTokens -
    report.estimatedInputTokens -
    report.requestOverheadTokens -
    requestBudget.safetyReserveTokens;
  if (!Number.isSafeInteger(contextOutputHeadroom) || contextOutputHeadroom <= 0) {
    throw new RangeError("Prepared context leaves no positive output headroom.");
  }
  const contextOutputCap = Math.min(resolvedBudget.preferredOutputCeiling, contextOutputHeadroom);
  const currentOutputCeiling =
    input.settings?.maxOutputTokens ?? input.model.limits.maxOutputTokens;
  if (contextOutputCap >= currentOutputCeiling) return input.settings;

  return {
    ...input.settings,
    maxOutputTokens: contextOutputCap,
  };
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
