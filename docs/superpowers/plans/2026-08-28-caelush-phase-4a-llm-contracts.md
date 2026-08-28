# Caelush Phase 4A LLM Contracts & Provider Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Caelush-owned, provider-neutral LLM contracts and explicitly injected provider foundation required by future Phase 4B gateway work.

**Architecture:** Keep LLM execution-boundary schemas in `@caelush/llm`, reusing Protocol `ModelRef`, `JsonObject`, `JsonValue`, and `ToolDefinition`. Define one-provider-turn request/result data, normalized stream events, typed errors, and a runtime-only provider interface; keep the registry explicitly instantiated and keep the deterministic fake provider under tests.

**Tech Stack:** TypeScript 6, ESM/NodeNext package builds, Zod `4.4.3`, Vitest `4.1.11`, existing pnpm workspace and UUIDv7 Protocol ID utilities.

**Spec:** `docs/superpowers/specs/2026-08-28-caelush-phase-4-llm-gateway-design.md`

## Global Constraints

- This plan implements Phase 4A only; Phase 4B gateway runtime and Phase 4C concrete provider/AI SDK adapters remain pending.
- `@caelush/llm` may depend on `@caelush/protocol` and `zod@4.4.3`; do not install `ai`, `@ai-sdk/*`, `openai`, `anthropic`, or Gemini packages.
- Protocol remains the source of truth for `ModelRef`, `JsonObject`, `JsonValue`, and `ToolDefinition`; do not create `LLMToolDefinition`.
- LLM messages, requests, capabilities, usage, stream events, results, and provider errors belong to `@caelush/llm`, not Protocol, except the missing `LLMCallId` UUIDv7 identifier.
- All schemas are strict where they describe object contracts; messages and stream events are discriminated unions with TypeScript narrowing.
- Empty system content is valid; assistant tool-only messages are valid; tool results remain compact strings.
- `LLMUsage` fields are optional nonnegative integers and missing provider values must be omitted rather than replaced with `0`.
- Stream vocabulary is exactly `stream.start`, `text.delta`, `tool_call.start`, `tool_call.delta`, `tool_call.completed`, `usage`, and `stream.finish`; no stream error/reasoning/tool execution/retry events.
- Completed `LLMToolCall.input` is a `JsonObject`; partial tool-call JSON remains an unparsed string delta and no completed call retains `rawInput`.
- Provider credentials/clients/functions are runtime-only; provider adapters never execute local tools and Phase 4A performs no network requests or retries.
- Production source must contain zero explicit `any` and zero imports from `ai` or `@ai-sdk/`; the test fake is not a public export.
- All cross-package imports use `@caelush/*` package roots and all public package symbols enter through `src/index.ts`.

---

### Task 1: Add the missing Protocol LLM call identifier

**Files:**
- Modify: `packages/protocol/src/primitives/ids.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/ids.test.ts`

**Interfaces:**
- Consumes: existing `createPrefixedIdSchema`, `uuid@14.0.2`, and the current ID test table.
- Produces: `LLMCallIdSchema`, `LLMCallId`, and `createLLMCallId()` with the `llm_` prefix and UUIDv7 validation from `@caelush/protocol`.

- [ ] **Step 1: Write the failing tests**

Extend the `idContracts` table in `packages/protocol/test/ids.test.ts` with `['LLMCallIdSchema', 'createLLMCallId', 'llm_']`, so the existing UUIDv7/prefix loop covers creation. Add a wrong-prefix assertion that parses a generated `LLMCallId` with `RunIdSchema` and assert malformed/non-v7 values fail for `LLMCallIdSchema`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run packages/protocol/test/ids.test.ts`

Expected: FAIL because the new schema and factory are not exported.

- [ ] **Step 3: Write the minimal implementation**

Add the following immediately after the existing identifier declarations in `packages/protocol/src/primitives/ids.ts`:

```ts
const llmCallId = createPrefixedIdSchema<"llm_", "LLMCallId">("llm_");
export const LLMCallIdSchema = llmCallId;
export type LLMCallId = z.infer<typeof LLMCallIdSchema>;
export function createLLMCallId(): LLMCallId {
  return LLMCallIdSchema.parse(`llm_${v7()}`);
}
```

Re-export the schema, factory, and type from `packages/protocol/src/index.ts` beside the other IDs.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/protocol/test/ids.test.ts`

