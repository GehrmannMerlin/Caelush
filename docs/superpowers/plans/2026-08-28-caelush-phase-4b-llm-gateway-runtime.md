# Caelush Phase 4B LLM Gateway Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-independent `LLMGateway` that routes exactly one provider turn, validates provider stream invariants at runtime, handles abort/timeout/consumer cancellation, and aggregates normalized events into `LLMTurnResult`.

**Architecture:** `LLMGateway` receives an explicitly constructed `LLMProviderRegistry`, performs synchronous request/provider/capability preflight, creates the Caelush-owned `LLMCallId`, then returns a lazy `LLMStream`. Provider execution starts only when `events` is consumed and receives an internal abort scope plus `LLMProviderCallContext`. Runtime event, stream lifecycle, and tool-call lifecycle validation remain separate from event aggregation; no AgentLoop, tool execution, persistence, events package, HTTP layer, or provider SDK is introduced.

**Tech Stack:** TypeScript ESM, Node.js 24, pnpm workspace, Vitest, Zod 4.4.3, `@caelush/protocol` UUIDv7/JSON/tool contracts.

**Spec:** `docs/superpowers/specs/2026-08-28-caelush-phase-4-llm-gateway-design.md` plus the user-provided Phase 4B brief at `C:\Users\韩吉衍\.codex\attachments\9a9e7862-20a2-47b9-9190-770d4d2f5468\pasted-text.txt`.

## Global Constraints

- This round is Phase 4B only: `LLMGateway & Streaming Runtime`; Phase 4C provider adapters and AI SDK integration remain pending.
- `@caelush/llm` may depend only on `@caelush/protocol` and the pinned `zod@4.4.3`; do not install `ai`, `@ai-sdk/*`, `openai`, `anthropic`, or Gemini SDKs.
- `LLMRequest` is one provider turn, not an agent run; one gateway stream invokes one provider stream exactly once and never retries.
- `LLMGateway` owns `LLMCallId`; providers receive it through runtime-only `LLMProviderCallContext` and must not create their own Caelush call ids.
- Every provider event is revalidated with `LLMStreamEventSchema`; malformed data becomes `LLMInvalidResponseError` and never leaks a raw schema error or malicious payload.
- The only stream event vocabulary is `stream.start`, `text.delta`, `tool_call.start`, `tool_call.delta`, `tool_call.completed`, `usage`, and `stream.finish`; no `stream.error`, reasoning delta, tool result, approval, retry, or execution events.
- External abort, gateway timeout, and consumer cancellation are distinct internal causes; abort and timeout throw typed errors, while an intentional consumer early break performs cleanup without an unhandled error.
- Missing usage fields remain omitted; the last usage snapshot wins and `stream.finish.finalUsage` takes precedence without double counting.
- Production source contains zero explicit `any`, no network code, no AgentLoop, no tool execution, no storage/event/daemon dependency, and no AI SDK import.
- Public exports come only from `packages/llm/src/index.ts`; abort sentinels and validator state types stay private, and the test fake remains under `packages/llm/test/support`.
- Do not use `git push`, `git reset --hard`, or `git clean -fd`; finish with fresh verification and leave the working tree clean only through explicit commits.

---

### Task 1: Pass gateway-owned provider call context

**Files:**
- Modify: `packages/llm/src/provider.ts` to define runtime-only `LLMProviderCallContext` and change `LLMProvider.stream` to accept it.
- Modify: `packages/llm/src/index.ts` to export `LLMProviderCallContext` and the adjusted provider types.
- Modify: `packages/llm/test/support/fake-provider.ts` to record all requests/contexts and support deterministic cleanup/abort fixtures.
- Test: `packages/llm/test/errors.test.ts`, `packages/llm/test/provider-registry.test.ts`, and a new `packages/llm/test/provider-context.test.ts`.

**Interfaces:**
- Consumes: Phase 4A `LLMRequest`, `LLMStreamEvent`, `LLMProvider`, Protocol `LLMCallId`.
- Produces: `LLMProviderCallContext = { readonly callId: LLMCallId; readonly signal: AbortSignal }`; `LLMProvider.stream(request, context)`; fake observations `observedRequests`, `observedContexts`, `streamCallCount`, `lastSignal`, `lastCallId` and cleanup controls for later gateway tests.

