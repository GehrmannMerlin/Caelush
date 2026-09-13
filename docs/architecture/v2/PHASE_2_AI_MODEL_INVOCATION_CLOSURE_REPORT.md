# Caelush Architecture V2 — Phase 2 Closure Report

**Phase 2 — AI Model Invocation V2 — is complete.**

This report closes the Phase 2 sequence. It records what each round delivered, what
the final ownership of model invocation is, and what deliberately remains outside
the round.

```text
2A  AI Core Contracts & Gateway Foundation                    COMPLETE
2B  OpenAI-compatible Runtime Migration
    & @caelush/llm Compatibility Shim                          COMPLETE
2C  Consumer Cutover & Model Authority Convergence             COMPLETE
2D  Native API Dialect Proof & AI Migration Closure            COMPLETE
```

The decisive question this report answers is:

> Can Caelush execute OpenAI-compatible and Anthropic Messages models through the
> same provider-neutral `AIGateway` without changing Agent, Context, Tool, Run or
> Client contracts?

The answer is **yes**, and the evidence is a single adapter conformance suite that
both dialects pass unchanged, plus a daemon E2E that runs both dialects through one
composition root.

---

## 1. Phase 2A result — AI Core Contracts & Gateway Foundation

Phase 2A created `@caelush/ai` as a workspace-independent package and froze the
model invocation contracts it owns. Every contract is JSON-safe, provider-free and
carries no SDK type.

```text
ApiId · ApiAdapter · ApiAdapterStreamInput · AIAdapterEvent
AIMessage · AISystemMessage · AIUserMessage · AIAssistantMessage · AIToolResultMessage
AIAssistantTextContent · AIAssistantToolCallContent
AIToolSpec · AIToolChoice · AIToolCall
AIModelRequest · AIModelSettings · ResolvedAIModelRequest · AIInvocationResolution
ModelDescriptor · ModelRef · ModelLimits · ModelCapabilities
ModelReasoningProfile · ModelCacheProfile · ModelUsage · AIModelTurnResult
AIProviderBinding · AIProviderDescriptor · ResolvedProviderConnection · ProviderCredentials
ReasoningLevel · ReasoningResolution · CacheRetention · CacheResolution
AIFinishReason · AIError · AIErrorCode · AIStreamEvent · AIGateway
```

Frozen structural decisions that Phase 2D could not revisit and did not need to:

