import type { ModelRef } from "@caelush/protocol";

export type LLMErrorCode =
  | "LLM_PROVIDER_NOT_FOUND"
  | "LLM_MODEL_UNSUPPORTED"
  | "LLM_CAPABILITY_UNSUPPORTED"
  | "LLM_AUTHENTICATION"
  | "LLM_RATE_LIMIT"
  | "LLM_NETWORK"
  | "LLM_TIMEOUT"
  | "LLM_ABORTED"
  | "LLM_INVALID_RESPONSE"
  | "LLM_PROVIDER_ERROR";

export interface LLMErrorContext {
  readonly providerId?: string;
  readonly model?: ModelRef;
  readonly cause?: unknown;
}

interface LLMErrorOptions extends LLMErrorContext {
  readonly retryable: boolean;
}

function withRetryability(context: LLMErrorContext, retryable: boolean): LLMErrorOptions {
  return { ...context, retryable };
}

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly providerId: string | undefined;
  readonly model: ModelRef | undefined;
  readonly retryable: boolean;

  constructor(code: LLMErrorCode, message: string, options: LLMErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.providerId = options.providerId;
    this.model = options.model;
    this.retryable = options.retryable;
  }
}

export class LLMProviderNotFoundError extends LLMError {
  constructor(providerId: string) {
    super(
      "LLM_PROVIDER_NOT_FOUND",
      `LLM provider "${providerId}" is not registered.`,
      withRetryability({ providerId }, false),
    );
  }
}

export class LLMModelUnsupportedError extends LLMError {
  constructor(model: ModelRef) {
    super(
      "LLM_MODEL_UNSUPPORTED",
      `LLM provider "${model.provider}" does not support model "${model.model}".`,
      withRetryability({ model, providerId: model.provider }, false),
    );
  }
}

export class LLMCapabilityUnsupportedError extends LLMError {
  constructor(capability: string, model: ModelRef) {
    super(
      "LLM_CAPABILITY_UNSUPPORTED",
      `LLM model "${model.model}" does not support capability "${capability}".`,
      withRetryability({ model, providerId: model.provider }, false),
    );
  }
}

export class LLMAuthenticationError extends LLMError {
  constructor(message = "LLM provider authentication failed.", context: LLMErrorContext = {}) {
    super("LLM_AUTHENTICATION", message, withRetryability(context, false));
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(message = "LLM provider rate limit exceeded.", context: LLMErrorContext = {}) {
    super("LLM_RATE_LIMIT", message, withRetryability(context, true));
  }
}

export class LLMNetworkError extends LLMError {
  constructor(message = "LLM provider network request failed.", context: LLMErrorContext = {}) {
    super("LLM_NETWORK", message, withRetryability(context, true));
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message = "LLM provider request timed out.", context: LLMErrorContext = {}) {
    super("LLM_TIMEOUT", message, withRetryability(context, true));
  }
}

export class LLMAbortedError extends LLMError {
  constructor(message = "LLM provider request was aborted.", context: LLMErrorContext = {}) {
    super("LLM_ABORTED", message, withRetryability(context, false));
  }
}

export class LLMInvalidResponseError extends LLMError {
  constructor(message = "LLM provider returned an invalid response.", context: LLMErrorContext = {}) {
    super("LLM_INVALID_RESPONSE", message, withRetryability(context, false));
  }
}

export class LLMProviderError extends LLMError {
  constructor(message = "LLM provider request failed.", context: LLMErrorContext = {}) {
    super("LLM_PROVIDER_ERROR", message, withRetryability(context, false));
  }
}
