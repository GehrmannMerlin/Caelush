# LLM Gateway Architecture

Caelush owns the AgentLoop. `@caelush/llm` is the provider-neutral boundary beneath that future loop: it describes one provider turn, validates normalized provider output, and keeps provider runtime objects separate from Protocol, persistence, and UI contracts.

## Phase boundary

Phase 4 is intentionally split into three rounds:

- **Phase 4A — LLM Contracts & Provider Foundation:** complete. It defines Caelush-owned messages, `LLMRequest`, capabilities, usage, normalized stream events, typed errors, `LLMProvider`, and an explicit provider registry. It does not connect a real model.
- **Phase 4B — LLMGateway & Streaming Runtime:** complete for the current round. It routes one request through an injected registry, creates the call identity, lazily invokes one provider turn, validates the runtime stream, handles abort scope, and aggregates `LLMTurnResult`.
- **Phase 4C-1 — OpenAI-Compatible Adapter Foundation:** complete. `@caelush/llm` now contains a runtime-only OpenAI-compatible adapter built on the pinned AI SDK transport, with message/tool projection, normalized streaming, usage/finish mapping, typed transport errors, and custom-fetch integration coverage.
- **Phase 4C-2 — OpenAI-Compatible Compatibility Hardening:** complete. It characterizes fragmented and malformed tool streams through the real AI SDK path, preserves safe provider identities, fails closed for ambiguous identity, records the compatibility matrix, and provides an opt-in real-provider smoke utility.

```text
Future AgentLoop
      │
      ▼
  LLMGateway (Phase 4B)
      │
      ▼
 Provider Registry
      │
      ▼
 LLMProvider (one turn)
      │
      ├── OpenAI-compatible adapter (Phase 4C-1)
      ├── Future Anthropic adapter
      ├── Future Gemini adapter
      └── Deterministic test provider
```

## Provider turn and ownership

`LLMRequest` is one Provider Turn Request, not an `AgentRun`. One `LLMGateway.stream()` or `complete()` invocation performs at most one `LLMProvider.stream()` call and never retries. A provider never executes a local tool, continues the conversation, publishes an `AgentEvent`, writes Storage, or owns retry policy.

The Gateway owns:

- routing through `ModelRef.provider` and the injected `LLMProviderRegistry`;
- synchronous request/capability preflight;
- creation and correlation of `LLMCallId`;
- external abort, timeout, and consumer-cancellation scope;
- runtime event, stream, and tool-call invariants;
- one-turn text/tool/usage aggregation.

The Provider owns exactly one upstream provider turn and normalizes that provider's output into Caelush's `LLMStreamEvent` vocabulary. The future AgentLoop owns continuation, tool dispatch, context construction, verification, and run-level policy; none of those are in Phase 4.

## Provider boundary and call context

The provider boundary is runtime-only:

```ts
interface LLMProviderCallContext {
  readonly callId: LLMCallId;
  readonly signal: AbortSignal;
}

interface LLMProvider {
  readonly id: ProviderId;
  supportsModel(model: ModelRef): boolean;
  getCapabilities(model: ModelRef): LLMCapabilities;
  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent>;
}
```

Providers may hold credentials, clients, and functions internally, but those runtime values never enter Protocol, SQLite, `AgentState`, or `AgentEvent` payloads. `LLMProviderRegistry` is explicitly instantiated and injected; there is no module-level singleton.

## Call lifecycle

```text
gateway.stream(request)
        │
        ├── validate request schema and cross-field semantics
        ├── resolve ModelRef.provider in injected registry
        ├── check model support and capability preflight
        ├── create gateway-owned LLMCallId
        │
        ▼
      LLMStream
        │
        │ consumer begins iteration
        ▼
 create abort scope
        │
        ▼
 provider.stream(
   request,
   { callId, signal }
 )
        │
        ▼
 runtime schema validation
        │
        ▼
 stream/tool lifecycle validation
        │
        ▼
 downstream normalized events
        │
        ▼
 cleanup
```

`gateway.stream()` performs semantic preflight synchronously but provider execution is lazy. The provider receives the exact Gateway call id. The first `stream.start` must contain the selected provider id, exact call id, and matching model identity; a mismatch is `LLMInvalidResponseError`.

## Request preflight

The existing strict `LLMRequestSchema` remains the source of truth for request shape. Gateway cross-field validation additionally rejects duplicate tool names, a named `TOOL` choice without a matching definition, `REQUIRED` without tools, unsupported tool calling, and a known `maxOutputTokens` limit exceeded. `UNKNOWN` capability/limit metadata is not treated as a false negative. `temperature` remains schema-bounded but is not capability-guessed by the Gateway.

## Messages

Phase 4A supports text, tool calls, and compact tool results only:

- `system` and `user` messages contain a string; empty system content is valid for future dynamic context construction.
- `assistant` content is a non-empty array of text and/or normalized tool-call parts. Text is optional, so a tool-only assistant message is valid.
- `tool` messages contain `toolCallId`, `toolName`, compact string `content`, and `isError`. Protocol `Observation.details` is not copied into model context.

Message schemas are strict and discriminated by `role`. Images, audio, video, files, attachments, and provider-specific options are not part of this phase. Messages remain JSON-safe and support parse → JSON stringify → parse → parse round-trips.

## Capabilities and usage

Every V1 capability is `SUPPORTED`, `UNSUPPORTED`, or `UNKNOWN`. `UNKNOWN` differs from an explicitly unsupported capability. The capabilities are text streaming, tool calling, parallel tool calls, structured output, vision, and reasoning summary. Context-window and maximum-output limits are optional and omitted when unknown.