| Decision                                                                    | Why it survived a second native dialect                                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ApiAdapter.id` is an `ApiId`, not a vendor                                 | Two providers share one adapter; two dialects share one gateway                                                                    |
| `AIAdapterEvent` has no envelope variants                                   | `stream.start` / `stream.finish` / `stream.error` remain gateway-only by type                                                      |
| `ApiAdapterStreamInput` carries `provider` + `model` + `request` + `signal` | An adapter gets endpoint and credentials from the connection and never chooses them                                                |
| `AIMessage` is text/tool-first with no opaque provider block                | A dialect needing opaque continuation state must fail closed, not grow the contract                                                |
| `AIErrorCode` is a closed set of 14 codes                                   | `AI_OVERLOADED`, `AI_PERMISSION` and `AI_REQUEST_TOO_LARGE` do not exist; 529 maps to `AI_RATE_LIMIT`, 413 to `AI_INVALID_REQUEST` |
| `ModelDescriptor.api` owns the dialect                                      | The dialect is a property of the model, which is what makes one gateway serve two dialects                                         |

`ApiId` reserved exactly two dialect ids in Phase 2A:
`openai-compatible-chat` and `anthropic-messages`. Phase 2D implemented the second
without adding a third, and without adding a provider-named alias.

---

## 2. Phase 2B result — OpenAI-compatible Runtime Migration

Phase 2B moved every piece of OpenAI dialect work into
`packages/ai/src/adapters/openai-compatible` and reduced `packages/llm` to a
compatibility facade whose only remaining runtime job was projecting AI events back
into the legacy stream shape.

The OpenAI-compatible runtime has exactly one implementation, and it is the AI
adapter. Phase 2D did not create a second one and did not change this adapter's
contract.

---

## 3. Phase 2C result — Consumer Cutover & Model Authority Convergence

Phase 2C cut the production consumers over and converged model authority:

```text
Runtime composition      createAISubsystem(...)          was: LLMGateway + LLMProviderRegistry
Model execution          ModelTurnExecutor(gateway)      was: AgentLoop → LLMGateway
Model metadata           ModelDescriptor                 was: ModelCapabilities projection
Endpoint authority       AIProviderBinding.endpoint      was: ModelRef.baseUrl
```

After Phase 2C, no production source outside `packages/llm` imported the legacy
root entry, `@caelush/llm/request` or `@caelush/llm/errors`, and the only legacy
imports left were the durable conversation schema (`@caelush/llm/messages`) and the
durable turn schema (`@caelush/llm/turn`).

Phase 2D inherited that state unchanged and did not re-open it.

---

## 4. Phase 2D result — Native API Dialect Proof & AI Migration Closure

Phase 2D proved the frozen AI core against a dialect that shares nothing with
OpenAI-compatible chat, then closed the legacy invocation surface.

### 4.1 A real second dialect

```text
packages/ai/src/adapters/anthropic-messages/
├── index.ts               public subpath: the factory and the dialect id
├── adapter.ts             one provider turn over the resolved transport seam
├── adapter-metadata.ts    adapter-private model/connection metadata parser
├── endpoint.ts            deterministic endpoint interpretation
├── headers.ts             anthropic-version, x-api-key, explicit bearer mode
├── message-translator.ts  system hoisting, tool_use, tool_result batching
├── tool-translator.ts     tool spec, frozen tool-choice mapping, cache marker
├── tool-input-parser.ts   accumulated input_json_delta to a validated JsonObject
├── native-options.ts      extended thinking, cache retention, thinking/tool guard
├── request-translator.ts  the complete native request body
├── sse-parser.ts          LF/CRLF, multi-line data, comments, split chunks
├── text-decoder.ts        streaming UTF-8 across chunk boundaries
├── stream-translator.ts   native event state machine, adapter.finish timing
├── finish-reason.ts       native stop reason to AIFinishReason
├── usage-normalizer.ts    cumulative snapshot merging
└── error-normalizer.ts    HTTP and native failure normalisation
```

The dialect is implemented over `fetch` and its own SSE parser. **No Anthropic SDK
is installed or imported**, which is itself the proof: transport ownership stays
with the provider connection's fetch seam, no SDK retry policy can slip in, no SDK
type can reach a public contract, and the frozen `ApiAdapter` abstraction is doing
real work rather than wrapping a vendor client.

### 4.2 Dialect-neutral conformance

The adapter conformance harness was generalized. Before Phase 2D it leaked
OpenAI-specific coupling — its shared type imported the OpenAI-compatible
transport's `CapturedRequest`, and its assertions hard-coded a bearer credential
header, one event sequence and a JSON body view.

```text
test/support/http-capturing-transport.ts    dialect-neutral capture
    CapturedHttpRequest: url, method, headers, bodyText, signal, attempt count

test/adapters/conformance/adapter-conformance.ts   the one shared suite
    credentialAssertion   which header carries the credential
    eventOrder            the exact public sequence this dialect produces
    modelMetadata         what its models declare through the frozen descriptor
    assertNative          the native translation hooks for reasoning and cache
