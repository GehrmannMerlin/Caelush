# LLM Gateway Architecture

Caelush owns the AgentLoop. The LLM package is the provider-neutral boundary beneath that future loop: it describes one provider turn, normalizes provider output, and keeps provider runtime objects separate from Protocol, persistence, and UI contracts.

## Phase boundary

Phase 4 is split into three rounds:

- **Phase 4A — LLM Contracts & Provider Foundation:** complete. This round defines Caelush-owned messages, `LLMRequest`, capabilities, usage, normalized stream events, typed errors, `LLMProvider`, and an explicit provider registry. It does not call a model.
- **Phase 4B — LLMGateway & Streaming Runtime:** pending. This round will route a request through a registry, consume the normalized stream, aggregate one `LLMTurnResult`, and apply abort semantics.
- **Phase 4C — OpenAI-Compatible + AI SDK Adapter:** pending. This round will add concrete provider-wire adapters. AI SDK types may appear only inside adapter implementations.

```text
Future AgentLoop → LLMGateway (Phase 4B) → LLMProvider → provider adapter (Phase 4C)
```

## Provider Turn

`LLMRequest` is one Provider Turn Request, not an `AgentRun`. `LLMTurnResult` is the normalized result of exactly that turn. A provider may receive message history and data-only Protocol `ToolDefinition` values, but it never executes a local tool, continues the AgentLoop, persists an event, or owns retry policy.

Provider routing is explicit: the future gateway uses `ModelRef.provider` to look up an `LLMProvider` in an injected `LLMProviderRegistry`. It never guesses a provider from a model-name prefix.

## Provider boundary

`LLMProvider` is a runtime interface:

```ts
interface LLMProvider {
  readonly id: ProviderId;
  supportsModel(model: ModelRef): boolean;
  getCapabilities(model: ModelRef): LLMCapabilities;
  stream(request: LLMProviderRequest, signal: AbortSignal): AsyncIterable<LLMStreamEvent>;
}
```

`LLMProviderRequest` is an alias of Caelush's `LLMRequest`. Providers may hold credentials, clients, and functions internally, but those runtime values never enter Protocol, SQLite, `AgentState`, or `AgentEvent` payloads. The registry is explicitly instantiated; there is no module-level singleton.

## Messages

Phase 4A supports text, tool calls, and compact tool results only:

- `system` and `user` messages contain a string. Empty system content is valid for future dynamic context construction.
- `assistant` content is a non-empty array of text and/or normalized tool-call parts. Text is optional, so a tool-only assistant message is valid.
- `tool` messages contain `toolCallId`, `toolName`, compact string `content`, and `isError`. Protocol `Observation.details` is not copied into the model context.

Message schemas are strict and discriminated by `role`. Images, audio, video, files, attachments, and provider-specific options are not part of this round. Messages remain JSON-safe and support parse → JSON stringify → parse → parse round-trips.

## Capabilities

Every V1 capability is `SUPPORTED`, `UNSUPPORTED`, or `UNKNOWN`. `UNKNOWN` is intentional: it is different from a provider having explicitly reported that a capability is unsupported. The capabilities are text streaming, tool calling, parallel tool calls, structured output, vision, and reasoning summary. Context-window and maximum-output token limits are optional and are omitted when unknown.

## Usage

`LLMUsage` contains optional nonnegative integer fields: `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, and `reasoningTokens`. A provider omission stays omitted; the package never fabricates a zero. Phase 4B will own any stream aggregation and will ensure a final usage report is counted once when an intermediate `usage` event and `stream.finish.finalUsage` both exist.

## Stream Events

The normalized provider vocabulary is exactly:

- `stream.start`
- `text.delta`
- `tool_call.start`
- `tool_call.delta`
- `tool_call.completed`
- `usage`
- `stream.finish`

`text.delta` is non-empty. `tool_call.delta` is an unparsed partial JSON string. A completed tool call contains only `id`, `name`, and a `JsonObject` `input`; it does not retain partial `rawInput`. `stream.finish` contains a normalized `FinishReason` and optional `finalUsage`.

There is no `stream.error`, `reasoning.delta`, `tool_result`, `tool_execution`, `approval`, or `retry` event. Provider failures are typed exceptions. An external abort throws `LLMAbortedError` and does not fabricate a successful `stream.finish`.

## Error model

The package exposes `LLMError` and typed subclasses for missing providers, unsupported models/capabilities, authentication, rate limits, network failures, timeouts, aborts, invalid responses, and provider failures. Each error has a stable code, message, optional provider/model context, and retryable classification. Retryability is not retry behavior; Phase 4A, 4B, and 4C do not retry.

Error messages and fields must not contain API keys, authorization headers, complete prompts, or other request secrets.

## AI SDK isolation

No AI SDK dependency is installed in Phase 4A. The public LLM contract does not import `ai`, `@ai-sdk/*`, or provider SDK types. Future Phase 4C adapters may know those SDKs, but only within adapter implementation modules; Caelush messages, request/result types, event vocabulary, gateway contracts, and Core must remain SDK-independent.

## No raw chain-of-thought

Raw provider reasoning text is not a Caelush public contract. There is no reasoning delta event, chain-of-thought field, or hidden-thinking content type. A provider may report reasoning token counts through `LLMUsage`; a future AgentLoop may expose its own public `reasoning.summary`, but that is not provider hidden reasoning.
