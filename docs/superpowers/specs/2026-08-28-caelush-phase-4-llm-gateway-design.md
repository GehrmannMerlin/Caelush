# Caelush Phase 4 LLM Gateway Design

## Status and scope

This design is approved by the Phase 4A implementation brief. Phase 4 is intentionally split into three independently scoped rounds:

1. **Phase 4A — LLM Contracts & Provider Foundation:** define Caelush-owned LLM messages, provider-turn request/result data, capabilities, usage, normalized stream events, typed errors, the provider runtime boundary, and an explicitly injected provider registry. No gateway execution, provider SDK, network request, AgentLoop, or local tool execution is included.
2. **Phase 4B — LLMGateway & Streaming Runtime:** add the gateway behavior that routes a provider turn, consumes normalized events, produces a turn result, and applies runtime/abort semantics. This round is pending and is not implemented by Phase 4A.
3. **Phase 4C — OpenAI-Compatible + AI SDK Adapter:** add concrete provider adapters and any provider-wire projection required by them. AI SDK types may appear only inside adapter implementations. This round is pending and is not implemented by Phase 4A.

The architectural direction is:

```text
Future AgentLoop → future LLMGateway → LLMProvider → concrete provider adapter
                                             ├── OpenAI-compatible
                                             ├── Anthropic
                                             ├── Gemini
                                             └── deterministic test provider
```

The provider boundary represents exactly one provider turn. A provider never executes local tools, continues the conversation, owns retry policy, or enters Protocol/SQLite/AgentState. The future AgentLoop remains a Caelush-owned Core concern.

## Boundary and dependencies

`@caelush/llm` is a feature package below future Core composition and above the stable Protocol primitives. It imports only `@caelush/protocol` and the already pinned `zod@4.4.3` in Phase 4A. It does not import `ai`, `@ai-sdk/*`, OpenAI, Anthropic, Gemini, an app, a runtime, a dispatcher, or an HTTP layer.

Protocol remains the source of truth for `ModelRef`, `JsonValue`, `JsonObject`, and `ToolDefinition`. LLM execution-boundary contracts stay in `@caelush/llm`; they are not added to Protocol except for the missing `LLMCallId` UUIDv7 identifier. Provider instances and credentials are runtime-only values and never become Protocol entities, database rows, AgentState, or AgentEvent payloads.

## Reference LLM Architecture Notes

The following short notes are distilled from read-only inspection of the requested reference projects. They inform the boundary without copying their APIs:

1. OpenCode's proposed LLM design treats one provider turn and a multi-turn model run as different primitives; Caelush adopts that distinction as `LLMRequest`/`LLMTurnResult` versus the future AgentLoop.
2. OpenCode explicitly separates portable request/event data from process-local configured providers, executable tools, and hooks; Caelush keeps schemas JSON-safe and Provider as a runtime object.
3. OpenCode rejects a global provider/model registry as a core design; Caelush uses an explicitly constructed, injected `LLMProviderRegistry`.
4. Pi's provider collection keeps provider identity explicit and uses provider-owned streaming, rather than guessing a provider from a model-name prefix; Caelush routes by `ModelRef.provider`.
5. Pi's provider abstraction distinguishes provider metadata/catalog data from the runtime stream implementation; Caelush likewise keeps only a narrow `LLMProvider` boundary in this round.
6. Vercel AI's model stream vocabulary separates text deltas, tool input deltas, completed tool calls, finish, abort, and error paths; Caelush freezes a smaller provider-neutral vocabulary and represents failures as typed exceptions rather than `stream.error` data.
7. Vercel AI exposes provider-specific options and raw chunks at a higher layer; Caelush deliberately has no `providerOptions` escape hatch in Phase 4A and does not export raw provider payloads.
8. The references support keeping local tool execution outside provider streams: normalized tool-call events describe model output only, while a future AgentLoop/Dispatcher will execute tools and append compact tool-result messages.

