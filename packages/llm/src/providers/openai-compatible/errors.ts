import { APICallError, InvalidResponseDataError, JSONParseError, TypeValidationError } from "ai";
import {
  LLMAuthenticationError,
  LLMContextOverflowError,
  LLMError,
  LLMInvalidResponseError,
  LLMNetworkError,
  LLMProviderError,
  LLMRateLimitError,
} from "../../errors.js";
import type { LLMProviderRequest } from "../../provider.js";

export function normalizeOpenAICompatibleError(
  error: unknown,
  request: LLMProviderRequest,
): LLMError {
  if (error instanceof LLMError) return error;

  if (APICallError.isInstance(error)) {
    const statusCode = error.statusCode;
    if (hasContextOverflowCode(error)) {
      return new LLMContextOverflowError(providerContext(request));
    }
    if (statusCode === 401 || statusCode === 403) {
      return new LLMAuthenticationError(undefined, providerContext(request));
    }
    if (statusCode === 429) {
      return new LLMRateLimitError(undefined, providerContext(request));
    }
    if (statusCode !== undefined && statusCode >= 400) {
      return new LLMProviderError(undefined, providerContext(request));
    }
    return new LLMNetworkError(undefined, providerContext(request));
  }

  if (
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error)
  ) {
    return new LLMInvalidResponseError(undefined, providerContext(request));
  }

  if (error instanceof Error) {
    return new LLMNetworkError(undefined, providerContext(request));
  }
  return new LLMProviderError(undefined, providerContext(request));
}

function hasContextOverflowCode(error: unknown): boolean {
  const candidate = error as { readonly responseBody?: unknown; readonly data?: unknown };
  const values = [candidate.responseBody, candidate.data];
  return values.some((value) => {
    if (typeof value === "string") {
      return /context_length_exceeded|context.{0,24}(length|window).{0,24}(exceed|limit)/i.test(
        value,
      );
    }
    if (value === null || typeof value !== "object") return false;
    const record = value as { readonly code?: unknown; readonly error?: unknown };
    if (record.code === "context_length_exceeded" || record.code === "LLM_CONTEXT_OVERFLOW") {
      return true;
    }
    if (record.error !== undefined) return hasContextOverflowCode(record.error);
    return false;
  });
}

function providerContext(request: LLMProviderRequest) {
  return { providerId: request.model.provider, model: request.model };
}