Expected: PASS with the expanded ID contract set.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/primitives/ids.ts packages/protocol/src/index.ts packages/protocol/test/ids.test.ts
git commit -m "feat(protocol): add llm call identifiers"
```

### Task 2: Establish the LLM package dependency and message contracts

**Files:**
- Modify: `packages/llm/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/llm/src/messages.ts`
- Create: `packages/llm/test/messages.test.ts`

**Interfaces:**
- Consumes: Protocol `JsonObjectSchema`, `ToolNameSchema`, and `zod@4.4.3`.
- Produces: `LLMSystemMessageSchema`, `LLMUserMessageSchema`, `LLMAssistantContentSchema`, `LLMAssistantMessageSchema`, `LLMToolResultMessageSchema`, `LLMMessageSchema`, and their inferred types.

- [ ] **Step 1: Write the failing tests**

Create `packages/llm/test/messages.test.ts` with tests for strict system/user parsing, empty system content, assistant text plus tool calls, assistant tool-only content, compact tool result, rejection of unknown keys/images/attachments, and parse → JSON stringify → parse round-trip for every fixture:

```ts
import { describe, expect, it } from "vitest";
import {
  LLMAssistantMessageSchema,
  LLMMessageSchema,
  LLMSystemMessageSchema,
  LLMToolResultMessageSchema,
  LLMUserMessageSchema,
} from "../src/index.js";

const fixtures = [
  { role: "system", content: "" },
  { role: "user", content: "Inspect the repository." },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I need one file." },
      { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "README.md" } },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call-2", toolName: "read_file", input: { path: "AGENTS.md" } }],
  },
  { role: "tool", toolCallId: "call-1", toolName: "read_file", content: "file contents", isError: false },
] as const;