- [ ] **Step 1: Write the failing test** asserting a provider implementation receives a context containing a caller-supplied `callId` and `AbortSignal`, rather than a bare signal.
- [ ] **Step 2: Run `pnpm vitest run packages/llm/test/provider-context.test.ts` and confirm it fails because the provider contract/fake has no context.**
- [ ] **Step 3: Implement the minimal context type and update the fake to store the request/context, increment call count, and expose controlled async event/cleanup behavior without adding production behavior.**
- [ ] **Step 4: Run the focused test and the existing provider tests; confirm all pass.**
- [ ] **Step 5: Commit `refactor(llm): pass gateway call context to providers`.**

### Task 2: Add invalid-request error and semantic validator

**Files:**
- Modify: `packages/llm/src/errors.ts` to add `LLM_INVALID_REQUEST` and `LLMInvalidRequestError`.
- Create: `packages/llm/src/request-validation.ts` for cross-field request validation and timeout validation helpers.
- Modify: `packages/llm/src/index.ts` to export only the public invalid-request error, not the private validator helper.
- Test: new `packages/llm/test/request-validation.test.ts` and `packages/llm/test/errors.test.ts`.

**Interfaces:**
- Consumes: parsed `LLMRequest`, `LLMToolChoice`, Protocol `ToolDefinition`, `LLMCapabilities`.
- Produces: private `validateLLMRequestSemantics(request, capabilities)` and `validateTimeoutMs(timeoutMs)` that throw `LLMInvalidRequestError` for missing/surplus tool relationships, duplicate tool names, known max-output limit violations, and non-positive/non-finite/non-integer timeout values. `UNKNOWN` max-output limits remain allowed and `temperature` is not capability-preflighted.

- [ ] **Step 1: Write failing tests for specific TOOL missing, REQUIRED without tools, duplicate tool names, known maxOutputTokens overflow, unknown max limit, and invalid timeout values.**
- [ ] **Step 2: Run the focused tests and confirm failures identify the absent error/helper behavior.**
- [ ] **Step 3: Add the typed error and minimal cross-field validation using data-only Protocol tool definitions; do not create `LLMToolDefinition` or provider options.**
- [ ] **Step 4: Run request, error, and validation tests and confirm they pass.**
- [ ] **Step 5: Commit `feat(llm): add gateway request preflight`.**

### Task 3: Implement routing, synchronous preflight, and lazy stream shell

**Files:**
- Create: `packages/llm/src/gateway.ts` with public `LLMGateway`, `LLMStream`, and `LLMStreamOptions` declarations plus routing/preflight and lazy event wrapper.
- Modify: `packages/llm/src/index.ts` to export gateway runtime types/classes.
- Test: new `packages/llm/test/gateway-routing.test.ts` and `packages/llm/test/gateway-request-validation.test.ts`.

**Interfaces:**
- Consumes: `LLMProviderRegistry`, `LLMProviderCallContext`, request semantic validator, Protocol `createLLMCallId`/`ModelRef`.
- Produces: `new LLMGateway({ providers })`; `gateway.stream(request, options?): LLMStream` where `LLMStream` has `readonly callId` and `readonly events`; synchronous provider lookup/model support/capability preflight/call-id creation; lazy provider invocation on first event consumption; no provider call at `stream()` construction.

- [ ] **Step 1: Write failing routing/preflight tests for ModelRef.provider selection, missing provider, unsupported model, same model name under separate providers, capability states, and synchronous errors.**
- [ ] **Step 2: Run the focused tests and confirm the gateway class/API is missing.**
- [ ] **Step 3: Implement the constructor-injected gateway and a lazy async event shell that creates one call id, resolves the registry provider, validates model/capability preflight, and passes `{ callId, signal }` only when consumed.**
- [ ] **Step 4: Run focused routing and request tests, then all Phase 4A tests.**
- [ ] **Step 5: Commit `feat(llm): add provider-independent gateway shell`.**

### Task 4: Add runtime event and stream lifecycle validation

**Files:**
- Create: `packages/llm/src/stream-validator.ts` with private stream/tool state machines and an exported internal validation function used only by the gateway.
- Modify: `packages/llm/src/gateway.ts` to safe-parse every provider event, correlate start identity, validate event ordering, and wrap failures as `LLMInvalidResponseError`.
- Test: new `packages/llm/test/gateway-stream-validation.test.ts`.

**Interfaces:**
- Consumes: `LLMStreamEventSchema`, selected provider id/model/call id, `LLMInvalidResponseError`.
- Produces: validated downstream event stream with `NOT_STARTED → STARTED → FINISHED`; exactly one matching start and finish; no events after finish; normal iterator end without finish is invalid; no exported validator state internals.

