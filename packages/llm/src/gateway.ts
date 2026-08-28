import { createLLMCallId } from "@caelush/protocol";
import { LLMInvalidRequestError, LLMInvalidResponseError, LLMModelUnsupportedError } from "./errors.js";
import { validateLLMRequestSemantics, validateTimeoutMs } from "./request-validation.js";
import { LLMRequestSchema } from "./request.js";
import type { LLMTurnResult } from "./result.js";
import type {
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
} from "./provider.js";
import type { LLMStreamEvent } from "./events.js";
import type { LLMProviderRegistry } from "./provider-registry.js";
import type { LLMCallId } from "@caelush/protocol";
import { LLMStreamEventSchema } from "./events.js";
import { createStreamValidator } from "./stream-validator.js";

export interface LLMStreamOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface LLMStream {
  readonly callId: LLMCallId;
  readonly events: AsyncIterable<LLMStreamEvent>;
}

export interface LLMGatewayDependencies {
  readonly providers: LLMProviderRegistry;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class LLMGateway {
  private readonly providers: LLMProviderRegistry;

  constructor(dependencies: LLMGatewayDependencies) {
    this.providers = dependencies.providers;
  }

  stream(request: LLMProviderRequest, options: LLMStreamOptions = {}): LLMStream {
    const parsedRequest = LLMRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new LLMInvalidRequestError("LLM request failed schema validation.", {
        cause: parsedRequest.error,
      });
    }
    const normalizedRequest = parsedRequest.data;
    const provider = this.providers.get(normalizedRequest.model.provider);
    if (!provider.supportsModel(normalizedRequest.model)) {
      throw new LLMModelUnsupportedError(normalizedRequest.model);
    }
    const capabilities = provider.getCapabilities(normalizedRequest.model);
    validateLLMRequestSemantics(normalizedRequest, capabilities);
    validateTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const callId = createLLMCallId();

    return {
      callId,
      events: this.createLazyEvents(provider, normalizedRequest, callId, options),
    };
  }

  private async *createLazyEvents(
    provider: LLMProvider,
    request: LLMProviderRequest,
    callId: LLMCallId,
    options: LLMStreamOptions,
  ): AsyncIterable<LLMStreamEvent> {
    void options;
    const controller = new AbortController();
    const context: LLMProviderCallContext = { callId, signal: controller.signal };
    const providerEvents = provider.stream(request, context);
    const validator = createStreamValidator(callId, provider.id, request.model);
    for await (const event of providerEvents) {
      const parsedEvent = LLMStreamEventSchema.safeParse(event);
      if (!parsedEvent.success) {
        throw new LLMInvalidResponseError("LLM provider returned an invalid stream event.", {
          providerId: provider.id,
          model: request.model,
          cause: parsedEvent.error,
        });
      }
      validator.accept(parsedEvent.data);
      yield parsedEvent.data;
    }
    validator.assertFinished();
  }

  complete(_request: LLMProviderRequest, _options?: LLMStreamOptions): Promise<LLMTurnResult> {
    throw new Error("LLMGateway.complete is not implemented yet.");
  }
}