describe("LLM messages", () => {
  it("accepts V1 message forms and tool-only assistant content", () => {
    for (const fixture of fixtures) expect(LLMMessageSchema.parse(fixture)).toEqual(fixture);
  });

  it("round-trips every message fixture through JSON", () => {
    for (const fixture of fixtures) {
      const parsed = LLMMessageSchema.parse(JSON.parse(JSON.stringify(fixture)));
      expect(parsed).toEqual(fixture);
    }
  });

  it("keeps each role schema strict and rejects unsupported content", () => {
    expect(LLMSystemMessageSchema.safeParse({ role: "system", content: "ok", typo: true }).success).toBe(false);
    expect(LLMUserMessageSchema.safeParse({ role: "user", content: "ok", image: "..." }).success).toBe(false);
    expect(LLMAssistantMessageSchema.safeParse({ role: "assistant", content: [] }).success).toBe(false);
    expect(LLMToolResultMessageSchema.safeParse({ role: "tool", toolCallId: "x", toolName: "x", content: "", isError: false, details: {} }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run packages/llm/test/messages.test.ts`

Expected: FAIL because the schemas and package exports do not exist.

- [ ] **Step 3: Write the minimal implementation**

Add strict role-specific schemas. Use `z.array(LLMAssistantContentSchema).min(1)` so an assistant may be tool-only but cannot be an empty message. Use Protocol `JsonObjectSchema` for tool-call input and Protocol `ToolNameSchema` for tool names. Build `LLMMessageSchema` with `z.discriminatedUnion("role", [...])`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/llm/test/messages.test.ts`

Expected: PASS with all message validation and round-trip tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/package.json packages/llm/src/messages.ts packages/llm/test/messages.test.ts pnpm-lock.yaml
git commit -m "feat(llm): define llm message contracts"
```

### Task 3: Add request, tool choice, capabilities, usage, and normalized result schemas

**Files:**
- Create: `packages/llm/src/request.ts`
- Create: `packages/llm/src/capabilities.ts`
- Create: `packages/llm/src/usage.ts`
- Create: `packages/llm/src/tool-call.ts`
- Create: `packages/llm/src/result.ts`
- Create: `packages/llm/test/request.test.ts`
- Create: `packages/llm/test/capabilities.test.ts`

**Interfaces:**
- Consumes: `LLMMessageSchema`, Protocol `ModelRefSchema`, Protocol `ToolDefinitionSchema`, and `JsonObjectSchema`.
- Produces: `LLMToolChoiceSchema`, `LLMRequestSchema`/`LLMRequest`, `CapabilitySupportSchema`, `LLMCapabilitiesSchema`/`LLMCapabilities`, `LLMUsageSchema`/`LLMUsage`, `LLMToolCallSchema`/`LLMToolCall`, `FinishReasonSchema`, and `LLMTurnResultSchema`/`LLMTurnResult`.

- [ ] **Step 1: Write the failing tests**

Create request tests that accept all four tool-choice forms and valid generation bounds, reject `providerOptions`, reject non-finite/out-of-range temperature and non-positive/non-integer max output tokens, and prove Protocol `ToolDefinition` is reused by rejecting a malformed tool definition. Create capability/usage tests that distinguish all three capability states, omit unknown token limits, accept optional usage fields, reject negative/fractional usage, and do not fabricate missing values.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm exec vitest run packages/llm/test/request.test.ts packages/llm/test/capabilities.test.ts`

Expected: FAIL because the request/capability/usage/result schemas do not exist.

- [ ] **Step 3: Write the minimal implementation**

Use these exact validation rules:

```ts
const LLMToolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("AUTO") }).strict(),
  z.object({ type: z.literal("NONE") }).strict(),
  z.object({ type: z.literal("REQUIRED") }).strict(),
  z.object({ type: z.literal("TOOL"), toolName: ToolNameSchema }).strict(),
]);

const LLMRequestSchema = z.object({
  model: ModelRefSchema,
  messages: z.array(LLMMessageSchema),
  tools: z.array(ToolDefinitionSchema).optional(),
  toolChoice: LLMToolChoiceSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
}).strict();
```

Define `CapabilitySupportSchema` as the exact enum `SUPPORTED | UNSUPPORTED | UNKNOWN`; use it for all six capability fields. Define optional positive integer limits. Define `LLMUsageSchema` with only optional nonnegative integer fields. Define `LLMToolCallSchema` with `id`, `name`, and `input` only. Define `FinishReasonSchema` as `STOP | LENGTH | TOOL_CALLS | CONTENT_FILTER | OTHER`. Define a strict `LLMTurnResultSchema` containing `callId`, `providerId`, `model`, `text`, `toolCalls`, `finishReason`, and optional `usage`.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm exec vitest run packages/llm/test/request.test.ts packages/llm/test/capabilities.test.ts`

Expected: PASS with strictness, bounds, UNKNOWN capability, optional usage, and normalized tool-call tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/request.ts packages/llm/src/capabilities.ts packages/llm/src/usage.ts packages/llm/src/tool-call.ts packages/llm/src/result.ts packages/llm/test/request.test.ts packages/llm/test/capabilities.test.ts
git commit -m "feat(llm): define llm request and result contracts"
```

### Task 4: Add the normalized stream event union and prove TypeScript narrowing

**Files:**
- Create: `packages/llm/src/events.ts`
- Create: `packages/llm/test/events.test.ts`

**Interfaces:**
- Consumes: Protocol `LLMCallIdSchema`/`ModelRefSchema`, `ProviderIdSchema`, `LLMToolCallSchema`, `LLMUsageSchema`, and `FinishReasonSchema`.
- Produces: `LLMStreamEventSchema`, `LLMStreamEvent`, and event-specific inferred types for the exact seven event literals.

- [ ] **Step 1: Write the failing tests**

Create tests that parse one valid fixture for every allowed event, reject `stream.error`, `reasoning.delta`, `tool_result`, empty `text.delta`, malformed completed tool-call input, and unknown event payload keys. Add a compile-time narrowing helper with no `as any`:

```ts
function summarize(event: LLMStreamEvent): string {
  switch (event.type) {
    case "stream.start": return event.payload.providerId;
    case "text.delta": return event.payload.text;
    case "tool_call.start": return event.payload.toolName;
    case "tool_call.delta": return event.payload.delta;
    case "tool_call.completed": return event.payload.name;
    case "usage": return String(event.payload.totalTokens ?? "unknown");
    case "stream.finish": return event.payload.finishReason;
  }
}
```

Assert the helper's output for representative events so the test both executes and typechecks through the switch.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run packages/llm/test/events.test.ts`

Expected: FAIL because the stream schemas and event type are missing.

- [ ] **Step 3: Write the minimal implementation**

Define strict event objects with `type` literals and `payload` objects. `stream.start` contains `callId`, `providerId`, and Protocol `model`; `text.delta` contains non-empty `text`; `tool_call.start` contains `toolCallId` and `toolName`; `tool_call.delta` contains string `delta`; `tool_call.completed` payload is the normalized `LLMToolCall`; `usage` payload is `LLMUsage`; `stream.finish` contains `finishReason` and optional `finalUsage`. Combine them with `z.discriminatedUnion("type", [...])`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/llm/test/events.test.ts`

Expected: PASS and TypeScript accepts the payload-specific switch without casts.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/events.ts packages/llm/test/events.test.ts
git commit -m "feat(llm): add normalized stream contracts"
```

### Task 5: Add typed LLM errors and the runtime provider boundary

**Files:**
- Create: `packages/llm/src/errors.ts`
- Create: `packages/llm/src/provider.ts`
- Create: `packages/llm/test/errors.test.ts`

**Interfaces:**
- Consumes: `ModelRef`, `LLMRequest`, `LLMCapabilities`, and `LLMStreamEvent`.
- Produces: `LLMError`, the nine requested typed subclasses, `LLMErrorCode`, `ProviderIdSchema`/`ProviderId`, `LLMProviderRequest` (alias of `LLMRequest`), and `LLMProvider`.

- [ ] **Step 1: Write the failing tests**

Create tests that instantiate every typed error, assert `instanceof LLMError` and `Error`, verify stable codes/retryability (`RateLimit` and `Network` true; `Authentication` false; `Aborted` false), and verify optional provider/model context is present without secrets. Add a structural compile test assigning a deterministic object to `LLMProvider` with `id`, `supportsModel`, `getCapabilities`, and `stream` using `AsyncIterable<LLMStreamEvent>`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run packages/llm/test/errors.test.ts`

Expected: FAIL because the typed errors, provider id schema, and provider interface are missing.

- [ ] **Step 3: Write the minimal implementation**

Implement `LLMError` as an `Error` subclass with readonly `code`, `providerId?`, `model?`, and `retryable`, accepting an optional `cause` through the standard `Error` options. Implement exactly these subclasses: `LLMProviderNotFoundError`, `LLMModelUnsupportedError`, `LLMCapabilityUnsupportedError`, `LLMAuthenticationError`, `LLMRateLimitError`, `LLMNetworkError`, `LLMTimeoutError`, `LLMAbortedError`, `LLMInvalidResponseError`, and `LLMProviderError`. Keep messages concise and generated from safe ids; do not accept or store API keys, headers, or full prompts.

Define `ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)`. Define `LLMProviderRequest` as a type alias of `LLMRequest` and define the provider interface exactly as:

```ts
export interface LLMProvider {
  readonly id: ProviderId;
  supportsModel(model: ModelRef): boolean;
  getCapabilities(model: ModelRef): LLMCapabilities;
  stream(request: LLMProviderRequest, signal: AbortSignal): AsyncIterable<LLMStreamEvent>;
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/llm/test/errors.test.ts`

Expected: PASS for hierarchy, codes, retryability, and interface shape.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/errors.ts packages/llm/src/provider.ts packages/llm/test/errors.test.ts
git commit -m "feat(llm): define provider boundary and typed errors"
```

### Task 6: Add explicit provider registry and deterministic test fake

**Files:**
- Create: `packages/llm/src/provider-registry.ts`
- Create: `packages/llm/test/provider-registry.test.ts`
- Create: `packages/llm/test/support/fake-provider.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `ProviderIdSchema`, and `LLMProviderError`/`LLMProviderNotFoundError`.
- Produces: `LLMProviderRegistry` with `register`, `get`, `has`, and `listProviderIds`; test-only `FakeLLMProvider` with deterministic events/error/capabilities and observed request.

- [ ] **Step 1: Write the failing tests**

Create registry tests proving explicit instances do not share providers, valid registration/lookup/listing works, missing lookup throws `LLMProviderNotFoundError`, duplicate ids throw a conflict `LLMProviderError` without replacing the first provider, invalid ids are rejected, and `has` does not throw. Create fake-provider usage in the test to prove a configured event sequence is yielded and the request is captured; do not import the fake from the production package root.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run packages/llm/test/provider-registry.test.ts`

Expected: FAIL because the registry and fake provider do not exist.

- [ ] **Step 3: Write the minimal implementation**

Implement `LLMProviderRegistry` with a private instance `Map<ProviderId, LLMProvider>` initialized in the constructor. `register` validates the id, throws `LLMProviderError` with code `LLM_PROVIDER_ERROR` on duplicates, and never overwrites. `get` returns the registered provider or throws `LLMProviderNotFoundError`; `has` validates/looks up without throwing for a valid id; `listProviderIds` returns a readonly snapshot in insertion order. Do not define a module-level map or singleton.

Implement `FakeLLMProvider` only under `packages/llm/test/support`: constructor options include `id`, `events`, optional `error`, optional `capabilities`, and optional model predicate; `stream` records the request, throws configured error, otherwise yields the preset events in order. It does not execute tools or implement an AgentLoop.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/llm/test/provider-registry.test.ts`

Expected: PASS with isolated registries, duplicate conflict, lookup, ordering, and deterministic fake tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/provider-registry.ts packages/llm/test/provider-registry.test.ts packages/llm/test/support/fake-provider.ts
git commit -m "feat(llm): add explicit provider registry"
```

### Task 7: Wire the public API, architecture guards, docs, and repository status

**Files:**
- Modify: `packages/llm/src/index.ts`
- Create: `packages/llm/test/public-api.test.ts`
- Modify: `tests/architecture/package-boundaries.test.ts`
- Modify: `tests/architecture/workspace-shape.test.ts` if needed for the package dependency assertion
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `docs/architecture/llm-gateway.md`

**Interfaces:**
- Consumes: all Phase 4A production modules and the built-package export convention.
- Produces: complete `@caelush/llm` root API, architecture checks for dependency/SDK isolation/no explicit production `any`, Phase 4A architecture documentation, and updated project status/rules.

- [ ] **Step 1: Write the failing tests**

Create `packages/llm/test/public-api.test.ts` importing from `@caelush/llm` and asserting the required schemas/classes/interfaces' runtime representatives are exported, while `FakeLLMProvider` is not exported. Extend architecture tests to assert `packages/llm/package.json` depends on `@caelush/protocol` and `zod@4.4.3`, does not depend on forbidden SDKs, production source has zero `ai`/`@ai-sdk/` imports and zero explicit `any`, and Protocol does not depend on LLM. Add a compile-only public API narrowing function that imports `LLMStreamEvent` from the package root and switches on every event type.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm exec vitest run packages/llm/test/public-api.test.ts tests/architecture/package-boundaries.test.ts`

Expected: FAIL because the root exports, dependency declaration, docs/status updates, and new guards are not present.

- [ ] **Step 3: Write the minimal implementation and documentation**

Export all required runtime schemas/classes and type-only symbols from `packages/llm/src/index.ts`, including `LLMProviderRegistry`, but never export `packages/llm/test/support/fake-provider.ts`. Add `@caelush/protocol: workspace:*` and `zod: 4.4.3` to the LLM package manifest, then run `pnpm install --lockfile-only` if the lockfile needs the importer update.

Create `docs/architecture/llm-gateway.md` with sections for LLM architecture, Provider Turn, boundary, messages, capabilities, stream events, error model, AI SDK isolation, and the no-raw-CoT rule. Mark Gateway runtime as pending Phase 4B and provider adapter work as pending Phase 4C. Update README status to Phase 4A without claiming real model calls. Add the eight hard rules from the brief to `AGENTS.md`.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `pnpm exec vitest run packages/llm/test/public-api.test.ts tests/architecture/package-boundaries.test.ts`

Expected: PASS with root API and architecture rules enforced.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/index.ts packages/llm/test/public-api.test.ts tests/architecture/package-boundaries.test.ts README.md AGENTS.md docs/architecture/llm-gateway.md packages/llm/package.json pnpm-lock.yaml
git commit -m "docs: document caelush llm architecture"
```

### Task 8: Run full TDD-era verification and remove generated artifacts safely

**Files:**
- Modify only files required by formatting or test fixes discovered during verification; do not add Phase 4B behavior.

**Interfaces:**
- Consumes: all Phase 4A implementation and documentation from Tasks 1–7.
- Produces: verified Phase 4A tree with no generated `dist` or `*.tsbuildinfo` artifacts left in the final working tree.

- [ ] **Step 1: Run the complete quality suite**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`.

Expected: every command exits `0`; test output reports zero failures and includes the new LLM tests.

- [ ] **Step 2: Inspect the implementation boundary**

Run: `rg -n 'from ["'"']ai|from ["'"']@ai-sdk/|\bany\b|stream\.error|reasoning\.delta|tool_result|providerOptions' packages/llm/src packages/llm/test tests/architecture --glob '!**/dist/**'`.

Expected: no forbidden production SDK imports or explicit `any`; only intentional documentation/test assertions may mention forbidden vocabulary.

- [ ] **Step 3: Remove generated artifacts using safe cross-platform commands**

After confirming they are generated outputs under the workspace, remove only `dist` directories and `*.tsbuildinfo` files with PowerShell `Get-ChildItem` plus `Remove-Item -LiteralPath` over the resolved individual paths; do not remove source, docs, package manifests, lockfiles, or broad workspace roots.

- [ ] **Step 4: Reinstall and rerun the final check**

Run: `pnpm install --frozen-lockfile` and then `pnpm check`.

Expected: frozen install succeeds and the final check exits `0` with all tests passing.

- [ ] **Step 5: Review final status and diff**

Run: `git status --short` and `git diff --stat`; inspect the complete diff and confirm it contains only Phase 4A contracts, tests, docs, dependency metadata, and the optional `LLMCallId` change. Confirm there is no AgentLoop, gateway runtime, provider adapter, HTTP LLM endpoint, network code, or real key/config file.

- [ ] **Step 6: Commit any verification-only corrections**

```bash
git add -A
git commit -m "test(llm): verify phase 4a contracts"
```

## Plan self-review

- **Spec coverage:** Tasks 1–2 cover the missing Protocol ID and message model; Task 3 covers request, tool choice, capabilities, usage, tool calls, finish reasons, and turn result; Task 4 covers the exact stream vocabulary/narrowing; Tasks 5–6 cover errors, provider boundary, registry, and test fake; Task 7 covers API/architecture/docs/rules; Task 8 covers the required verification and artifact cleanup.
- **Scope:** No task creates `LLMGateway` behavior, AgentLoop, ContextBuilder, ToolDispatcher, RetryController, HTTP route, or concrete provider adapter.
- **Placeholder scan:** No task relies on TBD/TODO or vague implementation instructions; code signatures and validation rules are specified in each task.
- **Type consistency:** `LLMProviderRequest` is defined once as an alias of `LLMRequest`; events use the `ProviderIdSchema`, `LLMCallIdSchema`, `ModelRefSchema`, and normalized call/usage/finish schemas produced by prior tasks; the registry consumes the provider interface produced by Task 5.
