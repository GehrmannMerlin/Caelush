import { AIError, createAIError } from "../errors/ai-error.js";
import { createAIModelTurnAssembler } from "../stream/turn-assembler.js";
import { observeIteratorNext, waitForIteratorNext } from "../stream/idle-watchdog.js";
import { createGatewayRequestResolver } from "./gateway-request-resolver.js";
import { createToolCallTracker } from "../stream/tool-call-tracker.js";
import { describeValue } from "../internal/assertions.js";
import type { AIAdapterEvent } from "../adapters/api-adapter-event.js";
import { isAIMessagePhase } from "../messages/assistant-item.js";
import type { AIErrorContext, AIErrorSanitizer } from "../errors/index.js";
import type { AIFinishReason } from "../tools/tool-call.js";
import type { AIModelRequest } from "../request/model-request.js";
import type { AIModelTurnResult } from "../models/model-turn-result.js";
import type {
  AIStream,
  AIStreamEvent,
  AIStreamOptions,
  AIStreamStatusEvent,
} from "../stream/index.js";
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
import type {
  AIAdapterPrivateCompletionCandidate,
  AIPrivateCompletion,
  AIPrivateReplayResolver,
} from "../stream/private-completion.js";

const MAX_PRIVATE_COMPLETION_BYTES = 8 * 1024 * 1024;

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
  readonly defaultNudgeAfterMs?: number;
  readonly defaultIdleTimeoutMs?: number;
  readonly defaultTeardownGraceMs?: number;
  readonly clock?: { now(): number };
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
    ...(options.defaultNudgeAfterMs === undefined
      ? {}
      : { defaultNudgeAfterMs: options.defaultNudgeAfterMs }),
    ...(options.defaultIdleTimeoutMs === undefined
      ? {}
      : { defaultIdleTimeoutMs: options.defaultIdleTimeoutMs }),
    ...(options.defaultTeardownGraceMs === undefined
      ? {}
      : { defaultTeardownGraceMs: options.defaultTeardownGraceMs }),
  });

  const gateway: AIGateway = {
    async stream(request: AIModelRequest, streamOptions?: AIStreamOptions): Promise<AIStream> {
      // The frozen preflight (steps 1-16) runs here. Everything it rejects throws;
      // only step 17, returning the stream, produces the async result.
      const prepared = await resolver.resolve({
        request,
        ...(streamOptions === undefined ? {} : { options: streamOptions }),
      });

      const clock = options.clock;
      const now = clock === undefined ? () => Date.now() : () => clock.now();
      const privateCompletion = createPrivateCompletionSlot(
        prepared.callId,
        prepared.descriptor.ref.provider,
        prepared.model,
        prepared.descriptor.api,
      );
      return {
        callId: prepared.callId,
        events: runGatewayStream(
          prepared,
          dependencies.errors,
          now,
          privateCompletion,
          streamOptions?.privateReplayResolver,
        ),
        takePrivateCompletion: () => privateCompletion.take(),
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

      try {
        for await (const event of stream.events) assembler.accept(event);
        // Throws an AIError when the stream errored or never finished.
        return assembler.result();
      } finally {
        // `complete()` has no private-replay consumer. Wipe even if assembly fails.
        const privateCompletion = stream.takePrivateCompletion();
        if (privateCompletion?.completeness === "COMPLETE") privateCompletion.payload.fill(0);
      }
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
  now: () => number,
  privateCompletion: PrivateCompletionSlot,
  privateReplayResolver: AIPrivateReplayResolver | undefined,
): AsyncGenerator<AIStreamEvent> {
  const {
    adapter,
    connection,
    descriptor,
    request,
    scope,
    callId,
    model,
    providerId,
    resolution,
    nudgeAfterMs,
    idleTimeoutMs,
    teardownGraceMs,
  } = prepared;

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
    let providerLastActivityAt = now();
    let providerEventReceived = false;
    let nudgeEmitted = false;
    let phase: AIStreamStatusEvent["payload"]["phase"] = "WAITING_PROVIDER";

    const adapterStream = adapter.stream({
      model: descriptor,
      provider: connection,
      request,
      signal: scope.signal,
      ...(privateReplayResolver === undefined ? {} : { privateReplayResolver }),
      capturePrivateCompletion: (candidate) => privateCompletion.capture(candidate),
    });
    adapterIterator = adapterStream[Symbol.asyncIterator]();
    let pendingNext = observeIteratorNext(adapterIterator);

    while (true) {
      const outcome = await waitForIteratorNext({
        pending: pendingNext,
        aborted: scope.aborted,
        providerLastActivityAt,
        nudgeAfterMs,
        idleTimeoutMs,
        nudgeEmitted,
        now,
      });

      if (outcome.kind === "NUDGE") {
        nudgeEmitted = true;
        phase = "NO_RECENT_ACTIVITY";
        yield streamStatusEvent(phase, providerLastActivityAt, idleTimeoutMs, now);
        continue;
      }
      if (outcome.kind === "IDLE_TIMEOUT") {
        scope.abortIdle();
        phase = "CANCELLING_IDLE_STREAM";
        yield streamStatusEvent(phase, providerLastActivityAt, idleTimeoutMs, now);
        throw createAIError("AI_TIMEOUT", undefined, context);
      }
      if (outcome.kind === "ABORT") {
        throw createAIError(
          outcome.abortKind === "timeout" || outcome.abortKind === "idle_timeout"
            ? "AI_TIMEOUT"
            : "AI_ABORTED",
          undefined,
          context,
        );
      }
      if (outcome.kind === "ERROR") throw outcome.error;

      const step = outcome.result;
      if (step.done === true) break;

      const adapterEvent = step.value;
      providerLastActivityAt = now();
      nudgeEmitted = false;
      if (
        phase === "NO_RECENT_ACTIVITY" ||
        (!providerEventReceived && !isDisplayableAdapterEvent(adapterEvent))
      ) {
        phase = "RECEIVING_PROVIDER_DATA";
        yield streamStatusEvent(phase, providerLastActivityAt, idleTimeoutMs, now);
      }
      providerEventReceived = true;
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
        pendingNext = observeIteratorNext(adapterIterator);
        continue;
      }

      if (adapterEvent.type === "provider.activity") {
        pendingNext = observeIteratorNext(adapterIterator);
        continue;
      }

      const publicEvent = toPublicEvent(adapterEvent, context, callId);
      if (publicEvent !== undefined) yield publicEvent;
      pendingNext = observeIteratorNext(adapterIterator);
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
    privateCompletion.settleSuccessfully();
    terminal = true;
    yield finishEvent;
  } catch (error) {
    privateCompletion.fail();
    terminal = true;
    yield {
      type: "stream.error",
      payload: {
        error: sanitizer.sanitize(normalizeRuntimeError(error, scope, providerId, model)),
      },
    };
  } finally {
    if (!terminal) privateCompletion.fail();
    // A consumer that stopped reading is a distinct internal cause: signal it
    // before closing the adapter iterator so an in-flight transport can unwind.
    if (!terminal) scope.abortConsumer();
    scope.cleanup();
    if (adapterIterator?.return !== undefined) {
      await closeAdapterIterator(adapterIterator, teardownGraceMs);
    }
  }
}

interface PrivateCompletionSlot {
  capture(candidate: AIAdapterPrivateCompletionCandidate): void;
  settleSuccessfully(): void;
  fail(): void;
  take(): AIPrivateCompletion | undefined;
}

function createPrivateCompletionSlot(
  callId: LLMCallId,
  providerId: import("../ids/provider-id.js").ProviderId,
  model: ModelRef,
  api: import("../ids/api-id.js").ApiId,
): PrivateCompletionSlot {
  let candidate: AIAdapterPrivateCompletionCandidate | undefined;
  let settled = false;
  let failed = false;
  let consumed = false;

  return {
    capture(next) {
      if (candidate !== undefined || settled || failed) {
        throw createAIError(
          "AI_INVALID_RESPONSE",
          "The provider adapter produced an invalid private completion.",
          { providerId, model },
        );
      }
      if (next.completeness === "COMPLETE") {
        if (next.payload.byteLength > MAX_PRIVATE_COMPLETION_BYTES) {
          next.payload.fill(0);
          candidate = { completeness: "INCOMPLETE" };
          return;
        }
        candidate = { completeness: "COMPLETE", payload: next.payload.slice() };
        next.payload.fill(0);
        return;
      }
      candidate = { completeness: "INCOMPLETE" };
    },
    settleSuccessfully() {
      settled = true;
    },
    fail() {
      failed = true;
      if (candidate?.completeness === "COMPLETE") candidate.payload.fill(0);
      candidate = undefined;
    },
    take() {
      if (!settled || failed || consumed || candidate === undefined) return undefined;
      consumed = true;
      const value = candidate;
      candidate = undefined;
      return value.completeness === "COMPLETE"
        ? {
            callId,
            providerId,
            model,
            api,
            completeness: "COMPLETE",
            payload: value.payload,
          }
        : { callId, providerId, model, api, completeness: "INCOMPLETE" };
    },
  };
}

function streamStatusEvent(
  phase: AIStreamStatusEvent["payload"]["phase"],
  providerLastActivityAt: number,
  idleTimeoutMs: number,
  now: () => number,
): AIStreamStatusEvent {
  return {
    type: "stream.status",
    payload: {
      phase,
      lastActivityAt: providerLastActivityAt,
      idleForMs: Math.max(0, now() - providerLastActivityAt),
      idleTimeoutMs,
    },
  };
}

async function closeAdapterIterator(
  iterator: AsyncIterator<AIAdapterEvent>,
  teardownGraceMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = Promise.resolve()
    .then(() => iterator.return?.())
    .then(
      () => undefined,
      () => undefined,
    );
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, teardownGraceMs);
  });

  try {
    await Promise.race([closing, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
    case "provider.activity":
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
function toPublicEvent(
  event: AIAdapterEvent,
  context: AIErrorContext,
  callId: LLMCallId,
): AIStreamEvent | undefined {
  switch (event.type) {
    case "provider.activity":
      return undefined;
    case "text.delta": {
      const assistantItemIndex = normalizeAssistantItemIndex(
        event.payload.assistantItemIndex,
        context,
      );
      return {
        type: "text.delta",
        payload: {
          text: event.payload.text,
          assistantItemId: assistantItemId(callId, assistantItemIndex),
          phase: normalizeAssistantPhase(event.payload.phase, context),
        },
      };
    }
    case "reasoning.summary.delta":
      return { type: "reasoning.summary.delta", payload: { text: event.payload.text } };
    case "tool_call.start": {
      const assistantItemIndex = normalizeAssistantItemIndex(
        event.payload.assistantItemIndex,
        context,
      );
      return {
        type: "tool_call.start",
        payload: {
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          assistantItemId: assistantItemId(callId, assistantItemIndex),
          phase: normalizeAssistantPhase(event.payload.phase, context),
        },
      };
    }
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

function isDisplayableAdapterEvent(event: AIAdapterEvent): boolean {
  return (
    event.type === "text.delta" ||
    event.type === "reasoning.summary.delta" ||
    event.type === "tool_call.start"
  );
}

function normalizeAssistantItemIndex(value: number | undefined, context: AIErrorContext): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 255) {
    throw createAIError(
      "AI_INVALID_RESPONSE",
      "AI adapter emitted an invalid assistant item index.",
      context,
    );
  }
  return normalized;
}

function assistantItemId(callId: LLMCallId, index: number): string {
  return `${callId}:item:${String(index).padStart(3, "0")}`;
}

function normalizeAssistantPhase(
  value: import("../messages/assistant-item.js").AIMessagePhase | undefined,
  context: AIErrorContext,
): import("../messages/assistant-item.js").AIMessagePhase {
  if (value === undefined) return "UNKNOWN";
  if (isAIMessagePhase(value)) return value;
  throw createAIError(
    "AI_INVALID_RESPONSE",
    "AI adapter emitted an unsupported assistant message phase.",
    context,
  );
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

  if (kind === "timeout" || kind === "idle_timeout") {
    return createAIError("AI_TIMEOUT", undefined, context);
  }
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