```

Both dialects run **the same suite**: text streaming, tool lifecycle, parallel
tools, usage, STOP/LENGTH/TOOL_CALLS/CONTENT_FILTER/OTHER, authentication,
rate-limit, context overflow, invalid response, network, text-then-failure, abort,
gateway timeout, reasoning, cache, secret containment and no-retry. There is no
per-dialect copy of the suite.

### 4.3 Multi-dialect composition proof

| Proof                                         | What it establishes                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One gateway, two dialects, two providers      | The gateway dispatches by `ModelDescriptor.api` through the adapter registry; only the selected dialect's transport is called                                       |
| One provider binding, two dialects            | Two models of the same provider and endpoint reach two different native protocols; the dialect is a property of the model, not of the provider                      |
| Two Anthropic providers, one adapter instance | An `ApiId` is a dialect, not a vendor; endpoint and credential isolation hold in both directions                                                                    |
| Daemon composition                            | The production composition root registers both adapters while the legacy environment contract keeps selecting `openai-compatible-chat`                              |
| Daemon Anthropic E2E                          | Daemon → AISubsystem → ModelCatalog → ModelTurnExecutor → AIGateway → adapter → fetch produces a verified Agent completion                                          |
| Daemon Anthropic Tool E2E                     | A `tool_use` → Dispatcher → `tool_result` → second native turn round trip completes, and the second request replays the assistant `tool_use` with its `tool_result` |

---

## 5. Final AI package ownership

```text
packages/ai/                                   @caelush/ai
├── src/gateway/          AIGateway, preflight resolver        invocation authority
├── src/adapters/openai-compatible/    OpenAI-compatible dialect
├── src/adapters/anthropic-messages/   Anthropic Messages dialect
├── src/models/           ModelDescriptor, ModelCatalog, limits, capabilities
├── src/providers/        AIProviderBinding, ProviderRegistry, credentials
├── src/request/          AIModelRequest, settings, tool choice, validator
├── src/messages/         AIMessage contract
├── src/tools/            AIToolSpec, AIToolCall, AIFinishReason
├── src/reasoning/        ReasoningLevel and ReasoningResolver
├── src/cache/            CacheRetention and CacheResolver
├── src/stream/           abort scope, stream events, tool-call tracker, assembler
├── src/errors/           AIError, AIErrorCode, sanitizer
└── src/ids/              LLMCallId, ApiId, ProviderId
```

`@caelush/ai` depends on exactly three packages, none of them Caelush:
`@ai-sdk/openai-compatible@3.0.39`, `ai@7.0.83`, `uuid@14.0.2`. The provider SDK is
imported only inside `src/adapters/openai-compatible`; the native Anthropic adapter
imports no SDK at all.

### Supported API dialects

| `ApiId`                  | Implementation                            | Transport                                   | Provider SDK                       |
| ------------------------ | ----------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `openai-compatible-chat` | `@caelush/ai/adapters/openai-compatible`  | AI SDK provider over the connection's fetch | `@ai-sdk/openai-compatible` + `ai` |
| `anthropic-messages`     | `@caelush/ai/adapters/anthropic-messages` | native `fetch` + local SSE parser           | none                               |

Exactly two dialects exist. `anthropic`, `claude`, `claude-api` and
`anthropic-claude` were never created.

---

## 6. Provider / API separation proof

```text
Model != Provider != API dialect

