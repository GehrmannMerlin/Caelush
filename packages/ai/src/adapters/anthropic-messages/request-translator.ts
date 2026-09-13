import { buildAnthropicMessagesHeaders } from "./headers.js";
import { createAIError } from "../../errors/ai-error.js";
import { resolveAnthropicMessagesTarget } from "./endpoint.js";
import { resolveAnthropicNativeOptions } from "./native-options.js";
import { translateAnthropicMessages } from "./message-translator.js";
import {
  translateAnthropicToolChoice,
  translateAnthropicTools,
  withAnthropicCacheControl,
} from "./tool-translator.js";
import type {
  AnthropicCacheControl,
  AnthropicTool,
  AnthropicToolChoice,
} from "./tool-translator.js";
import type { AnthropicMessage, AnthropicSystemBlock } from "./message-translator.js";
import type { AnthropicMessagesConnectionMetadata } from "./adapter-metadata.js";
import type { AnthropicMessagesModelMetadata } from "./adapter-metadata.js";
import type { AnthropicOutputConfig, AnthropicThinking } from "./native-options.js";
import type { ModelRef } from "../../models/model-ref.js";
import type { ResolvedAIModelRequest } from "../../request/resolved-model-request.js";
import type { ResolvedProviderConnection } from "../../providers/resolved-provider-connection.js";

/**
 * The native Anthropic Messages request body.
 *
 * Every optional field is present only when the semantic request actually needs
 * it: the dialect never pads a request with defaults the caller did not ask for.
 */
export interface AnthropicMessagesRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: true;
  readonly messages: readonly AnthropicMessage[];
  readonly system?: readonly AnthropicSystemBlock[];
  readonly tools?: readonly AnthropicTool[];
  readonly tool_choice?: AnthropicToolChoice;
  readonly temperature?: number;
  readonly thinking?: AnthropicThinking;
  readonly output_config?: AnthropicOutputConfig;
}

/** Everything one native provider turn needs. */
export interface TranslatedAnthropicRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AnthropicMessagesRequestBody;
  readonly authMode: "api-key" | "bearer";
  readonly version: string;
  readonly native: ReturnType<typeof resolveAnthropicNativeOptions>;
}