`LLMUsage` contains optional nonnegative integer fields: `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, and `reasoningTokens`. Missing provider fields remain omitted. During `complete()`, the last `usage` event is the latest snapshot; `stream.finish.finalUsage`, when present, is authoritative. Snapshots are never added together, so usage cannot be double-counted.

## Normalized stream events and state machines

The only event vocabulary is:

```text
stream.start
text.delta
tool_call.start
tool_call.delta
tool_call.completed
usage
stream.finish
```

Every provider event is parsed again with `LLMStreamEventSchema` at runtime even though the TypeScript boundary is typed. This protects the Gateway from JavaScript providers, SDK adapters, stale implementations, and malicious runtime values. A parse or invariant failure becomes a typed `LLMInvalidResponseError`; the raw event is not placed in its public message.

The stream state machine is:

```text
NOT_STARTED ── stream.start ──▶ STARTED ── stream.finish ──▶ FINISHED
```

Invalid transitions include missing start, duplicate start, normal end without finish, duplicate finish, and any event after finish. `stream.start` → `stream.finish` is valid.

Each tool call has an independent lifecycle:

```text
NOT_STARTED ── tool_call.start ──▶ STARTED ── tool_call.completed ──▶ COMPLETED
```

`tool_call.delta` is legal only while started. Completion id/name must match the start, a completed call cannot restart or receive more deltas, and finish rejects open calls. Multiple tool calls may interleave; `complete()` preserves the order in which completed events arrive. Partial JSON deltas are strings and are never parsed by the Gateway; completed calls already contain a `JsonObject` input.

## Abort, timeout, and consumer cancellation

The internal abort scope combines an optional external signal, an explicit timeout timer (default 120 seconds), and a consumer-cancellation controller. These causes remain distinct:

- pre-aborted or externally aborted calls throw `LLMAbortedError` and do not fabricate `stream.finish`;
- timeout aborts the provider signal and throws `LLMTimeoutError`;
- an early consumer `break` aborts the provider, attempts iterator cleanup, and does not create an unhandled cancellation error for the caller.

Timers and abort listeners are cleaned after normal finish, error, abort, timeout, or consumer cancellation. The Gateway does not rely on a dangling 120-second timer for completed calls.

## Error model and retry boundary

`LLMError` subclasses cover lookup, model/capability, authentication, rate limit, network, timeout, abort, invalid response, invalid request, and provider failures. Typed provider errors remain typed. Unknown thrown values become `LLMProviderError` with a safe generic message and runtime cause; prompts, tool arguments, credentials, headers, and full request payloads never enter public error messages.

`retryable` is classification only. Phase 4A, 4B, and 4C do not retry, sleep, or make a second provider call.

## AI SDK isolation and raw reasoning rule

The OpenAI-compatible adapter is the only current runtime boundary allowed to import `ai` and `@ai-sdk/openai-compatible`. The public LLM contract does not import `ai`, `@ai-sdk/*`, or provider SDK types. `createOpenAICompatibleLLMProvider()` exposes only Caelush-owned options; AI SDK messages, tools, models, stream results, and errors remain adapter-private. Architecture and declaration tests enforce this isolation across Core, Protocol, Events, Storage, Daemon, and the rest of `@caelush/llm`.

## OpenAI-compatible adapter boundary

```text
LLMGateway (Phase 4B)
        │ existing LLMProvider contract
        ▼
OpenAICompatibleLLMProvider (Phase 4C-1)
        │ adapter-private message/tool/stream/error conversion
        ▼
AI SDK `streamText()`
        │ `@ai-sdk/openai-compatible` chat model
        ▼
OpenAI-compatible HTTP API
```

AI SDK is not Caelush's Agent Runtime. The adapter performs exactly one provider turn and never runs an Agent, Workflow, ToolLoop, `stopWhen`, `prepareStep`, or local tool callback. Caelush messages are projected to the current AI SDK `ModelMessage` shape: system and user text are preserved, assistant tool-only messages remain tool-only, assistant tool calls retain their IDs, and tool failures use the AI SDK error-text result form. Tool definitions project only `name`, `description`, and the existing JSON Schema; the generated AI SDK tools deliberately have no `execute`, approval, or execution callback.

The Gateway remains the owner of `LLMCallId`, timeout, abort-cause semantics, stream lifecycle validation, and result aggregation. The adapter forwards the Gateway-owned `AbortSignal` unchanged, does not create a timeout, and sets AI SDK `maxRetries: 0`; retry policy belongs to a future policy layer. The adapter emits only Caelush `stream.start`, text, tool lifecycle, usage, and finish events, drops raw reasoning text, and normalizes provider errors without exposing credentials or raw SDK payloads.

Raw provider chain-of-thought is not a Caelush public contract. There is no reasoning delta event, chain-of-thought field, or hidden-thinking content type. A provider may report reasoning token counts through `LLMUsage`; a future AgentLoop may expose its own public `reasoning.summary`, but that is not provider hidden reasoning.

## Phase 4 completion boundary

Gateway runtime and the first OpenAI-compatible adapter are complete for
Phase 4B, Phase 4C-1, and Phase 4C-2. The compatibility matrix is documented
in `docs/architecture/openai-compatible-compatibility.md`. The adapter has one
narrow private raw-chunk identity guard for ambiguous multi-call deltas; it
does not patch the Gateway, invent tool identities, or reimplement the SSE
parser. No AgentLoop, local tool execution, Daemon model configuration,
Storage integration, or EventBus bridge exists yet. Those capabilities belong
to subsequent work, with Phase 5 explicitly out of scope for this boundary.
