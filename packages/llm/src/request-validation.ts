import type { LLMCapabilities } from "./capabilities.js";
import { LLMCapabilityUnsupportedError, LLMInvalidRequestError } from "./errors.js";
import type { LLMRequest } from "./request.js";

export function validateLLMRequestSemantics(
  request: LLMRequest,
  capabilities: LLMCapabilities,
): void {
  const tools = request.tools ?? [];
  const toolNames = new Set<string>();
  for (const tool of tools) {
    if (toolNames.has(tool.name)) {
      throw new LLMInvalidRequestError(`LLM request contains duplicate tool "${tool.name}".`, {
        model: request.model,
        providerId: request.model.provider,
      });
    }
    toolNames.add(tool.name);
  }

  const toolChoice = request.toolChoice;
  if (toolChoice?.type === "REQUIRED" && tools.length === 0) {
    throw new LLMInvalidRequestError("LLM tool choice REQUIRED requires at least one tool.", {
      model: request.model,
      providerId: request.model.provider,
    });
  }
  if (toolChoice?.type === "TOOL") {
    if (tools.length === 0) {
      throw new LLMInvalidRequestError("A specific LLM tool choice requires at least one tool.", {
        model: request.model,
        providerId: request.model.provider,
      });
    }
    if (!toolNames.has(toolChoice.toolName)) {
      throw new LLMInvalidRequestError(
        `LLM tool choice references unknown tool "${toolChoice.toolName}".`,
        { model: request.model, providerId: request.model.provider },
      );
    }
  }

  if (tools.length > 0 && capabilities.toolCalling === "UNSUPPORTED") {
    throw new LLMCapabilityUnsupportedError("toolCalling", request.model);
  }
  if (
    (toolChoice?.type === "REQUIRED" || toolChoice?.type === "TOOL") &&
    capabilities.toolCalling === "UNSUPPORTED"
  ) {
    throw new LLMCapabilityUnsupportedError("toolCalling", request.model);
  }
  if (
    request.maxOutputTokens !== undefined &&
    capabilities.maxOutputTokens !== undefined &&
    request.maxOutputTokens > capabilities.maxOutputTokens
  ) {
    throw new LLMInvalidRequestError(
      `maxOutputTokens exceeds the model limit of ${capabilities.maxOutputTokens}.`,
      { model: request.model, providerId: request.model.provider },
    );
  }
}

export function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LLMInvalidRequestError("LLM timeoutMs must be a finite positive integer.");
  }
}