ModelDescriptor.api          chooses the dialect
ApiAdapterRegistry           resolves the dialect to one adapter instance
AIProviderBinding.endpoint   chooses where the request goes
AIProviderBinding.credentials chooses the credential
ResolvedProviderConnection   merges the two for exactly one attempt
ModelRef.baseUrl             participates in nothing
```

Evidence, all of it executable:

1. `packages/ai/test/adapters/anthropic-messages/dual-dialect-gateway.test.ts` —
   one `createAISubsystem` with two providers and two adapters; selecting model A
   reaches only the OpenAI transport, selecting model B reaches only the Anthropic
   transport, and the same test asserts both native wire shapes from the two
   captured requests.
2. The same file's shared-provider case — one provider id, one endpoint, one fetch
   seam, two models whose descriptors name different dialects, each reaching its own
   native protocol.
3. `packages/ai/test/adapters/anthropic-messages/two-provider-one-adapter.test.ts` —
   two Anthropic providers served by one adapter instance, with endpoint and
   credential isolation asserted in both directions.
4. `apps/daemon/test/daemon-anthropic-dialect-e2e.test.ts` — one daemon serving both
   dialects, where the OpenAI transport receives zero requests while the Anthropic
   model runs.
5. `tests/architecture/phase-2d-ai-invocation-closure.test.ts` — a static guard that
   fails if `packages/ai/src/gateway`, `packages/agent/src` or `packages/core/src`
   ever branches on a provider name (`anthropic`, `openai`, `deepseek`, `qwen`,
   `openrouter`, `gemini`, `mistral`), and a guard that the resolver still reads
   `dependencies.adapters.get(descriptor.api)`.

**Provider-name branching in the model invocation path: 0.**

---

## 7. Final retry authority

```text
Adapter               0 retry
Gateway               0 retry
ModelTurnExecutor     0 retry
RunController         the only retry authority, through its bounded policy
```

Every error scenario asserts `transportAttempts === 1`, including 401, 403, 413,
429, 500, 504, 529, network failure, mid-stream error and abort. The native adapter
performs exactly one `fetch` and never re-enters it.

`DEFAULT_AI_ERROR_RETRYABILITY` was not modified. `AI_RATE_LIMIT`, `AI_NETWORK` and
`AI_TIMEOUT` remain the only retryable codes, and the adapter reports a provider
spend cap as non-retryable `AI_PROVIDER_ERROR` precisely because a 429 carrying a
quota cap would otherwise become an unbounded durable retry.

---

## 8. Final endpoint authority

```text
AIProviderBinding.endpoint
        ↓  gateway, step 14
ResolvedProviderConnection.endpoint
        ↓  adapter
