# Caelush Architecture V2 — Phase 2B: OpenAI-compatible Runtime Migration & `@caelush/llm` Compatibility Shim

Phase 2B performs the second real subsystem migration. It reaches **Compatibility
Stage B** of the frozen AI Model Invocation V2 design:

```text
packages/ai/src/adapters/openai-compatible   = canonical OpenAI-compatible runtime
packages/llm                                  = legacy compatibility facade
packages/llm  →  packages/ai                  = the sanctioned direction
```

The round's whole point is ownership transfer, not file relocation: every piece of
provider dialect work — the SDK client, message and tool translation, stream
parsing, usage normalisation, finish mapping and provider error normalisation —
now has exactly one implementation, and it lives in `@caelush/ai`.

No consumer was cut over. `apps/daemon/src/**` is unchanged and still imports
`@caelush/llm`; consumer cutover is Phase 2C.

---

## 1. Current → target ownership map

| Before (`packages/llm/src/providers/openai-compatible/`) | Operation     | After                                                                                                                                                                     |
| -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts` (options + URL/id validation)                | FACADE        | `packages/llm/src/providers/openai-compatible/config.ts`, delegating endpoint validation to `assertProviderEndpoint` in `@caelush/ai`                                     |
| `provider.ts` (SDK provider class)                       | REWRITE       | `packages/llm/src/providers/openai-compatible/provider.ts` is now a thin facade; the canonical provider abstraction is `AIProviderBinding` + `ApiAdapter`                 |
| `messages.ts` → AI SDK messages                          | MOVE          | `packages/ai/src/adapters/openai-compatible/message-translator.ts`                                                                                                        |
| `tools.ts` → AI SDK tools/tool choice                    | MOVE          | `packages/ai/src/adapters/openai-compatible/tool-translator.ts`                                                                                                           |
| `stream.ts` → `LLMStreamEvent`                           | MOVE + ADAPT  | `packages/ai/src/adapters/openai-compatible/stream-translator.ts` + `adapter.ts`; envelope emission became `adapter.finish` and moved to the gateway                      |
| `finish.ts` → `FinishReason`                             | MOVE          | `packages/ai/src/adapters/openai-compatible/finish-reason.ts`                                                                                                             |
| `usage.ts` → `LLMUsage`                                  | MOVE          | `packages/ai/src/adapters/openai-compatible/usage-normalizer.ts`                                                                                                          |
| `errors.ts` → `LLMError`                                 | MOVE + ADAPT  | `packages/ai/src/adapters/openai-compatible/error-normalizer.ts` now produces `AIError`; the AI→legacy projection is `packages/llm/src/compatibility/error-projection.ts` |
| `raw-chunk.ts` ambiguity guard                           | MOVE + EXTEND | `packages/ai/src/adapters/openai-compatible/raw-tool-state.ts`; it now also captures the provider-native finish reason                                                    |
| `tool-call-parser.ts`                                    | MOVE + ADAPT  | `packages/ai/src/adapters/openai-compatible/tool-call-parser.ts`; Protocol's zod schema replaced by the AI-local JSON guard                                               |
| —                                                        | NEW           | `sdk-client.ts`, `request-options.ts`, `adapter.ts`, `index.ts`                                                                                                           |

Deleted from `packages/llm`: `messages.ts`, `tools.ts`, `usage.ts`, `finish.ts`,
`errors.ts`, `raw-chunk.ts`, `tool-call-parser.ts`, `stream.ts`. The legacy
directory now holds exactly `config.ts`, `index.ts` and `provider.ts`.

---

## 2. The adapter

```ts
import { createOpenAICompatibleApiAdapter } from "@caelush/ai/adapters/openai-compatible";

