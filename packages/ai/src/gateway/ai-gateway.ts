import { AIError, createAIError } from "../errors/ai-error.js";
import { createAIModelTurnAssembler } from "../stream/turn-assembler.js";
import { createGatewayRequestResolver } from "./gateway-request-resolver.js";
import { createToolCallTracker } from "../stream/tool-call-tracker.js";
import { describeValue } from "../internal/assertions.js";
import type { AIAdapterEvent } from "../adapters/api-adapter-event.js";
import type { AIErrorContext, AIErrorSanitizer } from "../errors/index.js";
import type { AIFinishReason } from "../tools/tool-call.js";
import type { AIModelRequest } from "../request/model-request.js";
import type { AIModelTurnResult } from "../models/model-turn-result.js";
import type { AIStream, AIStreamEvent, AIStreamOptions } from "../stream/index.js";
import type { AbortScope } from "../stream/abort-scope.js";
import type { ApiAdapterRegistry } from "../adapters/api-adapter-registry.js";
import type { CacheResolver } from "../cache/cache-resolver.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { ModelCatalog } from "../models/model-catalog.js";
import type { ModelRef } from "../models/model-ref.js";
import type { ModelUsage } from "../models/model-usage.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { ReasoningResolutionPolicy } from "../reasoning/reasoning-resolution.js";
import type { ReasoningResolver } from "../reasoning/reasoning-resolver.js";
import type { ResolvedGatewayRequest } from "./gateway-request-resolver.js";
import type { ToolCallTracker } from "../stream/tool-call-tracker.js";

/** The collaborators an {@link AIGateway} needs. */
export interface AIGatewayDependencies {
  readonly models: ModelCatalog;
  readonly providers: ProviderRegistry;
  readonly adapters: ApiAdapterRegistry;
  readonly reasoning: ReasoningResolver;
  readonly cache: CacheResolver;
  readonly errors: AIErrorSanitizer;
  readonly callIdFactory: { create(): LLMCallId };
}

/** Gateway policy that is not per-request. */
export interface AIGatewayOptions {
  readonly reasoningPolicy?: ReasoningResolutionPolicy;
  readonly defaultTimeoutMs?: number;
}

/**
 * The single AI invocation entry point.
 *
 * The gateway owns call identity, the public stream envelope and preflight. It
 * performs exactly one provider turn per invocation: it never retries, never fails
 * over to another provider or model, never executes a tool, and never compacts a
 * context.
 *
 * `stream()` is asynchronous because preflight is asynchronous — credentials are
 * resolved before the stream is returned. A preflight failure is thrown; only a
 * failure after the stream exists becomes a `stream.error` event.
 */
export interface AIGateway {
  stream(request: AIModelRequest, options?: AIStreamOptions): Promise<AIStream>;
  complete(request: AIModelRequest, options?: AIStreamOptions): Promise<AIModelTurnResult>;
}

/** Create a gateway over explicit dependencies. */
export function createAIGateway(
  dependencies: AIGatewayDependencies,
  options: AIGatewayOptions = {},
): AIGateway {
  const resolver = createGatewayRequestResolver(dependencies, {
    ...(options.reasoningPolicy === undefined ? {} : { reasoningPolicy: options.reasoningPolicy }),
    ...(options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.defaultTimeoutMs }),
  });

  const gateway: AIGateway = {
    async stream(request: AIModelRequest, streamOptions?: AIStreamOptions): Promise<AIStream> {
      // The frozen preflight (steps 1-16) runs here. Everything it rejects throws;
      // only step 17, returning the stream, produces the async result.
      const prepared = await resolver.resolve({
        request,
        ...(streamOptions === undefined ? {} : { options: streamOptions }),
      });

      return {
        callId: prepared.callId,
        events: runGatewayStream(prepared, dependencies.errors),
      };
    },

    async complete(
      request: AIModelRequest,
      streamOptions?: AIStreamOptions,
    ): Promise<AIModelTurnResult> {
      // `complete` consumes the same public stream through the same assembler, so
      // there is exactly one aggregation implementation.
      const stream = await gateway.stream(request, streamOptions);
      const assembler = createAIModelTurnAssembler();

      for await (const event of stream.events) assembler.accept(event);

      // Throws an AIError when the stream errored or never finished.
      return assembler.result();
    },
  };

  return gateway;
}