References: [OpenCode LLM design](https://github.com/anomalyco/opencode/blob/dev/packages/llm/DESIGN.md), [OpenCode session model](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md), [Pi model/provider notes](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/models.md), [Pi AI package](https://github.com/q-qp-p/earendil-works-pi/blob/main/packages/ai/README.md), [Vercel AI streamText](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.ts), and [Vercel AI stream result types](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text-result.ts).

## LLM messages and requests

Phase 4A supports only text, tool-call, and compact tool-result content. System and user messages contain a string, with empty system content explicitly valid for future dynamic context construction. Assistant content is a non-empty array of text and/or normalized tool-call parts; an assistant message containing only a tool call is valid and does not require text. Tool-result messages contain only `toolCallId`, `toolName`, compact string `content`, and `isError`; Protocol `Observation.details` is not copied into the model context.

`LLMMessageSchema` is a strict Zod discriminated union by `role`. Every message fixture must survive parse → JSON stringify → JSON parse → parse without changing its shape. Images, audio, video, file uploads, attachments, and provider options are outside this round.

`LLMRequest` represents exactly one Provider Turn Request, not an `AgentRun`. It contains a Protocol `ModelRef`, message history, optional Protocol `ToolDefinition[]`, optional discriminated tool choice (`AUTO`, `NONE`, `REQUIRED`, or a named `TOOL`), and bounded generation options. `temperature` is finite in `[0, 2]`; `maxOutputTokens` is a positive integer. There is no provider-specific options bag.

## Capabilities and usage

Each V1 capability uses `SUPPORTED`, `UNSUPPORTED`, or `UNKNOWN`, preserving the difference between a known negative and unavailable metadata. The capabilities are text streaming, tool calling, parallel tool calls, structured output, vision, and reasoning summary. Context-window and maximum-output token limits are optional positive integers and are omitted when unknown.

`LLMUsage` has optional nonnegative integer fields for input, output, total, cached-input, and reasoning tokens. Missing provider fields remain omitted; `0` is never synthesized. Reasoning token counts may be retained as metadata, but reasoning text never enters a public Caelush contract.

## Normalized stream and result

`LLMStreamEvent` is a strict discriminated union with exactly these event types:

```text
stream.start
text.delta
tool_call.start
tool_call.delta
tool_call.completed
usage
stream.finish
```

`text.delta` is non-empty. `tool_call.delta` remains a string containing partial JSON and is never parsed by the contract layer. `tool_call.completed` carries an `LLMToolCall` whose `input` is already a `JsonObject`; completed calls do not retain `rawInput`. `stream.finish` carries a normalized `FinishReason` and optional `finalUsage`. There is no `stream.error`, `reasoning.delta`, `tool_result`, execution, approval, or retry event. Provider failure and external abort terminate the async iterable by throwing a typed `LLMError`, specifically `LLMAbortedError` for abort.

`LLMTurnResult` is the normalized result of one provider turn: call/provider/model identity, accumulated text, completed tool calls, finish reason, and optional usage. Phase 4B will own event consumption and single-count usage aggregation; Phase 4A only defines the shape.

## Errors and Provider boundary

The typed hierarchy includes `LLMError`, provider/model/capability lookup errors, authentication/rate-limit/network/timeout/abort errors, invalid-response errors, and a provider error. Every error carries a stable code, message, retryable classification, and optional provider/model context. Error messages and fields must not contain API keys, authorization headers, full prompts, or raw request secrets. Retryability is classification only; no Phase 4 round performs retries.

`LLMProvider` is a runtime interface with an explicit provider id, `supportsModel(ModelRef)`, `getCapabilities(ModelRef)`, and `stream(LLMProviderRequest, AbortSignal): AsyncIterable<LLMStreamEvent>`. `LLMProviderRequest` is an alias of the Caelush-owned `LLMRequest`, not a provider SDK type. A provider may hold credentials, clients, and functions internally, but those values never cross the public data contracts.

`LLMProviderRegistry` is an explicitly instantiated class. It supports register, get, has, and list-provider-ids. Provider ids must match `^[a-z][a-z0-9_-]*$`; duplicate registration throws a conflict error instead of replacing an existing provider. There is no module-level map or singleton.

## Isolation and tests

All public symbols are exported only through `@caelush/llm`'s built package entry. The test-only `FakeLLMProvider` lives under `packages/llm/test/support` and is not exported. Architecture tests scan production source for `ai`/`@ai-sdk/` imports and assert the intended package dependency direction. TypeScript narrowing tests use a `switch (event.type)` without `as any`; production source contains zero explicit `any`.

Gateway runtime behavior is pending Phase 4B. Concrete OpenAI-compatible, Anthropic, Gemini, and AI SDK adapters are pending Phase 4C. Phase 4A establishes contracts only and cannot call a real model.
