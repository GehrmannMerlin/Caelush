import { createLLMCallId } from "@caelush/protocol";
import { LLMInvalidRequestError, LLMModelUnsupportedError } from "./errors.js";
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
    for await (const event of providerEvents) {
      yield event;
    }
  }

  complete(_request: LLMProviderRequest, _options?: LLMStreamOptions): Promise<LLMTurnResult> {
    throw new Error("LLMGateway.complete is not implemented yet.");
  }
}

void DEFAULT_TIMEOUT_MS;