/** Translate one resolved AI request into a native Messages request. */
export function translateAnthropicRequest(
  model: AnthropicMessagesModelMetadata | undefined,
  connection: ResolvedProviderConnection,
  request: ResolvedAIModelRequest,
  connectionMetadata: AnthropicMessagesConnectionMetadata,
): TranslatedAnthropicRequest {
  const ref = request.model.ref;

  // Fail closed before any transport is created: every dialect-specific
  // impossibility is decided here.
  const target = resolveAnthropicMessagesTarget(
    connection.endpoint,
    connectionMetadata,
    connection.queryParams,
    ref,
  );
  const headers = buildAnthropicMessagesHeaders(connection, connectionMetadata, ref);

  const conversation = translateAnthropicMessages(request.messages, ref);
  const tools = translateAnthropicTools(request.tools, ref);
  const toolChoice = translateAnthropicToolChoice(request.toolChoice);
  const native = resolveAnthropicNativeOptions(model, request, tools !== undefined);

  assertCacheSupported(request);

  const marked = withCacheMarker(
    conversation.messages,
    tools,
    conversation.system,
    native.cacheControl,
  );

  return {
    url: target.url,
    method: "POST",
    headers: headers.headers,
    authMode: headers.authMode,
    version: headers.version,
    native,
    body: {
      model: ref.model,
      max_tokens: resolveMaxTokens(request, ref),
      stream: true,
      messages: marked.messages,
      ...(marked.system === undefined ? {} : { system: marked.system }),
      ...(marked.tools === undefined ? {} : { tools: marked.tools }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(request.settings.temperature === undefined
        ? {}
        : { temperature: request.settings.temperature }),
      ...(native.thinking === undefined ? {} : { thinking: native.thinking }),
      ...(native.outputConfig === undefined ? {} : { output_config: native.outputConfig }),
    },
  };
}

/**
 * The caller's output ceiling, or the model's own resolved safe value.
 *
 * The adapter never invents a number. When the caller asked for nothing, the
 * authoritative model limit is the ceiling; when the caller asked for something, it
 * was already validated against that same limit by the frozen request validator.
 * A missing limit is a metadata defect and is reported as one.
 */
function resolveMaxTokens(request: ResolvedAIModelRequest, model: ModelRef): number {
  const requested = request.settings.maxOutputTokens;
  if (requested !== undefined) return requested;

  const limit = request.model.limits.maxOutputTokens;
  if (Number.isSafeInteger(limit) && limit > 0) return limit;

  throw createAIError(
    "AI_INVALID_REQUEST",
    `AI model "${model.model}" has no usable output token limit, so the native max_tokens cannot be resolved.`,
    { providerId: model.provider, model },
  );
}

/**
 * A non-NONE effective retention must be expressible, never silently dropped.
 *
 * The cache resolver already downgraded an unsupported request, so an effective
 * `SHORT`/`LONG` here is a promise the dialect has to keep.
 */
function assertCacheSupported(request: ResolvedAIModelRequest): void {
  const capability = request.model.capabilities.promptCaching;
  if (capability === "UNSUPPORTED" && request.settings.cache.effective !== "NONE") {
    const model = request.model.ref;
    throw createAIError(
      "AI_CAPABILITY_UNSUPPORTED",
      `AI model "${model.model}" declares prompt caching as unsupported, but the effective cache retention is "${request.settings.cache.effective}".`,
      { providerId: model.provider, model },
    );
  }
}

/**
 * Attach the native cache marker at exactly one tail position.
 *
 * At most one marker is sent per turn, which is the documented maximum for this
 * dialect. The precedence is the largest stable prompt prefix first:
 *
 * ```text
 * 1 last content block of the last message
 * 2 last tool definition, when no message carries a content block
 * 3 last system block, for a system-only turn
 * ```
 *
 * The branch is chosen once, so a turn never carries two markers and a turn whose
 * last message is a tool result still marks the conversation tail rather than the
 * tool catalog.
 *
 * Prompt *content* is never rewritten: no fake system message is inserted, no
 * marker text is added to a prompt, no message or tool is reordered and no tool
 * definition is modified. Cache retention is expressed only through the native
 * cache-control field.
 */
function withCacheMarker(
  messages: readonly AnthropicMessage[],
  tools: readonly AnthropicTool[] | undefined,
  system: readonly AnthropicSystemBlock[] | undefined,
  cacheControl: AnthropicCacheControl | undefined,
): {
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicTool[];
  readonly system?: readonly AnthropicSystemBlock[];
} {
  const unmarked = {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(system === undefined ? {} : { system }),
  };
  if (cacheControl === undefined) return unmarked;

  const lastMessageIndex = messages.length - 1;
  const lastMessage = messages[lastMessageIndex];
  if (lastMessage !== undefined && lastMessage.content.length > 0) {
    const content = [...lastMessage.content];
    content[content.length - 1] = {
      ...(content[content.length - 1] as AnthropicCacheableBlock),
      cache_control: cacheControl,
    };
    const marked = [...messages];
    marked[lastMessageIndex] = { role: lastMessage.role, content };
    return { ...unmarked, messages: marked };
  }

  if (tools !== undefined && tools.length > 0) {
    const markedTools = [...tools];
    markedTools[markedTools.length - 1] = withAnthropicCacheControl(
      markedTools[markedTools.length - 1] as AnthropicTool,
      cacheControl,
    );
    return { ...unmarked, tools: markedTools };
  }

  if (system !== undefined && system.length > 0) {
    const markedSystem = [...system];
    markedSystem[markedSystem.length - 1] = {
      ...(markedSystem[markedSystem.length - 1] as AnthropicSystemBlock),
      cache_control: cacheControl,
    };
    return { ...unmarked, system: markedSystem };
  }

  return unmarked;
}

/** A content block the dialect can attach a cache marker to. */
type AnthropicCacheableBlock = AnthropicMessage["content"][number];
