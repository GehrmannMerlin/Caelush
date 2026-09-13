import type { AIProviderBinding, ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { ANTHROPIC_MESSAGES_API_ID } from "@caelush/ai/adapters/anthropic-messages";

/**
 * The daemon's native Anthropic Messages fixture.
 *
 * Phase 2D proves the second dialect through the daemon's *programmatic* composition
 * seams — `providerBindings` and `modelSources` — exactly as the phase brief requires.
 * The legacy `CAELUSH_PROVIDER_*` environment contract is untouched and still selects
 * `openai-compatible-chat`, so nothing here changes how a deployment is configured.
 *
 * The transport is the only stub: it answers with real Anthropic-shaped SSE and
 * records what the production adapter actually sent.
 */

export const ANTHROPIC_FIXTURE_PROVIDER = "anthropic-fixture";
export const ANTHROPIC_FIXTURE_MODEL = "anthropic-fixture-model";
export const ANTHROPIC_FIXTURE_ENDPOINT = "http://anthropic.invalid";
export const ANTHROPIC_FIXTURE_KEY = "fixture-anthropic-key";

/** The OpenAI-compatible counterpart, used only by the dual-dialect proof. */
export const OPENAI_FIXTURE_PROVIDER = "openai-fixture";
export const OPENAI_FIXTURE_MODEL = "openai-fixture-model";

/** The OpenAI-compatible metadata authority for the dual-dialect proof. */
export function openAIMessagesSource(): ModelDescriptorSourcePort & {
  list(): readonly ModelDescriptor[];
} {
  const descriptor: ModelDescriptor = {
    ref: { provider: OPENAI_FIXTURE_PROVIDER, model: OPENAI_FIXTURE_MODEL },
    api: "openai-compatible-chat",
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "UNSUPPORTED",
      reasoningSummary: "UNSUPPORTED",
      promptCaching: "UNKNOWN",
      usageReporting: "SUPPORTED",
    },
    source: "CONFIGURATION",
  };

  return {
    id: "daemon-openai-fixture",
    priority: 0,
    resolve: (ref) =>
      ref.provider === OPENAI_FIXTURE_PROVIDER && ref.model === OPENAI_FIXTURE_MODEL
        ? descriptor
        : undefined,
    list: () => [descriptor],
  };
}

/** One native request the adapter produced, in dialect-neutral terms. */
export interface CapturedAnthropicRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly body: Record<string, unknown>;
  /** The native `messages` array, for asserting the projected conversation. */
  readonly nativeMessages: readonly Record<string, unknown>[];
}

/** How the fixture should answer each successive provider turn. */
export type AnthropicWireScript =
  | { readonly kind: "answer"; readonly text: string }
  | {
      readonly kind: "tool-then-answer";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly toolInput: Record<string, unknown>;
      readonly finalText: string;
      /** Filled in by the transport as the daemon makes its turns. */
      requests: CapturedAnthropicRequest[];
    };

interface NativeEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

function sse(events: readonly NativeEvent[]): Response {
  return new Response(
    events.map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function messageStart(): NativeEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_daemon_fixture",
        type: "message",
        role: "assistant",
        model: ANTHROPIC_FIXTURE_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    },
  };
}

function textEvents(text: string): readonly NativeEvent[] {
  return [
    messageStart(),
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 6 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function toolEvents(
  id: string,
  name: string,
  input: Record<string, unknown>,
): readonly NativeEvent[] {
  const partial = JSON.stringify(input);
  return [
    messageStart(),
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name, input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial.slice(0, 4) },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial.slice(4) },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 11 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** The verdict a task-acceptance review must return for the fixture workspace. */
const ACCEPTANCE_VERDICT = JSON.stringify({
  verdict: "PASS",
  summary: "The task candidate is acceptable.",
});

/**
 * Whether a native request is the Run's task-acceptance review turn.
 *
 * The daemon asks the same model to review the final candidate, so the fixture has to
 * answer that turn too. It is recognised by the system prompt the reviewer sends, not
 * by a provider or model name.
 */
function isAcceptanceReview(body: Record<string, unknown>): boolean {
  const system = body["system"];
  if (!Array.isArray(system)) return false;
  return system.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.includes("Review the supplied"),
  );
}

/** Build the recording transport that answers the script. */
function createTransport(script: AnthropicWireScript): typeof globalThis.fetch {
  let turn = 0;

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[name.toLowerCase()] = value;
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(bodyText) as Record<string, unknown>;

    if (script.kind === "tool-then-answer") {
      script.requests.push({
        url,
        headers,
        bodyText,
        body,
        nativeMessages: (body["messages"] ?? []) as readonly Record<string, unknown>[],
      });
    }

    // The reviewer turn is answered first: it is neither a tool turn nor the answer
    // turn, and counting it would shift the whole script.
    if (isAcceptanceReview(body)) return sse(textEvents(ACCEPTANCE_VERDICT));

    turn += 1;
    if (script.kind === "answer") return sse(textEvents(script.text));
    if (turn === 1) {
      return sse(toolEvents(script.toolCallId, script.toolName, script.toolInput));
    }
    return sse(textEvents(script.finalText));
  };
}

/** The model metadata authority the daemon composes the native dialect with. */
export function anthropicMessagesSource(): ModelDescriptorSourcePort & {
  list(): readonly ModelDescriptor[];
} {
  const descriptor: ModelDescriptor = {
    ref: { provider: ANTHROPIC_FIXTURE_PROVIDER, model: ANTHROPIC_FIXTURE_MODEL },
    api: ANTHROPIC_MESSAGES_API_ID,
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      // Reasoning stays unsupported on purpose: this fixture proves the tool path,
      // and native thinking plus tools is the combination the dialect refuses.
      reasoning: "UNSUPPORTED",
      reasoningSummary: "UNSUPPORTED",
      promptCaching: "SUPPORTED",
      usageReporting: "SUPPORTED",
    },
    cache: { supportedRetentions: ["NONE", "SHORT", "LONG"] },
    source: "CONFIGURATION",
  };

  return {
    id: "daemon-anthropic-fixture",
    priority: 0,
    resolve: (ref) =>
      ref.provider === ANTHROPIC_FIXTURE_PROVIDER && ref.model === ANTHROPIC_FIXTURE_MODEL
        ? descriptor
        : undefined,
    list: () => [descriptor],
  };
}

/** The native connection the daemon composes the fixture with. */
export function anthropicProviderBinding(script: AnthropicWireScript): AIProviderBinding {
  return {
    id: ANTHROPIC_FIXTURE_PROVIDER,
    endpoint: ANTHROPIC_FIXTURE_ENDPOINT,
    defaultApi: ANTHROPIC_MESSAGES_API_ID,
    allowUnknownModels: false,
    credentials: { resolve: async () => ({ apiKey: ANTHROPIC_FIXTURE_KEY }) },
    transport: { fetch: createTransport(script) },
  };
}