- [ ] **Step 1: Write failing tests for valid start/finish, missing/duplicate start, missing/duplicate finish, event-after-finish, raw malformed event, wrong call id/provider id/model, and non-empty text-delta enforcement.**
- [ ] **Step 2: Run the focused tests and confirm the gateway currently accepts or leaks invalid provider events.**
- [ ] **Step 3: Implement strict runtime safeParse plus lifecycle validation and safe error messages that omit full events/requests/secrets while retaining a schema cause internally.**
- [ ] **Step 4: Run stream validation tests and all existing event tests; confirm passing.**
- [ ] **Step 5: Commit `feat(llm): add provider stream validation`.**

### Task 5: Enforce tool-call lifecycle validation

**Files:**
- Modify: `packages/llm/src/stream-validator.ts` to track each tool call independently.
- Test: new `packages/llm/test/gateway-tool-stream.test.ts`.

**Interfaces:**
- Consumes: validated `tool_call.start`, `tool_call.delta`, and `tool_call.completed` events.
- Produces: interleaved tool streams accepted when each id follows `NOT_STARTED → STARTED → COMPLETED`; invalid transitions reject before downstream emission; completion id/name must match start; finish rejects open calls; completed input remains the provider-supplied `JsonObject` and gateway never parses partial delta JSON.

- [ ] **Step 1: Write failing tests for delta/completed before start, duplicate start/completed, delta after completion, open tool at finish, id/name mismatch, and two interleaved calls completing in arrival order.**
- [ ] **Step 2: Run the focused tests and confirm the invalid sequences are not rejected or the test APIs are absent.**
- [ ] **Step 3: Implement the per-tool state map and finish-time open-call check without executing tools or guessing finish reasons.**
- [ ] **Step 4: Run focused tool-stream tests and complete the full gateway stream-validation suite.**
- [ ] **Step 5: Commit `feat(llm): enforce tool call stream lifecycle`.**

### Task 6: Implement abort scope, timeout, and consumer cancellation

**Files:**
- Create: `packages/llm/src/abort.ts` containing private timeout/consumer sentinels and explicit combined abort-scope setup/cleanup.
- Modify: `packages/llm/src/gateway.ts` to use the abort scope around provider iteration and distinguish typed abort/timeout errors.
- Modify: `packages/llm/test/support/fake-provider.ts` to support wait-until-aborted and `finally` cleanup observations.
- Test: new `packages/llm/test/gateway-abort.test.ts`.

**Interfaces:**
- Consumes: `LLMStreamOptions.signal`, validated timeout, `LLMProviderCallContext.signal`.
- Produces: pre-abort avoids provider invocation; external abort throws `LLMAbortedError`; timeout throws `LLMTimeoutError`; early consumer break aborts the provider and attempts iterator return without throwing an unhandled internal error; all timers/listeners are cleaned on finish/error/abort/cancellation.

- [ ] **Step 1: Write failing tests for pre-abort, external abort during provider wait, timeout, abort-vs-timeout class distinction, provider signal abortion, consumer `break`, fake iterator cleanup, and timer cleanup.**
- [ ] **Step 2: Run the focused tests and confirm the gateway does not yet implement these semantics.**
- [ ] **Step 3: Implement an internal abort scope using dedicated controllers/reasons, explicit timer cleanup, `{ once: true }` listeners, and async-generator `finally` cleanup; do not export sentinels.**
- [ ] **Step 4: Run abort tests repeatedly and then the full package test suite to check for dangling rejection/timer behavior.**
- [ ] **Step 5: Commit `feat(llm): add abort and timeout semantics`.**

### Task 7: Aggregate normalized events into `LLMTurnResult`

**Files:**
- Modify: `packages/llm/src/gateway.ts` to add `complete(request, options?): Promise<LLMTurnResult>` built exclusively on `stream()`.
- Test: new `packages/llm/test/gateway-usage.test.ts` and `packages/llm/test/gateway-complete.test.ts`.

**Interfaces:**
- Consumes: validated event stream and existing `LLMTurnResultSchema`/`LLMTurnResult`.
- Produces: ordered text concatenation, completed-tool-call arrival order, latest usage snapshot, finish finalUsage precedence, omitted missing fields, finish reason copied exactly, and exactly one provider invocation for text/tool/parallel-tool scenarios.

