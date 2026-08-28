# Caelush Phase 4C-1 OpenAI-Compatible Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first real OpenAI-compatible HTTP provider adapter to `@caelush/llm` while preserving the frozen Phase 4B Gateway and Provider contracts.

**Architecture:** The adapter is a runtime-only implementation under `packages/llm/src/providers/openai-compatible/`. It constructs an `@ai-sdk/openai-compatible` provider, invokes exactly one AI SDK `streamText()` turn, and normalizes AI SDK messages, tools, stream parts, usage, finish reasons, and errors into existing Caelush contracts. The public factory exposes only Caelush-owned configuration and the existing `LLMProvider` object; AI SDK types remain private to the adapter implementation.

**Tech Stack:** TypeScript ESM, Node 24, pnpm workspaces, Vitest, Zod 4, `ai@7.0.83`, `@ai-sdk/openai-compatible@3.0.39`, custom `fetch` integration fixtures.

**Spec:** User-provided Phase 4C-1 brief, `docs/superpowers/specs/2026-08-28-caelush-phase-4-llm-gateway-design.md`, and `docs/architecture/llm-gateway.md`.

## Global Constraints

- Only `packages/llm` may depend on `ai` and `@ai-sdk/openai-compatible`.
- Runtime SDK imports are allowed only below `packages/llm/src/providers/openai-compatible/`.
- The existing `LLMProvider` and `LLMProviderCallContext` contracts are authoritative.
- The adapter uses `context.callId` and forwards `context.signal` unchanged as `abortSignal`.
- The adapter creates no timeout, retry loop, `AbortController`, Call ID, AgentLoop, ToolDispatcher, or tool execution callback.
- The AI SDK call must set `maxRetries: 0` and must not set AI SDK `timeout`.
- Credentials are runtime-only; the sentinel `CAELUSH_TEST_SECRET_DO_NOT_LEAK_42` must not appear in public errors.
- Raw reasoning parts are discarded and never become Caelush text or public event fields.
- Tool definitions are data-only and have no `execute`, approval, or execution callbacks.
- Phase 4C-2 compatibility hardening is out of scope: no late names, missing IDs, non-zero/reused indexes, parallel malformed stream repair, or real paid-provider smoke test.
- No changes are made to Daemon, Storage, EventBus, AgentLoop, or Protocol unless a regression test proves a Gateway Contract defect.

## File Map

- Modify: `packages/llm/package.json`, `pnpm-lock.yaml`, and `packages/llm/src/index.ts` for dependencies and public factory exports.
- Create: `packages/llm/src/providers/openai-compatible/config.ts` for public option validation and immutable defaults.
- Create: `packages/llm/src/providers/openai-compatible/model.ts` for model support and capability projection.
- Create: `packages/llm/src/providers/openai-compatible/messages.ts` for Caelush-to-AI-SDK message conversion.
- Create: `packages/llm/src/providers/openai-compatible/tools.ts` for JSON Schema tool and tool-choice conversion.
- Create: `packages/llm/src/providers/openai-compatible/usage.ts` and `finish.ts` for metadata normalization.
- Create: `packages/llm/src/providers/openai-compatible/errors.ts` for safe typed error classification.
- Create: `packages/llm/src/providers/openai-compatible/stream.ts` for one-turn AI SDK invocation and stream normalization.
- Create: `packages/llm/src/providers/openai-compatible/provider.ts` and `index.ts` for the runtime adapter and factory.
- Create: `packages/llm/test/openai-compatible-config.test.ts`, `messages.test.ts`, `tools.test.ts`, `openai-compatible-stream.test.ts`, `openai-compatible-errors.test.ts`, and `architecture-sdk-isolation.test.ts`.
- Modify: `docs/architecture/llm-gateway.md` and `AGENTS.md` to document the Phase 4C-1 boundary and invariants.

### Task 1: Pin adapter dependencies and establish the factory boundary

**Files:**

