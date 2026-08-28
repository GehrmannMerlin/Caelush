# Caelush Phase 4C-2 OpenAI-Compatible Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Characterize real OpenAI-compatible streaming tool-call shapes through the pinned AI SDK, preserve safe behavior with deterministic regression tests, fail closed on ambiguous identity, verify ToolCallId round-trip, and finalize Phase 4 without adding AgentLoop or host-product behavior.

**Architecture:** Keep \`LLMGateway\` and the Caelush stream contract unchanged. Exercise the existing adapter through custom fetch responses shaped like OpenAI Chat Completions SSE, classify every case as upstream pass, safe adapter normalization, or unsupported fail-closed behavior, and add adapter code only when a failing case is deterministically and round-trip safely repairable.

**Tech Stack:** TypeScript, Node.js 24, pnpm 11, Vitest 4, Prettier, ESLint, \`ai@7.0.83\`, \`@ai-sdk/openai-compatible@3.0.39\`, and \`@ai-sdk/provider-utils@5.0.32\`.

**Spec:** \`docs/superpowers/specs/2026-08-28-caelush-phase-4c2-openai-compatible-hardening-design.md\`

## Global Constraints

- Keep \`PHASE_4C1_BASELINE=c596938\`; do not rewrite Phase 4C-1 history.
- Do not upgrade pinned dependencies unless a pinned regression fails and a stable exact-pinned version fixes it without regression.
- Compatibility tests must use Gateway → provider → real \`streamText\` → \`@ai-sdk/openai-compatible\` → custom fetch; never mock \`ai\` or \`streamText\`.
- Keep fixture helpers under \`packages/llm/test/\`; never add a raw SSE parser to production.
- Do not change \`packages/llm/src/gateway.ts\` for provider-specific behavior or add provider fields to \`LLMStreamEvent\`.
- Never generate synthetic tool-call IDs, choose the latest call heuristically, silently merge duplicate IDs, execute tools, retry, or own adapter timeout policy.
- Keep AI SDK imports under \`packages/llm/src/providers/openai-compatible/**\`; public declarations must remain SDK-free.
- Do not patch \`node_modules\`, use \`pnpm patch\`, add AgentLoop/ContextBuilder/Runtime/Storage/EventBus/Daemon provider wiring, or push changes.

---

### Task 0: Freeze and record the Phase 4C-1 baseline

**Files:**

- No source changes; baseline implementation is commit \`c596938\`.
- Modify the design document only if its recorded baseline is inaccurate.

**Interfaces:**

- Consumes: the existing history through \`c596938\`.
- Produces: a clean isolated branch based on the local baseline, with \`c596938\` recorded as the Phase 4C-1 baseline.

- [ ] **Step 1: Confirm branch and history**

```powershell
git branch --show-current
git status --short --branch
git log --oneline --decorate -8
```

Expected: branch \`codex/phase-4c2-openai-compatible-hardening-lf\`, clean tracked state, and \`c596938\` in history.

- [ ] **Step 2: Re-run baseline verification**

```powershell
pnpm install --frozen-lockfile
pnpm check
```

Expected: exit code 0, 65 test files and 207 tests passed, with formatting passing under LF checkout.

- [ ] **Step 3: Record pinned dependency and changelog evidence**

```powershell
pnpm view ai@7.0.83 version engines dependencies --json
pnpm view @ai-sdk/openai-compatible@3.0.39 version engines dependencies peerDependencies --json
pnpm view @ai-sdk/provider-utils@5.0.32 version engines dependencies peerDependencies --json
rg -n -C 5 "5\\.0\\.(6|21|28|32)|tool|index|parsable|empty string|partial" node_modules/.pnpm/@ai-sdk+provider-utils@5.0.32*/node_modules/@ai-sdk/provider-utils/CHANGELOG.md
```

Expected: the exact pins are installed; the known partial-JSON, index, and empty-string-ID fixes are documented; no dependency edit is made.

### Task 1: Add real OpenAI SSE fixture infrastructure

**Files:**

- Create \`packages/llm/test/support/openai-compatible-sse.ts\`.
- Create or modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.

**Interfaces:**

- Consumes: \`createOpenAICompatibleLLMProvider\`, \`LLMGateway\`, and \`ToolDefinition\`.
- Produces test-only \`openAIChunk\`, \`toolCallDelta\`, \`finishChunk\`, \`usageChunk\`, and \`sseResponse\` helpers.

- [ ] **Step 1: Write the failing real-chain test**

Add \`routes a real OpenAI-shaped SSE response through the adapter\`. It must return one assistant text chunk and one stop chunk from custom fetch, call \`gateway.complete\`, and assert \`{ text: "fixture ok", toolCalls: [], finishReason: "STOP" }\`. Do not mock \`ai\`.

- [ ] **Step 2: Verify RED**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "routes a real OpenAI-shaped SSE response"
```

