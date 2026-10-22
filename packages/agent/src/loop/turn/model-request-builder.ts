import { validateAIModelRequest } from "@caelush/ai";
import type {
  AIModelRequest,
  AIModelSettings,
  AIToolChoice,
  AIToolSpec,
  ModelDescriptor,
} from "@caelush/ai";

import type { PreparedModelContext } from "../types.js";
import type { ContextRequestBudget } from "../types.js";
import { resolveAdaptiveContextBudget } from "../../context/policy/context-policy.js";
import { computeRequestHeadroom } from "../../context/policy/request-headroom.js";

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
  if (requestBudget.version === "TURN_BUDGET_V3") {
    return resolveTurnBudgetSettings(input, requestBudget);
  }

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

/**
 * The `HEADROOM_V1` request settings.
 *
 * ```text
 * wire maxOutputTokens === the allowance the Context budgeted
 * ```
 *
 * There is no fallback here on purpose. Under `LEGACY_FULL_OUTPUT_V1` the reserve was the model's
 * whole output capability and the wire inherited it; under `ADAPTIVE_V1` the builder could cap the
 * wire below the reserved value. Both left "what the context reserved" and "what the provider was
 * allowed to emit" as two numbers that only happened to agree. This one number is computed once per
 * turn and is used unchanged, and the pre-request invariant is re-checked against the *prepared*
 * input rather than a preview.
 */
function resolveTurnBudgetSettings(
  input: ModelRequestBuilderInput,
  requestBudget: Extract<ContextRequestBudget, { version: "TURN_BUDGET_V3" }>,
): AIModelSettings {
  const { report } = input.context;
  const allowance = requestBudget.outputAllowanceTokens;
  assertPositiveSafeInteger(allowance, "outputAllowanceTokens");
  assertPositiveSafeInteger(requestBudget.safetyReserveTokens, "safetyReserveTokens");
  assertPositiveSafeInteger(requestBudget.expectedGrowthTokens, "expectedGrowthTokens");
  assertNonNegativeSafeInteger(report.estimatedInputTokens, "estimatedInputTokens");
  assertNonNegativeSafeInteger(report.requestOverheadTokens, "requestOverheadTokens");
  if (allowance > input.model.limits.maxOutputTokens) {
    throw new RangeError("Turn output allowance exceeds the model's output ceiling.");
  }
  const expectedInputLimit =
    input.model.limits.contextWindowTokens -
    allowance -
    requestBudget.safetyReserveTokens -
    report.requestOverheadTokens;
  if (report.effectiveInputLimitTokens !== expectedInputLimit) {
    throw new RangeError("Prepared context request budget does not match its turn allowance.");
  }
  const headroom = computeRequestHeadroom({
    windowTokens: input.model.limits.contextWindowTokens,
    fullInputTokens: report.estimatedInputTokens + report.requestOverheadTokens,
    outputAllowanceTokens: allowance,
    safetyTokens: requestBudget.safetyReserveTokens,
    expectedGrowthTokens: requestBudget.expectedGrowthTokens,
  });
  if (!headroom.fitsCurrentRequest) {
    throw new RangeError("Prepared context does not fit the turn's hard window constraint.");
  }
  // A narrower explicit generation preference can only lower the wire value; the Engine has already
  // clamped the allowance to it, so this is a consistency check rather than a second decision.
  const explicit = input.settings?.maxOutputTokens;
  return {
    ...input.settings,
    maxOutputTokens: explicit === undefined ? allowance : Math.min(explicit, allowance),
  };
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}