- Modify: `packages/llm/package.json`, `pnpm-lock.yaml`
- Create: `packages/llm/src/providers/openai-compatible/config.ts`, `provider.ts`, `index.ts`
- Test: `packages/llm/test/openai-compatible-config.test.ts`

**Interfaces:**

- Consumes: `ProviderIdSchema`, `LLMProvider`, `LLMCapabilities`, and Protocol `ModelRef`.
- Produces: `OpenAICompatibleLLMProviderOptions`, `createOpenAICompatibleLLMProvider(options): LLMProvider`, and adapter-owned configuration validation.

- [ ] **Step 1: Add the dependency and factory tests**

  Add tests for a valid explicit config, invalid Provider ID, invalid non-HTTP(S) base URL, no automatic `/v1` suffix, and runtime-only API key behavior:

  ```ts
  const provider = createOpenAICompatibleLLMProvider({
    id: "local-openai",
    baseURL: "http://127.0.0.1:1234/custom",
    apiKey: "CAELUSH_TEST_SECRET_DO_NOT_LEAK_42",
  });
  expect(provider.id).toBe("local-openai");
  expect(
    provider.supportsModel({
      provider: "local-openai",
      model: "demo",
      baseUrl: "http://127.0.0.1:1234/custom",
    }),
  ).toBe(true);
  expect(() =>
    createOpenAICompatibleLLMProvider({ id: "Bad", baseURL: "ftp://example.test" }),
  ).toThrow();
  ```

- [ ] **Step 2: Run the focused tests and observe RED**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-config.test.ts`. It must fail because the factory and adapter modules do not exist yet.

- [ ] **Step 3: Implement the minimal public option type and factory**

  Add the exact public fields `id`, `baseURL`, optional `apiKey`, `headers`, `queryParams`, `capabilities`, `allowedModels`, and `fetch`. Parse `id` through `ProviderIdSchema`, parse `baseURL` with `URL`, accept only `http:` and `https:`, preserve the configured URL exactly, and construct a runtime provider with `createOpenAICompatible({ name, baseURL, apiKey, headers, queryParams, fetch, includeUsage: true })`.

- [ ] **Step 4: Run the focused tests and typecheck**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-config.test.ts` and `pnpm --filter @caelush/llm typecheck`; both must pass before continuing.

### Task 2: Implement message conversion

**Files:**

- Create: `packages/llm/src/providers/openai-compatible/messages.ts`
- Test: `packages/llm/test/openai-compatible-messages.test.ts`

**Interfaces:**

- Consumes: `LLMMessage` and `LLMAssistantContent` from `@caelush/llm` internal contracts.
- Produces: adapter-private `toAISDKMessages(messages)` returning AI SDK `ModelMessage[]`.

- [ ] **Step 1: Write conversion tests first**

  Cover system and empty system, user text, assistant text, multiple assistant text parts preserving order, assistant tool-only, assistant text plus tool-call, successful tool result, failed tool result, and a multi-turn user → assistant tool-call → tool result → assistant history. Assert exact role/content/toolCallId/toolName/input shapes and assert no synthetic whitespace text is added to tool-only assistant messages.

- [ ] **Step 2: Run the conversion tests and observe RED**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-messages.test.ts`; failure must be the missing converter, not malformed fixtures.

- [ ] **Step 3: Implement only the supported message projection**

  Map system/user strings directly, map assistant text parts to AI SDK text parts, map assistant tool calls to AI SDK tool-call parts with the original ID/name/input, and map tool messages to AI SDK tool-result parts with the original ID and a result preserving `isError`. Do not add multimodal content or provider options.

- [ ] **Step 4: Run conversion tests and the existing message tests**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-messages.test.ts packages/llm/test/messages.test.ts`; all tests must pass.

### Task 3: Implement tool definition and tool-choice conversion

**Files:**

- Create: `packages/llm/src/providers/openai-compatible/tools.ts`
- Test: `packages/llm/test/openai-compatible-tools.test.ts`