Expected: module/helper missing failure.

- [ ] **Step 3: Implement the minimal fixture helpers**

Use these signatures and real Chat Completions fields:

```ts
export function openAIChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly delta: Record<string, unknown>;
  readonly finishReason?: string | null;
  readonly index?: number;
  readonly usage?: Record<string, unknown>;
}): Record<string, unknown>;
export function toolCallDelta(input: {
  readonly index?: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}): Record<string, unknown>;
export function finishChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly finishReason: string;
  readonly usage?: Record<string, unknown>;
}): Record<string, unknown>;
export function usageChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly usage: Record<string, unknown>;
}): Record<string, unknown>;
export function sseResponse(chunks: readonly Record<string, unknown>[]): Response;
```

\`sseResponse\` must serialize \`data: <JSON>\\n\\n\`, append \`data: [DONE]\\n\\n\`, return status 200, and set \`content-type: text/event-stream\`.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "routes a real OpenAI-shaped SSE response"
git add packages/llm/test/support/openai-compatible-sse.ts packages/llm/test/openai-compatible-compatibility.test.ts
git commit -m "test(llm): add openai compatible sse fixtures"
```

### Task 2: Characterize fragmented arguments, premature JSON, and late names

**Files:**

- Modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.
- Modify the fixture helper only when a required real OpenAI shape is absent.

**Interfaces:**

- Consumes: Task 1 fixture builders and the real Gateway/provider path.
- Produces: tests that prove completion timing and argument/name accumulation.

- [ ] **Step 1: Add fragmented-argument test**

Use \`index: 0\`, ID \`call-fragment\`, name \`read_file\`, and argument pieces \`{"pa\`, \`th:\`, and \`"src/index.ts"}\`. Assert exactly one completed call with literal input \`{ path: "src/index.ts" }\` and no completion before the final fragment.

- [ ] **Step 2: Add premature-parsable-JSON test**

Send \`{"a":1}\` followed by \`,"b":2}\`. Assert one completion only after the second fragment, with \`input.a === 1\` and \`input.b === 2\`.

- [ ] **Step 3: Add late-name test**

Send an initial delta with ID and arguments but no \`function.name\`, then a later delta with name \`read_file\` and remaining arguments. Assert one start, all deltas, one completion, correct name, and correct literal input.

- [ ] **Step 4: Run, classify, and commit**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "fragmented tool arguments|premature parsable JSON|late function.name"
git add packages/llm/test/openai-compatible-compatibility.test.ts
git commit -m "test(llm): characterize openai compatible tool streams"
```

Classify each case as \`PASS_UPSTREAM\`, \`PASS_ADAPTER\`, or \`FAIL_CLOSED_UNSUPPORTED\`. A passing characterization gets no production workaround.

### Task 3: Lock tool-call index behavior

**Files:**

- Modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.

**Interfaces:**

- Consumes: the Task 1 real SSE path.
- Produces: non-zero, non-contiguous, reused, missing, and out-of-order index evidence.

- [ ] **Step 1: Add non-zero and non-contiguous tests**

Use index \`1\` for one call and indexes \`1\` and \`3\` for two calls. Assert IDs, names, and literal inputs \`{ path: "a" }\` and \`{ path: "b" }\` are isolated.

- [ ] **Step 2: Add reused and missing index tests**

For reused index, use two independent IDs \`call_a\` and \`call_b\` with index \`0\` and different names. For missing index, omit \`index\`; accept only deterministic SDK behavior, otherwise assert \`LLMInvalidResponseError\`.

- [ ] **Step 3: Add out-of-order test**

Open raw index \`3\` before raw index \`1\`, complete index \`3\` first, and assert \`LLMTurnResult.toolCalls\` follows completed-event arrival order rather than raw index order.

- [ ] **Step 4: Run and commit evidence**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "index"
git add packages/llm/test/openai-compatible-compatibility.test.ts
git commit -m "test(llm): lock tool call index regressions"
```

