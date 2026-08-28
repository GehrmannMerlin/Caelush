import type { ModelRef } from "@caelush/protocol";
import type {
  LLMCapabilities,
  LLMError,
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
  LLMStreamEvent,
  ProviderId,
} from "../../src/index.js";
import { LLMAbortedError } from "../../src/index.js";

const unknownCapabilities: LLMCapabilities = {
  textStreaming: "UNKNOWN",
  toolCalling: "UNKNOWN",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
};

export interface FakeLLMProviderOptions {
  readonly id: ProviderId;
  readonly events?: readonly LLMStreamEvent[];
  readonly eventsForContext?: (
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ) => readonly LLMStreamEvent[];
  readonly rawEventsForContext?: (
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ) => readonly unknown[];
  readonly waitUntilAborted?: boolean;
  readonly error?: LLMError;
  readonly capabilities?: LLMCapabilities;
  readonly supportsModel?: (model: ModelRef) => boolean;
}

export class FakeLLMProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly events: readonly LLMStreamEvent[];
  private readonly eventsForContext:
    | ((request: LLMProviderRequest, context: LLMProviderCallContext) => readonly LLMStreamEvent[])
    | undefined;
  private readonly rawEventsForContext:
    | ((request: LLMProviderRequest, context: LLMProviderCallContext) => readonly unknown[])
    | undefined;
  private readonly waitUntilAborted: boolean;
  iteratorCleanup = false;
  readonly error: LLMError | undefined;
  readonly capabilities: LLMCapabilities;
  observedRequest: LLMProviderRequest | undefined;
  readonly observedRequests: LLMProviderRequest[] = [];
  readonly observedContexts: LLMProviderCallContext[] = [];
  streamCallCount = 0;
  lastSignal: AbortSignal | undefined;
  lastCallId: LLMProviderCallContext["callId"] | undefined;
  private readonly modelPredicate: (model: ModelRef) => boolean;

  constructor(options: FakeLLMProviderOptions) {
    this.id = options.id;
    this.events = options.events ?? [];
    this.eventsForContext = options.eventsForContext;
    this.rawEventsForContext = options.rawEventsForContext;
    this.waitUntilAborted = options.waitUntilAborted ?? false;
    this.error = options.error;
    this.capabilities = options.capabilities ?? unknownCapabilities;
    this.modelPredicate = options.supportsModel ?? ((model) => model.provider === this.id);
  }

  supportsModel(model: ModelRef): boolean {
    return this.modelPredicate(model);
  }

  getCapabilities(model: ModelRef): LLMCapabilities {
    void model;
    return this.capabilities;
  }

  async *stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    try {
      this.observedRequest = request;
      this.observedRequests.push(request);
      this.observedContexts.push(context);
      this.streamCallCount += 1;
      this.lastSignal = context.signal;
      this.lastCallId = context.callId;
      if (context.signal.aborted) {
        throw new LLMAbortedError();
      }
      if (this.error !== undefined) {
        throw this.error;
      }
      const events = this.eventsForContext?.(request, context) ?? this.events;
      const rawEvents = this.rawEventsForContext?.(request, context);
      if (rawEvents !== undefined) {
        for (const event of rawEvents) {
          yield event as LLMStreamEvent;
        }
      } else {
        for (const event of events) {
          yield event;
        }
      }
      if (this.waitUntilAborted) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            resolve();
            return;
          }
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } finally {
      this.iteratorCleanup = true;
    }
  }
}
