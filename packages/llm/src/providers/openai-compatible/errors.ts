import { APICallError, InvalidResponseDataError, JSONParseError, TypeValidationError } from "ai";
import {
  LLMAuthenticationError,
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

function providerContext(request: LLMProviderRequest) {
  return { providerId: request.model.provider, model: request.model };
}