const adapter = createOpenAICompatibleApiAdapter(); // ApiAdapter, id "openai-compatible-chat"
```

The factory takes **no options on purpose**. Every candidate option would either
change the frozen dialect id or weaken a required guarantee: retries are always
disabled, the abort signal is always forwarded, raw-chunk inspection is always
enabled, and the dialect id is fixed by the frozen design.

What it does per turn:

1. Resolve the dialect-native request options from the frozen resolution
   (`request-options.ts`). A resolution this dialect cannot express fails closed
   **before** any transport exists.
2. Build the upstream client from `ResolvedProviderConnection` only
   (`sdk-client.ts`): endpoint, credentials, headers, query params and transport.
3. Translate the frozen request (`message-translator.ts`, `tool-translator.ts`).
4. Run exactly one `streamText` call with `maxRetries: 0`, `includeRawChunks: true`
   and `abortSignal: input.signal`.
5. Translate each stream part into `AIAdapterEvent` (`stream-translator.ts`).

It emits only `text.delta`, the tool-call lifecycle, `usage` and `adapter.finish`.
It cannot emit `stream.start`, `stream.finish` or `stream.error`, because
`AIAdapterEvent` has no such variants — envelope authority stays with
`AIGateway`, enforced by the type system rather than by convention.

### What the pinned SDK actually offers

The SDK was inspected in `node_modules` rather than assumed:

- `@ai-sdk/openai-compatible@3.0.39` chat options are
  `user`, `reasoningEffort`, `textVerbosity`, `strictJsonSchema`, passed through
  `providerOptions` keyed by the provider name. `reasoningEffort` becomes the wire
  field `reasoning_effort`.
- There is **no prompt-cache control** in this SDK, and the chat-options schema is
  `.strip()`-ed with no `extraBody`, so a retention cannot be smuggled through.
- The SDK's reasoning stream parts are sourced from the provider's raw
  `reasoning_content` / `reasoning` delta, i.e. undisclosed chain-of-thought.

---

## 3. Reasoning and cache

`ReasoningResolver` owns "requested semantic level → effective semantic level".
The adapter owns only "effective level → provider-native option".

```text
MINIMAL → minimal      LOW → low        MEDIUM → medium     HIGH → high
OFF     → no option sent at all
XHIGH   → fails closed as AI_CAPABILITY_UNSUPPORTED
```

`OFF` deliberately sends nothing: it means "do not steer reasoning", and inventing
a native `none` value would be a claim this dialect does not make.

A host may extend the table per model through
`ModelDescriptor.adapterMetadata["openai-compatible"].reasoningEffortByLevel`,
for example `{ XHIGH: "xhigh" }`. **No provider name is ever inspected** — there is
no `if (providerId === …)`, no `includes("qwen")`, no OpenRouter special case.

Cache: this dialect cannot express `SHORT` or `LONG`, so a non-`NONE` effective
retention **fails closed** as `AI_CAPABILITY_UNSUPPORTED` instead of being silently
dropped. The descriptor is the authority; declaring cache support for a dialect
that cannot deliver it is a configuration contradiction, and the Phase 2A rule
"never silently ignore a resolution" applies to both.

---

## 4. Routing authority

```text
endpoint      ResolvedProviderConnection.endpoint   (from AIProviderBinding)
credentials   resolved per invocation, then merged
headers       binding headers ⊕ credential headers  (credentials win)
query params  binding query params ⊕ credential query params
transport     binding transport override
```

`ModelRef.baseUrl` is **never read** by the adapter. It is projected into the AI
request only as the legacy compatibility field it is, and the _legacy_ stream
envelope echoes the requested ref verbatim because the legacy validator compares
it. Endpoint authority comes from the provider registry alone — proven by a test
that sets `baseUrl: "http://attacker.example"` while the configured endpoint is
`expected.example` and asserts the real transport URL.

---

## 5. Retry, abort and timeout

- `maxRetries: 0` is set explicitly, never inherited from a default. A conformance
  test asserts exactly one transport attempt for authentication, rate-limit,
  transport and context-overflow failures.
- The adapter performs no retry of its own: no loop, no sleep, no backoff, no
  wrapper. Retry authority stays with the durable run layer.
- `input.signal` is handed to `streamText` as `abortSignal`, so a cancellation
  stops the network request rather than merely stopping the consumer loop. A
  conformance test observes the abort at the transport.
- The adapter owns **no timeout**. The legacy `LLMGateway` remains the single
  timeout authority on the legacy path; the compatibility facade forwards the
  legacy signal with no default timeout of its own, so no second timer exists.

---

## 6. Tool protocol

- Input is `readonly AIToolSpec[]`; `ToolDefinition` never reaches the adapter.
- The legacy projection takes `name`, `description` and `inputSchema` and drops
  `outputSchema`, `riskLevel`, `requiredCapabilities`, `runtimeRequirements` and
  any handler. A request golden test asserts none of those strings appear in the
  provider request body.
- Declaration order is preserved end to end and never sorted, so a stable tool
  prefix stays byte-identical and prompt caching over that prefix keeps working.
- The raw-chunk ambiguity guard moved with its behaviour intact: a delta carrying
  neither an `id` nor an `index` while several calls are open fails closed as
  `AI_INVALID_RESPONSE`, and a whitespace tool-call id does too.
- Tool input parsing keeps the single sanctioned repair (a trailing comma in an
  otherwise complete object) and still refuses to guess unquoted keys, complete a
  prefix, or accept a non-object.

---

## 7. Error mapping

| Native / SDK signal                                                   | `AIErrorCode`                                               | Legacy class                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| HTTP 401 / 403                                                        | `AI_AUTHENTICATION`                                         | `LLMAuthenticationError`        |
| HTTP 429                                                              | `AI_RATE_LIMIT` (retryable, `retry-after` → `retryAfterMs`) | `LLMRateLimitError`             |
| transport throw, no status                                            | `AI_NETWORK`                                                | `LLMNetworkError`               |
| explicit native overflow code, then message pattern                   | `AI_CONTEXT_OVERFLOW`                                       | `LLMContextOverflowError`       |
| `JSONParseError` / `TypeValidationError` / `InvalidResponseDataError` | `AI_INVALID_RESPONSE`                                       | `LLMInvalidResponseError`       |
| any other 4xx / 5xx                                                   | `AI_PROVIDER_ERROR`                                         | `LLMProviderError`              |
| SDK prompt/validation error                                           | `AI_INVALID_REQUEST`                                        | `LLMInvalidRequestError`        |
| SDK unsupported functionality                                         | `AI_CAPABILITY_UNSUPPORTED`                                 | `LLMCapabilityUnsupportedError` |
| SDK model/setting load error                                          | `AI_MODEL_UNSUPPORTED` / `AI_AUTHENTICATION`                | matching class                  |
| gateway-owned abort                                                   | `AI_ABORTED`                                                | `LLMAbortedError`               |

A generic `400` is never treated as context overflow, and the overflow check
follows the frozen precedence: explicit native code, then structured error object,
then explicit message pattern, then a high-confidence heuristic.

The bridge constructs real legacy classes rather than aliasing `AIError`, because
existing consumers branch on `instanceof`. `retryable`, `retryAfterMs`,
`providerId` and `model` are carried across unchanged; the bridge never
re-derives a retry policy. Two AI-only codes have no legacy equivalent and map to
the safest legacy failure: `AI_MODEL_METADATA_INCOMPLETE` →
`LLMModelUnsupportedError`, `AI_ADAPTER_NOT_FOUND` → `LLMProviderError`.

Adapter error messages never contain raw headers, a raw request, a credential, a
query secret or a raw response body; the gateway sanitizer remains the final
boundary.

---

## 8. The compatibility shim

What remains in `packages/llm`:

```text
legacy types and zod schemas      messages, request, events, usage, tool-call, result
legacy error hierarchy            LLMError and its subclasses
legacy lifecycle                  LLMGateway, LLMProviderRegistry, AbortScope, stream validator
legacy request projection         compatibility/request-projection.ts
legacy error projection           compatibility/error-projection.ts
legacy stream projection          compatibility/stream-projection.ts
legacy JSON boundary              compatibility/legacy-json.ts
legacy provider facade            providers/openai-compatible/provider.ts
legacy wire diagnostic            wire-diagnostic.ts (kept, still secret-safe)
```

What it no longer owns: the provider SDK, the OpenAI request body, the OpenAI
stream parser, tool translation, usage normalisation, finish mapping or provider
error normalisation.

**Preserved legacy surface** (unchanged signatures): `LLMRequest`,
`LLMToolChoice`, `LLMMessage`, `LLMCapabilities`, `LLMUsage`, `LLMToolCall`,
`FinishReason`, `LLMTurnResult`, `LLMStreamEvent`, the `LLMError` hierarchy,
`LLMProvider`, `LLMProviderRegistry`, `LLMGateway`, and
`createOpenAICompatibleLLMProvider` with `OpenAICompatibleLLMProviderOptions`.

`LLMGateway.stream()` stays **synchronous**, returning `LLMStream`. Making it
async would force a consumer change now, which is Phase 2C's job — so the facade
runs the asynchronous AI preflight lazily, inside the provider's async generator,
after the gateway has already returned a stream.

### How the legacy request is projected

```text
LLMRequest.model            → AI ModelRef (baseUrl projected only when present)
LLMMessage[]                → AIMessage[]  (rawArtifactRef dropped: not provider input)
ToolDefinition[]            → AIToolSpec[] (metadata dropped)
LLMToolChoice               → AIToolChoice
maxOutputTokens/temperature → settings
```

### How the AI result is projected back

```text
AIAdapterEvent text/tool/usage → legacy LLMStreamEvent (same shapes)
AIAdapterEvent adapter.finish  → legacy stream.finish, finish reason unchanged
reasoning.summary.delta        → dropped (the legacy union has no member for it,
                                  and folding it into text.delta would corrupt
                                  assistant content with chain-of-thought)