**Interfaces:**

- Consumes: Protocol `ToolDefinition`, `LLMToolChoice`, and JSON Schema values.
- Produces: adapter-private tool map and AI SDK tool choice values with no executable callbacks.

- [ ] **Step 1: Write tool projection tests first**

  Build a `read_file` definition with object parameters and a required property. Assert the generated tool has the same name, description, and `inputSchema.type === "object"`, preserves properties, and has `execute === undefined`. Add exact tests for `AUTO`, `NONE`, `REQUIRED`, and `{ type: "TOOL", toolName: "read_file" }`.

- [ ] **Step 2: Run the focused tests and observe RED**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-tools.test.ts`; it must fail because the adapter converter is absent.

- [ ] **Step 3: Implement schema-preserving projection**

  Use AI SDK `jsonSchema()` around the existing JSON Schema object. Return a tool object containing only `description` and `inputSchema`; never set `execute`, `needsApproval`, or callbacks. Map Caelush choices to AI SDK lowercase `auto`, `none`, `required`, and `{ type: "tool", toolName }` values after checking the current installed SDK types.

- [ ] **Step 4: Run tool tests and typecheck**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-tools.test.ts` and `pnpm --filter @caelush/llm typecheck`; both must pass.

### Task 4: Implement usage and finish normalization

**Files:**

- Create: `packages/llm/src/providers/openai-compatible/usage.ts`, `finish.ts`
- Test: `packages/llm/test/openai-compatible-stream.test.ts`

**Interfaces:**

- Consumes: AI SDK `usage` and `finish` metadata from `fullStream` parts.
- Produces: optional `LLMUsage` snapshots and `FinishReason` values without synthesizing missing fields.

- [ ] **Step 1: Add usage and finish assertions to integration fixtures**

  Return a standard OpenAI-compatible SSE response with `choices[0].finish_reason = "stop"` and usage `{ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }`. Assert Caelush emits `usage` with 7/3/10 and `stream.finish` with `STOP` and the same final usage. Add `length`, `tool_calls`, `content_filter`, and unknown finish reason cases.

- [ ] **Step 2: Run the new integration assertions and observe RED**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-stream.test.ts`; it must fail because stream normalization is not implemented.

- [ ] **Step 3: Implement non-additive mapping**

  Map only fields present in the upstream usage object, including cached/reasoning metadata when exposed by the current SDK. Map recognized finish reasons to `STOP`, `LENGTH`, `TOOL_CALLS`, and `CONTENT_FILTER`; map unsupported values to `OTHER`. Keep reasoning text out of output.

### Task 5: Implement the single-turn stream adapter

**Files:**

- Create: `packages/llm/src/providers/openai-compatible/stream.ts`, `provider.ts`
- Modify: `packages/llm/src/providers/openai-compatible/index.ts`, `packages/llm/src/index.ts`
- Test: `packages/llm/test/openai-compatible-stream.test.ts`

**Interfaces:**

- Consumes: existing `LLMProvider.stream(request, context)` contract, adapter model, message/tool converters, and AI SDK `streamText`.
- Produces: valid `LLMStreamEvent` sequence beginning with `stream.start` and ending with `stream.finish`.

- [ ] **Step 1: Write plain-text and identity tests first**

  Use an injected `fetch` that captures the request and returns SSE chunks for `Hello` and ` world`. Register the factory result in the existing `LLMProviderRegistry`, call `gateway.complete()`, and assert text `Hello world`, one provider request, matching Gateway call ID in `stream.start`, exact model identity, and one provider turn.

- [ ] **Step 2: Run the tests and observe RED**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-stream.test.ts`; it must fail because the provider stream is absent.