If a case fails, inspect installed tracker code and the changelog before considering any adapter-private repair; never create an index-array heuristic.

### Task 4: Lock ToolCallId identity and ambiguous fail-closed behavior

**Files:**

- Modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.
- Modify \`packages/llm/src/providers/openai-compatible/**\` only after a failing test proves a safe repair is required.

**Interfaces:**

- Consumes: existing \`LLMInvalidResponseError\` and adapter stream normalization.
- Produces: separate blank, whitespace, missing, duplicate, and no-identity delta behavior.

- [ ] **Step 1: Add blank and whitespace ID tests**

Test continuation IDs \`""\` and \`" "\` separately. Never accept a random or locally generated ID.

- [ ] **Step 2: Add missing and duplicate ID tests**

Omit ID for one open call and for multiple open calls. Send two different tool names with the same ID \`call_same\`; assert independent safe behavior or \`LLMInvalidResponseError\`, never silent merge.

- [ ] **Step 3: Add ambiguous delta test**

With two calls open, send a delta with neither ID nor index. Assert invalid-response/fail-closed unless the pinned SDK proves deterministic ownership; assert raw SSE and \`CAELUSH_TEST_SECRET_DO_NOT_LEAK_42\` do not appear in the public error.

- [ ] **Step 4: Run and classify**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "ID|id|identity|ambiguous"
```

For every failure, check current pinned behavior, latest stable evidence, and round-trip safety. Only then may a regression test drive a deterministic adapter-private fix; no raw SSE rewrite, UUID fallback, or \`latestToolCall\` selection is allowed.

- [ ] **Step 5: Commit identity evidence**

```powershell
git add packages/llm/test/openai-compatible-compatibility.test.ts packages/llm/src/providers/openai-compatible
git commit -m "test(llm): lock tool call identity regressions"
```

### Task 5: Cover parameterless and parallel tool calls

**Files:**

- Modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.

**Interfaces:**

- Consumes: Task 4 identity behavior and fixture builders.
- Produces: parameterless, interleaved different-name, and interleaved same-name parallel coverage.

- [ ] **Step 1: Add parameterless tests**

Use schema \`{ type: "object", properties: {}, additionalProperties: false }\` with arguments \`""\` and \`"{}"\`. If accepted, assert both inputs are \`{}\`; otherwise document unsupported without a prompt hack.

- [ ] **Step 2: Add different-name parallel test**

Interleave \`read_file\` and \`search_text\` starts, argument deltas, and completions. Assert two IDs, names, and inputs with no cross-contamination.

- [ ] **Step 3: Add same-name parallel test**

Interleave two \`read_file\` calls with IDs \`call_a\`/\`call_b\` and paths \`a\`/\`b\`. Assert identity is by ID, not tool name.

- [ ] **Step 4: Run and commit**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "parameterless|parallel|same-name"
git add packages/llm/test/openai-compatible-compatibility.test.ts
git commit -m "test(llm): cover parallel openai compatible tool calls"
```

### Task 6: Prove ToolCallId round-trip for single and parallel calls

**Files:**

- Modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.

**Interfaces:**

- Consumes: \`LLMGateway.complete\`, manual Caelush assistant/tool messages, and IDs returned by Turn 1.
- Produces: Turn 2 HTTP payloads preserving each \`tool_call_id\`.

- [ ] **Step 1: Add single-call round-trip**

Turn 1 returns \`call_123\`; manually add an assistant tool-call message and successful tool result with \`call_123\`; send Turn 2 and assert captured JSON contains the same assistant call and \`tool_call_id: "call_123"\`.

- [ ] **Step 2: Add parallel round-trip**

Turn 1 returns \`call_A\` and \`call_B\`; manually add both results and assert Turn 2 preserves each ID paired with its own result regardless of completion order.

- [ ] **Step 3: Run and commit**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts -t "round-trip"
git add packages/llm/test/openai-compatible-compatibility.test.ts
git commit -m "test(llm): verify tool call result roundtrip"
```