/**
 * The runtime half: translate adapter events into the public envelope.
 *
 * Only this generator produces `stream.start`, `stream.finish` and `stream.error`.
 * The adapter is invoked lazily, on first iteration, so a synchronous adapter
 * failure still surfaces as a `stream.error` after `stream.start` rather than as a
 * preflight throw.
 */
async function* runGatewayStream(
  prepared: ResolvedGatewayRequest,
  sanitizer: AIErrorSanitizer,
): AsyncGenerator<AIStreamEvent> {
  const { adapter, connection, descriptor, request, scope, callId, model, providerId, resolution } =
    prepared;

  let terminal = false;
  let adapterIterator: AsyncIterator<AIAdapterEvent> | undefined;

  try {
    // Terminal is marked before the terminal yield so that a consumer which stops
    // immediately after receiving it is not mistaken for a cancellation.
    terminal = true;
    yield { type: "stream.start", payload: { callId, providerId, model, resolution } };
    terminal = false;

    const tracker = createToolCallTracker();
    const context: AIErrorContext = { providerId, model };
    let adapterFinish: AdapterFinish | undefined;

    const adapterStream = adapter.stream({
      model: descriptor,
      provider: connection,
      request,
      signal: scope.signal,
    });
    adapterIterator = adapterStream[Symbol.asyncIterator]();

    while (true) {
      const step = await adapterIterator.next();
      if (step.done === true) break;

      const adapterEvent = step.value;
      const finish = trackAdapterEvent(adapterEvent, tracker, context);

      if (finish !== undefined) {
        if (adapterFinish !== undefined) {
          throw createAIError(
            "AI_INVALID_RESPONSE",
            "AI adapter finished its stream more than once.",
            context,
          );
        }
        adapterFinish = finish;
        continue;
      }

      const publicEvent = toPublicEvent(adapterEvent, context);
      if (publicEvent !== undefined) yield publicEvent;
    }

    if (adapterFinish === undefined) {
      throw createAIError(
        "AI_INVALID_RESPONSE",
        "AI adapter stream ended without adapter.finish.",
        context,
      );
    }

    // A successful finish must not leave a tool call open: a partially received
    // call has no validated arguments and must never look executable.
    const openToolCalls = tracker.openIds();
    if (openToolCalls.length > 0) {
      throw createAIError(
        "AI_INVALID_RESPONSE",
        `AI adapter finished while the tool call "${openToolCalls[0] ?? ""}" was still open.`,
        context,
      );
    }

    const finishEvent: AIStreamEvent = {
      type: "stream.finish",
      payload: {
        finishReason: adapterFinish.finishReason,
        ...(adapterFinish.finalUsage === undefined ? {} : { finalUsage: adapterFinish.finalUsage }),
        ...(adapterFinish.providerReason === undefined
          ? {}
          : { providerReason: adapterFinish.providerReason }),
      },
    };
    terminal = true;
    yield finishEvent;
  } catch (error) {
    terminal = true;
    yield {
      type: "stream.error",
      payload: {
        error: sanitizer.sanitize(normalizeRuntimeError(error, scope, providerId, model)),
      },
    };
  } finally {
    // A consumer that stopped reading is a distinct internal cause: signal it
    // before closing the adapter iterator so an in-flight transport can unwind.
    if (!terminal) scope.abortConsumer();
    scope.cleanup();
    if (adapterIterator?.return !== undefined) {
      try {
        await adapterIterator.return();
      } catch {
        // Closing an already-failed adapter iterator must not mask the outcome.
      }
    }
  }
}

