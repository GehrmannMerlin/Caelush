import { describeValue } from "../internal/assertions.js";
import { AIError, createAIError } from "../errors/ai-error.js";
import { assertAIMessages } from "../messages/message.js";
import { assertAIModelRequestShape } from "./model-request.js";
import { assertAIModelSettings } from "./model-settings.js";
import { assertAIToolChoice } from "./tool-choice.js";
import { assertModelDescriptor, assertModelRef } from "../models/model-descriptor.js";
import { assertAIToolSpec } from "../tools/tool-spec.js";
import type { AIErrorContext } from "../errors/ai-error.js";
import type { AIModelRequest } from "./model-request.js";
import type { ModelDescriptor } from "../models/model-descriptor.js";

/**
 * Validate a request without consulting a model descriptor.
 *
 * This is preflight step 1 plus the descriptor-free part of step 7: the request
 * shape, the message list, the tool catalog, the tool choice and the caller's own
 * numeric bounds. It runs *before* the catalog is consulted, because a malformed
 * request must be rejected whether or not the model exists.
 */
export function validateAIModelRequestShape(request: unknown): asserts request is AIModelRequest {
  const context: AIErrorContext = {};

  translateShapeFailures(context, () => {
    assertAIModelRequestShape(request);
  });

  const candidate = request as AIModelRequest;

  translateShapeFailures(context, () => {
    assertModelRef(candidate.model);
  });

  translateShapeFailures(context, () => {
    assertAIMessages(candidate.messages);
  });

  const tools = validateTools(candidate, context);
  validateToolChoice(candidate, tools, context);
  validateSettings(candidate, context);
}

/**
 * Validate a request against its resolved model descriptor.
 *
 * This is preflight steps 8 and 11: capability rejection and the model's own
 * output ceiling. Cache support is deliberately *not* checked here — an
 * unsupported cache request is a downgrade, never a request failure.
 */
export function validateAIModelRequestAgainstModel(
  request: AIModelRequest,
  model: ModelDescriptor,
): void {
  assertModelDescriptor(model);
  const context: AIErrorContext = { providerId: model.ref.provider, model: model.ref };
  const toolNames = (request.tools ?? []).map((tool) => tool.name);

  validateToolCapability(model, toolNames, context);
  validateReasoningCapability(model, request, context);
  validateMaxOutputTokens(model, request, context);
}

/**
 * The complete cross-field semantic validation: request shape, then model fit.
 *
 * The gateway runs the two phases separately because the frozen preflight order
 * validates the request before it resolves the model. This composition exists for
 * callers that already hold a descriptor.
 */
export function validateAIModelRequest(
  request: unknown,
  model: ModelDescriptor,
): asserts request is AIModelRequest {
  validateAIModelRequestShape(request);
  validateAIModelRequestAgainstModel(request, model);
}

/**
 * Validate the tool catalog and return the declared tool names.
 *
 * Duplicate names are a configuration error: a `TOOL` choice or a returned tool
 * call would be ambiguous, and silently keeping one of them would make the request
 * mean something the caller did not write.
 */
function validateTools(request: AIModelRequest, context: AIErrorContext): readonly string[] {
  const tools = request.tools;
  if (tools === undefined) return [];

  translateShapeFailures(context, () => {
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new TypeError("AI model request tools must be a non-empty array when present.");
    }
    for (const tool of tools) assertAIToolSpec(tool);
  });

  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw invalid(`AI model request declares the tool "${tool.name}" more than once.`, context);
    }
    seen.add(tool.name);
    names.push(tool.name);
  }
  return names;
}

function validateToolChoice(
  request: AIModelRequest,
  toolNames: readonly string[],
  context: AIErrorContext,
): void {
  const choice = request.toolChoice;
  if (choice === undefined) return;

  translateShapeFailures(context, () => {
    assertAIToolChoice(choice);
  });

  if (choice.type === "REQUIRED" && toolNames.length === 0) {
    throw invalid("AI model request toolChoice REQUIRED requires at least one tool.", context);
  }
  if (choice.type === "TOOL") {
    if (toolNames.length === 0) {
      throw invalid("AI model request toolChoice TOOL requires at least one tool.", context);
    }
    if (!toolNames.includes(choice.toolName)) {
      throw invalid(
        `AI model request toolChoice TOOL refers to the undeclared tool "${choice.toolName}".`,
        context,
      );
    }
  }
}

function validateSettings(request: AIModelRequest, context: AIErrorContext): void {
  const settings = request.settings;
  if (settings === undefined) return;

  translateShapeFailures(context, () => {
    assertAIModelSettings(settings);
  });

  const maxOutputTokens = settings.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
  ) {
    throw invalid(
      `AI model request maxOutputTokens must be a positive safe integer, received ${describeValue(maxOutputTokens)}.`,
      context,
    );
  }

  const temperature = settings.temperature;
  if (temperature !== undefined) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
      throw invalid(
        `AI model request temperature must be a finite number, received ${describeValue(temperature)}.`,
        context,
      );
    }
    if (temperature < 0 || temperature > 2) {
      throw invalid(
        `AI model request temperature must be between 0 and 2, received ${String(temperature)}.`,
        context,
      );
    }
  }
}

function validateToolCapability(
  model: ModelDescriptor,
  toolNames: readonly string[],
  context: AIErrorContext,
): void {
  if (toolNames.length === 0) return;
  if (model.capabilities.toolCalling !== "UNSUPPORTED") return;

  throw createAIError(
    "AI_CAPABILITY_UNSUPPORTED",
    `AI model "${model.ref.model}" does not support tool calling.`,
    context,
  );
}

function validateReasoningCapability(
  model: ModelDescriptor,
  request: AIModelRequest,
  context: AIErrorContext,
): void {
  if (request.settings?.reasoning === undefined) return;
  if (model.capabilities.reasoning !== "UNSUPPORTED") return;

  throw createAIError(
    "AI_CAPABILITY_UNSUPPORTED",
    `AI model "${model.ref.model}" does not support reasoning.`,
    context,
  );
}

function validateMaxOutputTokens(
  model: ModelDescriptor,
  request: AIModelRequest,
  context: AIErrorContext,
): void {
  const maxOutputTokens = request.settings?.maxOutputTokens;
  if (maxOutputTokens === undefined) return;
  if (maxOutputTokens <= model.limits.maxOutputTokens) return;

  throw invalid(
    `AI model request maxOutputTokens (${String(maxOutputTokens)}) exceeds the model limit (${String(model.limits.maxOutputTokens)}).`,
    context,
  );
}

/**
 * Convert a low-level shape `TypeError` into the frozen request failure.
 *
 * An `AIError` is passed through unchanged: a capability rejection raised by a
 * nested check is already the correct typed outcome and must not be re-labelled.
 */
function translateShapeFailures(context: AIErrorContext, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw invalid(error instanceof Error ? error.message : "AI model request is invalid.", context);
  }
}

function invalid(message: string, context: AIErrorContext): AIError {
  return createAIError("AI_INVALID_REQUEST", message, context);
}