No filesystem, shell, dispatcher, runtime, or tool implementation may run.

### Task 7: Add reasoning, usage, finish, error, secret, and safety regressions

**Files:**

- Modify \`packages/llm/test/openai-compatible-compatibility.test.ts\`.
- Modify \`packages/llm/test/openai-compatible-errors.test.ts\` only for new real-chain assertions.

**Interfaces:**

- Consumes: current adapter normalization and Caelush error contracts.
- Produces: regressions for reasoning drop, usage/finish retention, malformed error isolation, no retry, abort, timeout, and SDK isolation.

- [ ] **Step 1: Add reasoning plus tool test**

Place reasoning before a tool call and assert the result text contains no raw reasoning while the tool call remains complete.

- [ ] **Step 2: Add usage/finish test**

Put usage in the final chunk of a parallel/odd tool stream; assert exact token counts and provider-derived finish mapping.

- [ ] **Step 3: Add malformed secret test**

Return malformed SSE containing \`CAELUSH_TEST_SECRET_DO_NOT_LEAK_42\`; assert \`LLMInvalidResponseError\`, and assert neither its message nor JSON serialization contains the sentinel/body.

- [ ] **Step 4: Run safety suite and commit**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts packages/llm/test/openai-compatible-errors.test.ts packages/llm/test/gateway-abort.test.ts packages/llm/test/gateway-errors.test.ts packages/llm/test/architecture-sdk-isolation.test.ts tests/architecture/package-boundaries.test.ts
git add packages/llm/test/openai-compatible-compatibility.test.ts packages/llm/test/openai-compatible-errors.test.ts
git commit -m "test(llm): cover compatibility safety regressions"
```

Expected: HTTP 429 request count is 1; external abort and Gateway timeout still abort the underlying fetch; only adapter files import AI SDK.

### Task 8: Add the opt-in developer smoke utility

**Files:**