- [ ] **Step 1: Write failing tests for text-only, empty output, tool-only, text-plus-tools, interleaved completion order, no/multiple usage, finalUsage override/no double count, and one provider call.**
- [ ] **Step 2: Run focused tests and confirm `complete()` is absent or does not aggregate these semantics.**
- [ ] **Step 3: Implement aggregation over the public stream events; validate the final result schema and never add a second provider completion path.**
- [ ] **Step 4: Run usage/completion tests plus all gateway tests and confirm all pass.**
- [ ] **Step 5: Commit `feat(llm): aggregate provider turns through gateway`.**

### Task 8: Normalize provider/runtime errors and prove no retry

**Files:**
- Modify: `packages/llm/src/gateway.ts` to preserve typed `LLMError` subclasses, wrap unknown `Error`/thrown values as contextual `LLMProviderError`, and convert schema/lifecycle failures to `LLMInvalidResponseError`.
- Test: new `packages/llm/test/gateway-errors.test.ts`.

**Interfaces:**
- Consumes: provider thrown values and `LLMError` hierarchy.
- Produces: preserved authentication/rate-limit/network/timeout/abort subclasses, safe provider-error messages with provider/model context but no prompts/tool args/credentials, no retry/sleep, and one provider call for each failure class.

- [ ] **Step 1: Write failing tests for typed authentication/rate-limit preservation, unknown Error, thrown string, invalid event normalization, secret safety, and rate/network/provider call counts.**
- [ ] **Step 2: Run focused tests and confirm failures show incorrect propagation/classification.**
- [ ] **Step 3: Implement narrow error normalization around lazy provider acquisition/iteration, preserving context via new instances where necessary instead of mutating shared errors.**
- [ ] **Step 4: Run error/no-retry tests and the full package suite.**
- [ ] **Step 5: Commit `test(llm): cover gateway runtime invariants`.**

### Task 9: Public API, architecture guards, documentation, and final verification

**Files:**
- Modify: `packages/llm/src/index.ts` and `tests/architecture/package-boundaries.test.ts` for the final public/architecture contract.
- Modify: `packages/llm/test/public-api.test.ts` with gateway/context/error exports and type-narrowing coverage without `as any`.
- Modify: `docs/architecture/llm-gateway.md` with the Phase 4B lifecycle, responsibilities, state machines, usage, abort, timeout, cancellation, one-turn/no-retry rules, and Phase 4C pending marker.
- Modify: `README.md` to identify Phase 4B and explicitly state that no real provider is connected.
- Modify: `AGENTS.md` with the Phase 4B hard rules supplied by the brief and update the phase boundary from 4A to 4B.
- Test: architecture/public API tests and all package tests.

**Interfaces:**
- Consumes: completed gateway implementation and final source tree.
- Produces: built-root exports for `LLMGateway`, `LLMStream`, `LLMStreamOptions`, `LLMProviderCallContext`, and `LLMInvalidRequestError`; no exports for fake/validator/abort internals; documented public boundary.

- [ ] **Step 1: Write failing public API/architecture tests for the new exports, discriminated event narrowing, no SDK/network/storage/daemon imports, no `stream.error`/`reasoning.delta`/`providerOptions`, no explicit production `any`, and no tool/agent execution symbols.**
- [ ] **Step 2: Run focused public/architecture tests and confirm the new guard expectations fail before final edits.**
- [ ] **Step 3: Update exports, guards, docs, README, and AGENTS.md with only Phase 4B scope.**
- [ ] **Step 4: Run `pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `pnpm check`; record exit codes and test counts.**
- [ ] **Step 5: Use Node `fs` to remove generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` only after the first verification pass; rerun `pnpm install --frozen-lockfile` and `pnpm check`.**
- [ ] **Step 6: Run `git diff --check`, `git status --short`, and `git log --oneline --decorate -15`; commit `docs: document llm gateway runtime` only after fresh verification. Do not push.**

## Self-review checklist

- [ ] All Phase 4B requirements map to Tasks 1–9: context, semantic preflight, routing, runtime validation, stream/tool state machines, abort/timeout/cancellation, aggregation, errors/no-retry, guards/docs/verification.
- [ ] No task relies on a placeholder or an undefined later interface; the only public runtime additions are the gateway/context/error types explicitly required by the brief.
- [ ] Phase 4C remains pending: no AI SDK dependency, provider adapter, network request, API key, HTTP route, AgentLoop, tool execution, storage/event integration, or retry controller is planned.
- [ ] Plan file will be reviewed against the complete pasted brief before implementation begins.