- [ ] **Step 3: Implement one lazy `streamText()` invocation**

  Construct `provider.chatModel(request.model.model)`, call `streamText({ model, messages, tools, toolChoice, temperature, maxOutputTokens, abortSignal: context.signal, maxRetries: 0, includeRawChunks: false })`, and do not pass `timeout`, `stopWhen`, `prepareStep`, or execution callbacks. Yield `stream.start` only after the AI SDK result is successfully created and before consuming `fullStream`. Convert `text-delta` to non-empty text events and silently discard reasoning/raw chunks.

- [ ] **Step 4: Normalize stream lifecycle and run focused tests**

  Consume `fullStream` once, emit normalized tool lifecycle events from standard AI SDK tool input/call parts, emit usage snapshots, map finish, and yield exactly one finish. Run `pnpm exec vitest run packages/llm/test/openai-compatible-stream.test.ts packages/llm/test/gateway-complete.test.ts packages/llm/test/gateway-tool-stream.test.ts`.

### Task 6: Add tool-call happy path and no-execution proof

**Files:**

- Modify: `packages/llm/src/providers/openai-compatible/stream.ts`
- Test: `packages/llm/test/openai-compatible-stream.test.ts`

- [ ] **Step 1: Add a real tool-call SSE fixture**

  Send one standard tool call for `dangerous_test_tool`, with arguments `{"path":"/tmp/example"}`. Assert the Gateway result has exactly one tool call and the normalized event sequence contains `tool_call.start`, one or more `tool_call.delta`, and `tool_call.completed`.

- [ ] **Step 2: Add an execution sentinel and run RED**

  Define no `execute` callback in the adapter tool. The test must fail until the stream adapter turns the AI SDK tool parts into Caelush lifecycle events.

- [ ] **Step 3: Implement validated tool normalization**

  Track each upstream tool call by ID, require the completed input to be a non-null JSON object, validate the assembled call through `LLMToolCallSchema`, and throw `LLMInvalidResponseError` for strings, arrays, null, missing IDs, or invalid names. Never execute the tool.

- [ ] **Step 4: Run tool integration and Gateway tests**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-stream.test.ts packages/llm/test/gateway-tool-stream.test.ts`; the dangerous sentinel must never be triggered.

### Task 7: Normalize transport, malformed-response, abort, timeout, retry, and secret errors

**Files:**

- Create: `packages/llm/src/providers/openai-compatible/errors.ts`
- Modify: `packages/llm/src/providers/openai-compatible/stream.ts`, `provider.ts`
- Test: `packages/llm/test/openai-compatible-errors.test.ts`, `openai-compatible-stream.test.ts`

- [ ] **Step 1: Write failing HTTP error and cancellation tests**

  Add custom-fetch fixtures for 401, 429, 500, network rejection, malformed SSE JSON, a hanging request that resolves only on `signal.abort`, external abort, and Gateway timeout. Assert typed Caelush errors, no raw AI SDK error text, no sentinel secret, and no fabricated `stream.start` when `streamText()` construction fails synchronously.

- [ ] **Step 2: Run error tests and observe RED**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-errors.test.ts packages/llm/test/openai-compatible-stream.test.ts`; failures must show missing adapter classification or propagation.

- [ ] **Step 3: Implement safe classification**

  Classify structured status information first: 401/403 as `LLMAuthenticationError`, 429 as `LLMRateLimitError`, other 4xx/5xx as `LLMProviderError`, network failures as `LLMNetworkError`, malformed upstream data as `LLMInvalidResponseError`. Preserve only safe provider/model context; do not expose headers, request bodies, causes containing credentials, or raw provider errors in public messages. Re-throw existing Caelush abort/timeout errors unchanged.

- [ ] **Step 4: Prove signal forwarding, timeout ownership, and no retry**

  Assert the fetch `init.signal` is the exact signal received from the provider call context, external abort becomes `LLMAbortedError`, Gateway timeout becomes `LLMTimeoutError`, and a 429 response produces exactly one HTTP request (`requestCount === 1`). Confirm no adapter timer exists and no `timeout` option is passed to AI SDK.

### Task 8: Add architecture and declaration isolation guards

