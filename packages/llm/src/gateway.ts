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
import { LLMTurnResultSchema } from "./result.js";
import type { FinishReason, LLMToolCall } from "./tool-call.js";
import type { LLMUsage } from "./usage.js";
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

  async complete(request: LLMProviderRequest, options?: LLMStreamOptions): Promise<LLMTurnResult> {
    const stream = this.stream(request, options);
    let text = "";
    const toolCalls: LLMToolCall[] = [];
    let usage: LLMUsage | undefined;
    let finishReason: FinishReason | undefined;

    for await (const event of stream.events) {
      switch (event.type) {
        case "text.delta":
          text += event.payload.text;
          break;
        case "tool_call.completed":
          toolCalls.push(event.payload);
          break;
        case "usage":
          usage = event.payload;
          break;
        case "stream.finish":
          finishReason = event.payload.finishReason;
          if (event.payload.finalUsage !== undefined) {
            usage = event.payload.finalUsage;
          }
          break;
        case "stream.start":
        case "tool_call.start":
        case "tool_call.delta":
          break;
      }
    }

    if (finishReason === undefined) {
      throw new LLMInvalidResponseError("LLM provider stream did not provide a finish reason.", {
        providerId: request.model.provider,
        model: request.model,
      });
    }
    const result = {
      callId: stream.callId,
      providerId: request.model.provider,
      model: request.model,
      text,
      toolCalls,
      finishReason,
      ...(usage === undefined ? {} : { usage }),
    };
    return LLMTurnResultSchema.parse(result);
  }
}