native request url
```

`ModelRef.baseUrl` is normalised away at gateway step 2 and never reaches an
adapter. Both dialects assert this directly: a request whose model carries
`baseUrl: "http://attacker.example/v1"` still reaches the configured provider host.

Dialect-private endpoint interpretation is deterministic and never guesses. A root
endpoint gains the canonical path; a non-root path that cannot be interpreted
unambiguously is an `AI_INVALID_REQUEST` configuration error unless
`compatibility.anthropicMessages.messagesPath` declares it.

---

## 9. Final model metadata authority

`ModelDescriptor` is the single AI-layer authority for a model's dialect, limits,
capabilities, reasoning levels, cache retentions and adapter metadata. Phase 2D
added no field to it and read only `adapterMetadata`, which is the frozen seam for
dialect-private, per-model data.

Dialect differences are **data, never code**:

```jsonc
{
  "adapterMetadata": {
    "anthropicMessages": {
      "thinking": {
        "supported": true,
        "defaultEnabled": false,
        "disableSupported": true,
        "display": "summarized",
        "budgetTokensByLevel": { "HIGH": 16384 },
        "effortByLevel": { "HIGH": "high" },
        "temperatureWithThinking": false,
      },
    },
  },
}
```

No provider-name heuristic exists anywhere. A model id that mentions a vendor is
treated exactly like an opaque one, and the request golden suite asserts both
directions of that: a vendor-looking id without metadata fails closed, and an opaque
id with metadata gets native thinking.

---

## 10. Remaining `@caelush/llm` purpose

`packages/llm` still exists. It is no longer a model invocation authority.

> The package remains only because durable/message compatibility has not yet
> migrated to Message System V2. It is no longer a model invocation authority.

### Remaining files

```text
packages/llm/src/index.ts       the compatibility facade root
packages/llm/src/messages.ts    durable conversation message codec
packages/llm/src/tool-call.ts   durable finish-reason and tool-call schemas
packages/llm/src/usage.ts       durable usage schema
packages/llm/src/turn.ts        the ./turn subpath barrel
```

### Remaining exports

| Subpath                 | Symbols                                                                                                                                                    | Purpose                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `@caelush/llm` (root)   | `LLMMessageSchema` and the four message schemas, `LLMToolResultMessageSchema`, `LLMUsageSchema`, `FinishReasonSchema`, `LLMToolCallSchema` and their types | one stable import for the surviving surface |
| `@caelush/llm/messages` | the same message schemas and types                                                                                                                         | durable conversation codec                  |
| `@caelush/llm/turn`     | `FinishReasonSchema`, `LLMUsageSchema`, `LLMToolCallSchema` and types                                                                                      | durable continuation and turn schema        |

`./request` and `./errors` were removed from the export map along with their
implementations.

### Remaining consumers

| Consumer                                                                                                                                                                                                                                                                                                          | Specifier              | What it stores                                                                      | Future owning subsystem |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `packages/core/src/agent-continuation-schema.ts`                                                                                                                                                                                                                                                                  | `./messages`, `./turn` | durable continuation JSON: assistant and tool-result messages, finish reason, usage | Message System V2       |
| `packages/core/src/agent-continuation.ts`, `agent-decision.ts`, `agent-loop-history.ts`, `agent-loop-input.ts`, `agent-loop.ts`, `agent-tool-batch.ts`, `agent-tool-results.ts`, `run-controller-history.ts`, `run-controller-input.ts`, `run-controller-ports.ts`, `run-controller.ts`, `run-execution-store.ts` | `./messages`           | the in-memory conversation message type that becomes durable                        | Message System V2       |
| `packages/core/src/ai-invocation-projection.ts`                                                                                                                                                                                                                                                                   | `./messages`           | the legacy-to-AI boundary projection, including dropping `rawArtifactRef`           | Message System V2       |
| `packages/context/src/context-budget.ts`, `context-builder.ts`, `context-renderer.ts`, `conversation-history.ts`, `execution-unit.ts`, `model-context-projection.ts`                                                                                                                                              | `./messages`           | conversation history input to the context builder                                   | Message System V2       |
| `packages/storage/src/repositories/conversation-repository.ts`                                                                                                                                                                                                                                                    | `./messages`           | the durable conversation row codec                                                  | Message System V2       |
| `apps/daemon/src/services/session-conversation-context.ts`                                                                                                                                                                                                                                                        | `./messages`           | session history projection                                                          | Message System V2       |

`LLMToolResultMessage.rawArtifactRef` is deliberately retained. It is Context
recovery durable compatibility, not provider input, and it must not be deleted to
make the legacy message look like an `AIToolResultMessage`.

### Deferred Message System work

The following are **not** part of AI Model Invocation V2 and were not attempted in
Phase 2D:

- Message System V2 and the `LLMMessage` → `AIMessage` boundary split
- Session System V2 and the Session Tree
- durable conversation ownership for `agent-continuation-schema.ts`
- removal of `storage → llm/messages`
- Tool System V2, Event System V2, Context Engineering V2, Context Compaction V2
- full AgentLoop package migration and Coding Agent extraction
- Storage architecture and DB schema migration

---

## 11. Legacy invocation closure

`LEGACY_MODEL_INVOCATION` production consumers outside `packages/llm`: **0**.

Verified by `tests/architecture/phase-2d-ai-invocation-closure.test.ts`, which fails
on any production import of the root entry, `./request` or `./errors`, on any
reintroduction of a retired invocation symbol, and on any retired source file
reappearing.

### Removed

```text
packages/llm/src/gateway.ts                packages/llm/src/result.ts
packages/llm/src/provider.ts               packages/llm/src/errors.ts
packages/llm/src/provider-registry.ts      packages/llm/src/compatibility/**
packages/llm/src/request.ts                packages/llm/src/providers/openai-compatible/**
packages/llm/src/request-validation.ts     packages/llm/scripts/smoke-openai-compatible.ts
packages/llm/src/capabilities.ts
packages/llm/src/events.ts                 plus the 27 tests and 2 test helpers that
packages/llm/src/abort.ts                  existed only for those implementations
packages/llm/src/stream-validator.ts
packages/llm/src/wire-diagnostic.ts
```

### Dependencies removed

`packages/llm` no longer depends on `@caelush/ai`. Its final dependency set is
`@caelush/protocol` and `zod`, which is exactly the durable-schema minimum. The root
workspace lockfile records the same removal.

### Repointed instead of deleted

`scripts/artifact-e2e.mjs` is a production release probe, not a test. It previously
instantiated the legacy gateway inside a packaged child process. It now composes
`@caelush/ai` and probes **both** native dialects in one gateway, so the packaged
probe got stronger rather than being weakened to keep a retired surface alive.

### Migrated tests

| Test                                                              | Before                                                   | After                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `tests/integration/openai-compatible-wire-contract.test.ts`       | legacy gateway + provider facade                         | `createAISubsystem` + `@caelush/ai/adapters/openai-compatible`, same captured-body assertions |
| `tests/integration/tool-catalog.test.ts`                          | `packages/llm/src/request.js` + compatibility projection | `validateAIModelRequest` + Core's `toAIToolSpec`                                              |
| `packages/context/test/context-e2e.test.ts`                       | root `@caelush/llm` `LLMRequestSchema`                   | `@caelush/llm/messages` `LLMMessageSchema`, which is what Context actually produces           |
| `tests/architecture/package-boundaries.test.ts`                   | asserted `llm → ai`                                      | asserts no `llm → ai` dependency remains                                                      |
| `tests/architecture/architecture-v2-migration-boundaries.test.ts` | asserted the 9-entry AI surface                          | asserts the 10-entry surface including the native dialect                                     |

### Remaining invocation code

None. `packages/llm` contains five durable-schema files and nothing else.

---

## 12. Architecture debt

| Metric                 | Phase 2C | Phase 2D |
| ---------------------- | -------- | -------- |
| Baseline entries       | 32       | 32       |
| New violations         | 0        | 0        |
| Stale baseline entries | 0        | 0        |
| Active rules           | 276      | 276      |
| Readiness              | READY    | READY    |

The baseline did not grow. It also did not shrink, which is the expected and
accepted outcome: the two `llm` entries are `storage → @caelush/llm/messages` debt
owned by Message System V2, not by AI Model Invocation V2.

```text
STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_LLM   packages/storage/package.json
STORAGE_MUST_NOT_DEPEND_ON_LLM
  packages/storage/src/repositories/conversation-repository.ts
```

Removing them in Phase 2D would have required migrating the durable conversation
codec early, which the phase brief forbids. `storage → ai` remains 0, and no copy of
`AIMessage` was created inside Storage to shrink a number.

---

## 13. Frozen-contract compliance

| Contract                                                                   | Changed in Phase 2D? |
| -------------------------------------------------------------------------- | -------------------- |
| `ApiAdapter` / `ApiAdapterStreamInput`                                     | No                   |
| `AIAdapterEvent`                                                           | No                   |
| `AIMessage` and its content parts                                          | No                   |
| `AIFinishReason`                                                           | No                   |
| `AIErrorCode`                                                              | No                   |
| `AIModelRequest` / `ResolvedAIModelRequest` / `AIModelSettings`            | No                   |
| `ModelDescriptor` / `ModelRef` / limits / capabilities / profiles          | No                   |
| `AIProviderBinding` / `ResolvedProviderConnection` / `ProviderCredentials` | No                   |
| `AIGateway` / `AIModelTurnResult` / `AIStreamEvent`                        | No                   |
| `packages/ai/src/gateway/**`                                               | No semantic change   |
| `packages/ai/src/adapters/api-adapter.ts`                                  | No change            |
| `DEFAULT_AI_ERROR_RETRYABILITY`                                            | No change            |
| `RESERVED_API_IDS`                                                         | No change            |
| Agent, Context, Tool, Run, Client, HTTP and SSE contracts                  | No change            |

Native Anthropic detail — thinking blocks, signatures, redacted thinking, provider
state — stayed adapter-private. Nothing named `AIThinkingBlock`,
`AnthropicThinkingBlock`, `providerRawContent`, `signature`, `redactedThinking` or
`providerState` was added to a frozen contract.

### The thinking/tool safety decision, stated plainly

The native protocol requires an assistant's opaque thinking blocks to be replayed
across a tool continuation. The frozen `AIMessage` has no safe place to carry them,
and Phase 2D was forbidden from adding one. The adapter therefore **fails closed**:
a request with tools and a non-OFF effective reasoning level is rejected with
`AI_CAPABILITY_UNSUPPORTED` before any transport call, and a model whose native
thinking cannot be disabled is likewise rejected when tools are requested.

Three further rules follow the same principle:

- A `signature_delta` produces no public event at all and is never persisted. A
  text-only turn ignores it, and the tool-continuation path that would need it never
  reaches a provider.
- A `thinking_delta` becomes `reasoning.summary.delta` only when the model metadata
  requests `display: "summarized"`, so raw thinking text never enters a public
  contract and never becomes durable assistant content.
- A request that combines native thinking with a caller `temperature`, or with a
  forced `REQUIRED`/`TOOL` tool choice, fails closed instead of silently dropping or
  rewriting the caller's intent.

---

## 14. What Phase 2D deliberately did not do

No Message System V2, no `AgentMessage` migration, no Session System V2 or Session
Tree, no Tool System V2, no Event System V2, no Context Engineering or Compaction V2
migration, no full AgentLoop package migration, no Coding Agent migration, no
Storage architecture or DB schema migration, no HTTP API or SSE redesign, no UI
redesign, and no premature Message System work to make `@caelush/llm` disappear.

---

## 15. Phase 2 exit criteria

```text
[x] Phase 2C exact SHA verified as the base
[x] ApiAdapter, AIAdapterEvent, AIMessage, AIFinishReason and AIErrorCode unchanged
[x] No new universal AI contract, no provider-native field on a frozen contract
[x] anthropic-messages implemented as a real ApiAdapter with the exact reserved id
[x] No Anthropic SDK dependency; fetch plus a local SSE parser
[x] Provider endpoint remains the only endpoint authority; baseUrl cannot route
[x] One gateway dispatches two native dialects by model descriptor
[x] One adapter instance serves two providers with isolated endpoints and credentials
[x] The same conformance suite passes for both dialects
[x] Daemon registers both adapters; the legacy environment contract is unchanged
[x] Anthropic Agent E2E and Tool E2E pass through the real daemon chain
[x] Production legacy model-invocation consumers = 0
[x] Legacy invocation surface removed; `llm → ai` dependency removed
[x] `@caelush/llm/messages` and `@caelush/llm/turn` preserved, including rawArtifactRef
[x] `storage → ai` = 0, `ai → llm` = 0, `ai → protocol` = 0
[x] Architecture baseline did not grow; 0 new violations; READY
[x] Retry authority: adapter 0, gateway 0, ModelTurnExecutor 0
[x] Reasoning summaries stay transient and never become durable content
```

---

## 16. Conclusion

```text
PHASE 2D READY FOR REVIEW

AI MODEL INVOCATION V2
PHASE 2 COMPLETE
```

Caelush can execute OpenAI-compatible and Anthropic Messages models through the
same provider-neutral `AIGateway` without changing Agent, Context, Tool, Run or
Client contracts. The evidence is executable: one conformance suite, two dialects,
one gateway, one daemon composition, and a static guard that no provider name can
ever select a code path.

`@caelush/llm` remains, and it is now precisely what the migration map predicted it
would become — a compatibility facade for durable conversation data awaiting Message
System V2, with no model invocation authority left in it.
