import { createLLMCallId } from "@caelush/protocol";
import {
  LLMAbortedError,
  LLMInvalidRequestError,
  LLMInvalidResponseError,
  LLMModelUnsupportedError,
  LLMTimeoutError,
} from "./errors.js";
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
import { createAbortScope } from "./abort.js";

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
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const scope = createAbortScope(options.signal, timeoutMs);
    const validator = createStreamValidator(callId, provider.id, request.model);
    let providerIterator: AsyncIterator<LLMStreamEvent> | undefined;
    let completed = false;
    try {
      const initialAbort = scope.kind();
      if (initialAbort !== undefined) {
        throw this.abortError(initialAbort, provider.id, request.model);
      }
      const context: LLMProviderCallContext = { callId, signal: scope.signal };
      providerIterator = provider.stream(request, context)[Symbol.asyncIterator]();
      while (true) {
        const outcome = await Promise.race([
          providerIterator.next().then((result) => ({ type: "event" as const, result })),
          scope.aborted.then((abortKind) => ({ type: "abort" as const, abortKind })),
        ]);
        if (outcome.type === "abort") {
          if (outcome.abortKind === "consumer") return;
          throw this.abortError(outcome.abortKind, provider.id, request.model);
        }
        if (outcome.result.done === true) {
          validator.assertFinished();
          completed = true;
          return;
        }
        const parsedEvent = LLMStreamEventSchema.safeParse(outcome.result.value);
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
    } finally {
      if (!completed && scope.kind() === undefined) {
        scope.abortConsumer();
      }
      if (providerIterator !== undefined && scope.kind() !== undefined) {
        try {
          await providerIterator.return?.();
        } catch {
          // The original stream outcome is authoritative during cleanup.
        }
      }
      scope.cleanup();
    }
  }

  private abortError(
    kind: "external" | "timeout" | "consumer",
    providerId: string,
    model: LLMProviderRequest["model"],
  ): LLMAbortedError | LLMTimeoutError {
    if (kind === "timeout") {
      return new LLMTimeoutError(undefined, { providerId, model });
    }
    return new LLMAbortedError(undefined, { providerId, model });
  }

  complete(_request: LLMProviderRequest, _options?: LLMStreamOptions): Promise<LLMTurnResult> {
    throw new Error("LLMGateway.complete is not implemented yet.");
  }
}