**Files:**

- Create: `packages/llm/test/architecture-sdk-isolation.test.ts`
- Modify: `packages/llm/src/index.ts`

- [ ] **Step 1: Write isolation tests first**

  Scan `packages/core/src`, `packages/protocol/src`, `packages/events/src`, `packages/storage/src`, `apps/daemon/src`, and all `packages/llm/src` files. Assert SDK runtime imports occur only below `packages/llm/src/providers/openai-compatible/`. Build the package and assert `packages/llm/dist/index.d.ts` contains neither `ai` nor `@ai-sdk/` and does not expose `ModelMessage`, `ToolSet`, `StreamTextResult`, or `LanguageModel`.

- [ ] **Step 2: Run the guard and observe RED**

  Run `pnpm exec vitest run packages/llm/test/architecture-sdk-isolation.test.ts`; it must fail until the public exports and import scan are implemented correctly.

- [ ] **Step 3: Export only Caelush-owned factory types**

  Export `createOpenAICompatibleLLMProvider` and `OpenAICompatibleLLMProviderOptions` through `packages/llm/src/index.ts`; keep all AI SDK types and converter functions internal.

- [ ] **Step 4: Run the guard and package build**

  Run `pnpm --filter @caelush/llm build` followed by `pnpm exec vitest run packages/llm/test/architecture-sdk-isolation.test.ts`; both must pass.

### Task 9: Update architecture documentation and AGENTS.md

**Files:**

- Modify: `docs/architecture/llm-gateway.md`, `AGENTS.md`

- [ ] **Step 1: Update the documented Phase boundary**

  Replace the pending Phase 4C wording with the completed Phase 4C-1 adapter foundation, while explicitly leaving Phase 4C-2 compatibility hardening pending.

- [ ] **Step 2: Document ownership and isolation**

  Add the Gateway → Provider → OpenAI Adapter → AI SDK → HTTP diagram and state that AI SDK is not Caelush's Agent Runtime. Document message/tool projection, absent execute callbacks, call ID and AbortSignal ownership, Gateway timeout ownership, `maxRetries: 0`, error normalization, reasoning drop, and public type isolation.

- [ ] **Step 3: Run formatting and documentation checks**

  Run `pnpm prettier --check docs/architecture/llm-gateway.md AGENTS.md` and the architecture test.

### Task 10: Full verification, audit, and completion report

**Files:**

- Modify: none beyond the files above; record results in the final response.

- [ ] **Step 1: Run focused suites**

  Run `pnpm exec vitest run packages/llm/test/openai-compatible-config.test.ts packages/llm/test/openai-compatible-messages.test.ts packages/llm/test/openai-compatible-tools.test.ts packages/llm/test/openai-compatible-stream.test.ts packages/llm/test/openai-compatible-errors.test.ts packages/llm/test/architecture-sdk-isolation.test.ts` and record Test Files, Tests, and Failures.

- [ ] **Step 2: Run the complete required verification**

  Run `node --version`, `pnpm --version`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`; every command must exit 0.

- [ ] **Step 3: Audit versions and public API**

  Run `pnpm list --filter @caelush/llm ai @ai-sdk/openai-compatible @ai-sdk/provider-utils --depth 3`, inspect `packages/llm/dist/index.d.ts`, and run `git status --short` plus `git diff --check`.

- [ ] **Step 4: Audit scope and history**

  Confirm no AgentLoop, tool execution, Daemon, Storage, EventBus, Protocol, paid API, or 4C-2 behavior was added. If commits are created, record their hashes and messages; otherwise report the existing repository history and uncommitted diff accurately.

- [ ] **Step 5: Report known compatibility baseline**

  State the exact pinned SDK versions and that the current standard tool stream path is covered, while late function names, missing/blank IDs, non-zero/reused indexes, premature completion, complex parallel malformed streams, provider matrix, and real-provider smoke remain Phase 4C-2 work.