interface AdapterFinish {
  readonly finishReason: AIFinishReason;
  readonly finalUsage?: ModelUsage;
  readonly providerReason?: string;
}

/**
 * Apply the shared tool-call lifecycle rules to one adapter event.
 *
 * Returns the finish descriptor for `adapter.finish` so the caller can hold it
 * until the adapter stream really ends. An unknown event type is a violation
 * rather than something to skip: the gateway must never silently drop a malformed
 * adapter stream.
 */
function trackAdapterEvent(
  event: AIAdapterEvent,
  tracker: ToolCallTracker,
  context: AIErrorContext,
): AdapterFinish | undefined {
  switch (event.type) {
    case "text.delta":
    case "reasoning.summary.delta":
    case "usage":
      return undefined;
    case "tool_call.start":
      tracker.start(event.payload.toolCallId, event.payload.toolName, context);
      return undefined;
    case "tool_call.delta":
      tracker.delta(event.payload.toolCallId, context);
      return undefined;
    case "tool_call.completed":
      tracker.complete(event.payload.id, event.payload.name, context);
      return undefined;
    case "adapter.finish":
      return {
        finishReason: event.payload.finishReason,
        ...(event.payload.finalUsage === undefined ? {} : { finalUsage: event.payload.finalUsage }),
        ...(event.payload.providerReason === undefined
          ? {}
          : { providerReason: event.payload.providerReason }),
      };
    default:
      throw createAIError(
        "AI_INVALID_RESPONSE",
        `AI adapter emitted an unknown event type ${describeValue((event as { type?: unknown }).type)}.`,
        context,
      );
  }
}

/** Map an adapter event onto the public stream event of the same shape. */
function toPublicEvent(event: AIAdapterEvent, context: AIErrorContext): AIStreamEvent | undefined {
  switch (event.type) {
    case "text.delta":
      return { type: "text.delta", payload: { text: event.payload.text } };
    case "reasoning.summary.delta":
      return { type: "reasoning.summary.delta", payload: { text: event.payload.text } };
    case "tool_call.start":
      return { type: "tool_call.start", payload: { ...event.payload } };
    case "tool_call.delta":
      return { type: "tool_call.delta", payload: { ...event.payload } };
    case "tool_call.completed":
      return { type: "tool_call.completed", payload: event.payload };
    case "usage":
      return { type: "usage", payload: event.payload };
    default:
      throw createAIError(
        "AI_INVALID_RESPONSE",
        `AI adapter emitted a non-forwardable event type ${describeValue((event as { type?: unknown }).type)}.`,
        context,
      );
  }
}

/**
 * Normalise any runtime failure into the frozen AI error set.
 *
 * An abort cause takes precedence over the adapter's own error: a request that was
 * cancelled or timed out must report that, not whatever symptom the transport
 * produced while unwinding.
 */
function normalizeRuntimeError(
  error: unknown,
  scope: AbortScope,
  providerId: string,
  model: ModelRef,
): AIError {
  const kind = scope.kind();
  const context: AIErrorContext = {
    providerId,
    model,
    ...(error === undefined ? {} : { cause: error }),
  };

  if (kind === "timeout") return createAIError("AI_TIMEOUT", undefined, context);
  if (kind !== undefined) return createAIError("AI_ABORTED", undefined, context);

  if (error instanceof AIError) {
    // Keep the adapter's own diagnosis, but make sure every reported failure names
    // the provider and model it belongs to even when the adapter omitted them.
    if (error.providerId !== undefined && error.model !== undefined) return error;
    return new AIError(error.code, error.message, {
      providerId: error.providerId ?? providerId,
      model: error.model ?? model,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      cause: error,
    });
  }

  // An unknown throw becomes a generic provider failure. The raw error stays as
  // `cause` and never reaches the public message: it may contain a provider body,
  // a prompt or a credential.
  return createAIError("AI_PROVIDER_ERROR", undefined, context);
}