- Create \`packages/llm/scripts/smoke-openai-compatible.ts\`.
- Modify \`packages/llm/package.json\` only if a non-default developer script entry is needed.

**Interfaces:**

- Consumes: explicit smoke environment variables in the script and public Caelush API.
- Produces: \`PASSED\`, \`SKIPPED\`, or sanitized \`FAILED\`; no CI/API dependency.

- [ ] **Step 1: Implement skip and plain-text paths**

Without \`CAELUSH_LLM_SMOKE=1\`, or without \`CAELUSH_OPENAI_COMPATIBLE_BASE_URL\`, \`CAELUSH_OPENAI_COMPATIBLE_API_KEY\`, and \`CAELUSH_OPENAI_COMPATIBLE_MODEL\`, print \`SKIPPED\` and exit 0. Otherwise call the provider with explicit options, request \`Reply with exactly: CAELUSH_OK\`, and accept \`text.trim() === "CAELUSH_OK"\` plus a finish.

- [ ] **Step 2: Implement optional tool path**

Only with \`CAELUSH_LLM_SMOKE_TOOL=1\`, provide data-only \`get_test_value\` with the empty-object schema, assert \`toolCalls.length >= 1\`, and never execute it. Print \`SKIPPED: unsupported\` for provider tool limitations.

- [ ] **Step 3: Verify exclusion from production/CI and commit**

Run the no-env path, confirm \`packages/llm/src/index.ts\` does not export the script, and confirm \`pnpm check\` does not invoke it.

```powershell
git add packages/llm/scripts/smoke-openai-compatible.ts packages/llm/package.json
git commit -m "test(llm): add optional openai compatible smoke"
```

### Task 9: Document the measured matrix and Phase 4 boundary

**Files:**

- Create \`docs/architecture/openai-compatible-compatibility.md\`.
- Modify \`docs/architecture/llm-gateway.md\`.
- Modify \`AGENTS.md\`.

**Interfaces:**

- Consumes: measured classifications and test evidence from Tasks 2–7.
- Produces: auditable matrix, workaround records, and final Phase 4 boundary.

- [ ] **Step 1: Write the matrix**

Use columns \`Case | Upstream Result | Caelush Result | Policy\` for standard, fragmented, premature JSON, late name, all index forms, all ID forms, parameterless, parallel, same-name parallel, ambiguous delta, and out-of-order cases. Fill values from actual tests only.

- [ ] **Step 2: Record workaround policy**

For each workaround record trigger, SDK deficiency, deterministic algorithm, round-trip proof, fixture, and removal condition. If none exists, write \`No local compatibility workaround was needed.\` Also record pinned versions and known unsupported shapes.

- [ ] **Step 3: Update architecture and AGENTS**

State that Gateway behavior is unchanged; compatibility tests use the real AI SDK path; upstream fixes are preferred; ambiguous identity fails closed; no synthetic IDs; workarounds are adapter-private; no node_modules patching; Phase 4 ends without AgentLoop/ContextBuilder/tool execution.

- [ ] **Step 4: Format and commit**

```powershell
pnpm exec prettier --write docs/architecture/openai-compatible-compatibility.md docs/architecture/llm-gateway.md AGENTS.md
git add docs/architecture/openai-compatible-compatibility.md docs/architecture/llm-gateway.md AGENTS.md
git commit -m "docs: document openai compatibility matrix"
```

### Task 10: Perform final Phase 4 audit and verification

**Files:**

- Modify the plan checkboxes only; no new production behavior is permitted.

**Interfaces:**

- Consumes: all committed 4C-2 changes.
- Produces: clean, fully verified Phase 4C-2 branch and completion-report evidence.

- [ ] **Step 1: Audit source and declarations**

```powershell
rg -n 'from "ai"|from "@ai-sdk/|require\("ai"\)|require\("@ai-sdk/' packages/llm/src
rg -n 'AgentLoop|ContextBuilder|ToolDispatcher|EventBus|Storage|sqlite|drizzle|execute:|crypto\.randomUUID|latestToolCall|setTimeout|AbortSignal\.timeout|maxRetries' packages/llm/src
pnpm build
rg -n 'ModelMessage|ToolSet|StreamTextResult|LanguageModel|@ai-sdk/|from "ai"' packages/llm/dist/index.d.ts
```

Expected: SDK imports only in the adapter, no forbidden runtime/identity/timeout/retry additions, \`maxRetries: 0\` retained, and no public declaration matches.

- [ ] **Step 2: Run focused compatibility verification**

```powershell
pnpm exec vitest run packages/llm/test/openai-compatible-compatibility.test.ts packages/llm/test/openai-compatible-errors.test.ts packages/llm/test/gateway-abort.test.ts packages/llm/test/architecture-sdk-isolation.test.ts tests/architecture/package-boundaries.test.ts
```

Record test files, tests, failures, and characterization versus true RED → GREEN evidence.

- [ ] **Step 3: Identify and remove generated targets safely**

```powershell
Get-ChildItem -Directory apps,packages -Recurse -Filter dist
Get-ChildItem -File -Recurse -Filter *.tsbuildinfo
```

Remove only the listed \`apps/_/dist\`, \`packages/_/dist\`, and \`*.tsbuildinfo\` targets using exact validated paths. Do not run \`git clean\`, broad deletion, reset, or force checkout.

- [ ] **Step 4: Reinstall and run every final check**

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm check
```

Every command must exit 0; record the full test count and smoke skip reason.

- [ ] **Step 5: Verify final history and status**

```powershell
git diff --check
git status --short
git log --oneline --decorate -25
```

Expected: clean status, no diff-check errors, \`c596938\` visibly identifiable as the Phase 4C-1 baseline, and all 4C-2 commits visible. Do not push.

- [ ] **Step 6: Prepare the required completion report**

Report baseline, dependencies, every measured matrix classification, round-trip IDs, local workaround result, parallel/same-name behavior, reasoning/usage/error/abort/timeout/no-retry/secret audits, smoke status, SDK isolation, declarations, tests, TDD evidence, full verification, clean build, Git history/status, final architecture, current capabilities, explicit non-goals, Phase 4 status, and Phase 5 as the next out-of-scope phase.