envelope stream.start          → rebuilt by the facade from the legacy call id
AIError                        → legacy LLMError class (thrown, matching the
                                  legacy gateway's existing contract)
```

`AIModelTurnResult.resolution` has no legacy equivalent and is dropped; the legacy
turn-result schema is not widened, so no consumer is forced to handle a new field.

---

## 9. Correction carried into Phase 2A code

The wire-contract integration test in `tests/integration` caught a real behaviour
change: the Phase 2A resolver filled `maxOutputTokens` with the model limit when
the caller named none, which made the compatibility facade send a `max_tokens` the
legacy caller never asked for — silently capping legacy output at the compatibility
descriptor's fallback.

That was wrong on the frozen contract's own terms: step 11 validates a requested
ceiling against the model limit; it does not invent one. An absent request now
stays absent, `AIInvocationResolution.maxOutputTokens` stays optional, and the
provider default applies. The AI request golden test asserts `max_tokens` is
absent when nothing was requested.

---

## 10. SDK isolation guardrail

Phase 2A banned provider SDKs from `packages/ai` entirely. Phase 2B **upgrades**
that rule rather than deleting it:

```text
packages/ai/src/adapters/openai-compatible/**   the only place a provider SDK may be imported
packages/ai/src/{gateway,models,providers,request,messages,errors,stream,tools,…}   SDK-free
packages/llm/src/**                             provider SDK imports = 0
packages/ai/dist/**/*.d.ts                      SDK mentions confined to adapters/openai-compatible
public declaration closure (both packages)      no SDK specifier and no SDK type name
```

The declaration rule is enforced over the **publicly reachable** closure — the
files the `exports` map reaches, transitively — because an internal adapter file
legitimately mentions SDK types while nothing public may. The legacy package's own
SDK-isolation test lost its old exception and is now absolute.

---

## 11. Tests

```text
packages/ai/test/adapters/openai-compatible/**   adapter units, request golden, stream golden,
                                                 two-provider/one-adapter
packages/ai/test/adapters/conformance/**         reusable conformance suite + the OpenAI run
packages/llm/test/**                             legacy contract suite, unchanged and passing
```

The conformance suite is dialect-independent: it drives any `ApiAdapter` through
the real gateway over a controlled transport and asserts envelope authority, tool
lifecycle, finish and usage mapping, no retry, error mapping, abort propagation,
secret safety, and reasoning/cache translation-or-fail-closed. A dialect supplies
its own wire scripts plus two translation hooks, so Phase 2D's Anthropic adapter
can reuse the entire suite.

All adapter tests use scripted SSE over a capturing `fetch`. No test reaches a real
provider endpoint or uses a real credential; the fixed value `fake-api-secret-123`
is used only to prove it never appears in a public event.

---

## 12. Handover to Phase 2C

- **Consumer cutover.** `apps/daemon/src/daemon-composition.ts` still builds an
  `LLMProviderRegistry` + `LLMGateway`. It can now be re-pointed at
  `createAISubsystem()` without moving any provider code.
- **Model authority convergence.** The compatibility descriptor built in
  `capability-projection.ts` exists only to satisfy the adapter input contract for
  one legacy turn. It is not model authority, it is never enumerated, and
  `ModelDescriptor` becoming the Context limit authority is 2C work.
- **Protocol projection.** `toProtocolJsonObject` and the `ModelRef`/`LLMCallId`
  projections in `compatibility/legacy-json.ts` are the seed of the boundary
  projection 2C formalises.
- **Reasoning and cache for the legacy path.** The legacy request has no field for
  either, so both resolvers always report "not requested". If 2C adds those fields
  to the legacy surface, the descriptor will need a real reasoning profile.
- **Wire diagnostic.** Still owned by `packages/llm` and still secret-safe. 2C
  decides whether it becomes an AI-core diagnostic.
