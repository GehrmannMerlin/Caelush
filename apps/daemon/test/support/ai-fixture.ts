import type {
  AIAdapterEvent,
  AIProviderBinding,
  ModelDescriptor,
  ModelDescriptorSourcePort,
} from "@caelush/ai";

/**
 * The daemon fixture model, expressed as Architecture V2 composition input.
 *
 * Phase 2C replaced the legacy provider-override composition option with the AI core's
 * own seams, so a daemon test now composes a real `AISubsystem` from three pieces:
 *
 *   - a model descriptor source (the model metadata authority),
 *   - a provider binding (where and with which dialect), and
 *   - an `ApiAdapter` (the scripted wire dialect).
 *
 * The adapter is the only stub. The gateway, catalog, provider registry, stream
 * validator and turn assembler are the production implementations.
 */

export const FIXTURE_PROVIDER = "fixture";
export const FIXTURE_MODEL = "fixture-model";
export const FIXTURE_API = "fixture-api";
export const FIXTURE_ENDPOINT = "http://fixture.invalid/v1";

/** The descriptor every daemon fixture resolves against. */
export function fixtureDescriptor(): ModelDescriptor {
  return {
    ref: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    api: FIXTURE_API,
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNSUPPORTED",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "CONFIGURATION",
  };
}

/** The model metadata authority a daemon fixture composes with. */
export function fixtureModelSource(): ModelDescriptorSourcePort & {
  list(): readonly ModelDescriptor[];
} {
  const descriptor = fixtureDescriptor();
  return {
    id: "daemon-fixture",
    priority: 0,
    resolve: (ref) =>
      ref.provider === FIXTURE_PROVIDER && ref.model === FIXTURE_MODEL ? descriptor : undefined,
    list: () => [descriptor],
  };
}

/** The connection a daemon fixture composes with. */
export function fixtureBinding(overrides: Partial<AIProviderBinding> = {}): AIProviderBinding {
  return {
    id: FIXTURE_PROVIDER,
    endpoint: FIXTURE_ENDPOINT,
    defaultApi: FIXTURE_API,
    allowUnknownModels: true,
    credentials: { resolve: async () => ({ apiKey: "fixture-key" }) },
    ...overrides,
  };
}

/** One scripted provider turn in the adapter dialect. */
export type AdapterTurn = readonly AIAdapterEvent[];

/** A finish envelope an adapter may emit. */
export function finish(
  finishReason: "STOP" | "LENGTH" | "TOOL_CALLS" | "CONTENT_FILTER" | "OTHER",
  finalUsage?: { readonly inputTokens?: number; readonly outputTokens?: number },
): AIAdapterEvent {
  return {
    type: "adapter.finish",
    payload: { finishReason, ...(finalUsage === undefined ? {} : { finalUsage }) },
  };
}

/** A completed tool call. */
export function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AIAdapterEvent[] {
  return [
    { type: "tool_call.start", payload: { toolCallId: id, toolName: name } },
    { type: "tool_call.completed", payload: { id, name, input } },
  ];
}

/** A text answer. */
export function answer(text: string): AIAdapterEvent[] {
  return [
    { type: "text.delta", payload: { text } },
    { type: "adapter.finish", payload: { finishReason: "STOP" } },
  ];
}
