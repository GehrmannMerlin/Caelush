# Caelush Phase 6A Agent Execution Contracts & Kernel State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish deterministic Agent Kernel contracts and pure state helpers that classify one provider turn, represent tool/final boundaries, normalize tool-result resume batches, track AgentState/AgentStep, and enforce only the structural `maxSteps` guard without implementing the AgentLoop.

**Architecture:** Keep provider-neutral turn schemas in the existing `@caelush/llm` package and expose them through a narrow `@caelush/llm/turn` subpath. Put Kernel-owned decision, error, summary, tool-result, state, step, and gate helpers in `@caelush/core`; Core may import only `@caelush/protocol`, `@caelush/llm/messages`, and `@caelush/llm/turn`. Every helper is pure, caller-owned clock/ID, schema-validates its boundary input, and returns immutable-style new values. The final model response stops at `VERIFYING`; tools are requested and results are normalized but never executed.

**Tech Stack:** TypeScript ESM, Zod 4 schemas, pnpm workspace packages, Vitest, ESLint, TypeScript project builds, Prettier.

**Spec:** User-provided Phase 6A specification in `C:\Users\韩吉衍\.codex\attachments\53fd4507-adea-417d-beaf-3bdc13bb7a8d\pasted-text.txt`.

## Global Constraints

- Phase 6 contains exactly 6A, 6B, and 6C; do not add additional Phase 6 rounds.
- One settled LLM provider turn is one Agent Step attempt.
- Agent decisions are limited to `TOOL_CALLS_REQUESTED` or `FINAL_CANDIDATE`; structural max-step exhaustion is an `AgentLoopOutcome` rather than an LLM decision.
- Tool execution is outside the Phase 6 Agent Kernel; Phase 6 must never execute a Tool directly.
- Tool calls with a `LENGTH` finish reason must never be executed because their arguments may be truncated even if the partial JSON parses.
- A final model response is only a `FINAL_CANDIDATE` and must move the Run toward `VERIFYING`, never directly to `COMPLETED`.
- Agent Kernel code must not know concrete tools such as `read_file`, `shell`, or `apply_patch`.
- Tool result batches must contain exactly one matching result for every requested tool call before the next provider turn.
- Parallel tool results may arrive in completion order but must be normalized to assistant source order before entering model history.
- Public reasoning summaries must never expose raw hidden reasoning, model answer text, tool arguments, or secrets.
- `UsageState.steps` counts settled Agent Step attempts, including failed attempts; model-requested tools do not increment `UsageState.toolCalls`.
- Phase 6A owns only `maxSteps` as a structural loop guard; retry, timeout, token/cost budgets, and tool-call budgets remain Phase 10 responsibilities.
- Kernel helpers must be deterministic and must not call `Date.now()` or generate IDs.
- No AgentLoop, ContextBuilder invocation, LLMGateway invocation, ToolRegistry, ToolDispatcher, Tool execution, Verification execution, Storage, EventBus, Daemon integration, AI SDK, hidden CoT, or new `V2` contracts.

## Architecture References

| Concept                                                          | Source                                                                                    | What Caelush adopts                                                                                                                                                                     | What Caelush intentionally does not adopt                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Turn/sampling lifecycle and assistant-vs-function-call branching | `openai/codex`, `codex-rs/core/src/session/turn.rs`, `codex-rs/core/src/tasks/regular.rs` | One provider sampling turn is a bounded step; tool output is fed into a later turn; cancellation/error boundaries are explicit.                                                         | Codex's host-specific hooks, compaction, retries, concrete tool router, filesystem/MCP integration, event plumbing, and hidden reasoning. |
| Agent/turn/message lifecycle and parallel result ordering        | `earendil-works/pi`, `packages/agent/src/agent-loop.ts`, `packages/agent/src/types.ts`    | Distinguish turn/step lifecycle; preserve assistant tool-call source order when appending results even when execution completes in another order; treat truncated tool calls as unsafe. | Pi's low-level tool execution, tool schemas, steering/follow-up queues, custom AgentMessage types, and stream implementation.             |
| Stream/tool/error boundary and repeated-call protection          | `anomalyco/opencode`, `packages/opencode/src/session/processor.ts`                        | Keep provider event/tool state transitions explicit and fail at the boundary; document repeated-call concerns for future loop work.                                                     | OpenCode's Effect runtime, database writes, permission prompts, provider-specific stream transformations, and retry/doom-loop policy.     |

## File Map

- Modify `packages/llm/package.json` to publish `./turn`.
- Create `packages/llm/src/turn.ts` as a re-export-only provider-independent turn contract entry.
- Create `packages/llm/test/turn-subpath.test.ts` to prove built subpath resolution and SDK isolation.
- Create `packages/core/src/agent-errors.ts` for sanitized Kernel boundary errors.
- Create `packages/core/src/agent-decision.ts` for `AgentModelTurn`, tool/final decisions, and loop outcomes.
- Create `packages/core/src/agent-decision-mapper.ts` for validated `LLMTurnResult` classification and canonical assistant messages.
- Create `packages/core/src/agent-summary.ts` for public decision/outcome summaries.
- Create `packages/core/src/agent-tool-results.ts` for complete, identity/name-checked, source-ordered result batches.
- Create `packages/core/src/agent-state.ts` for initial/start/begin/settle/verifying/max-step state transitions.
- Create `packages/core/src/agent-step.ts` for caller-owned-ID/clock step lifecycle and sequence calculation.
- Create `packages/core/src/agent-step-gate.ts` for the `maxSteps` structural gate.
- Modify `packages/core/src/index.ts` to expose only the required public Phase 6A API and never an AgentLoop.
- Create focused Core tests for each public contract plus architecture/public API and pure Kernel E2E coverage.
- Create `packages/core/test/support/fixtures.ts` for deterministic IDs, models, runs, states, turn results, requests, and tool results used by focused tests.
- Create `docs/architecture/agent-loop.md`, and update `README.md` and `AGENTS.md` with the fixed Phase 6 boundary.

### Task 1: Expose the provider-independent LLM turn subpath

**Files:**

- Create: `packages/llm/src/turn.ts`
- Modify: `packages/llm/package.json`
- Test: `packages/llm/test/turn-subpath.test.ts`

**Interfaces:**

- Consumes existing exports from `./result.js`, `./tool-call.js`, and `./usage.js`.
- Produces the public `@caelush/llm/turn` exports: `LLMTurnResultSchema`, `LLMTurnResult`, `LLMToolCallSchema`, `LLMToolCall`, `FinishReasonSchema`, `FinishReason`, `LLMUsageSchema`, and `LLMUsage`.

- [ ] **Step 1: Write the failing built-subpath test**

```ts
import * as turn from "@caelush/llm/turn";
import { describe, expect, it } from "vitest";

describe("LLM turn subpath", () => {
  it("resolves provider-independent turn contracts from the built package", () => {
    expect(turn.FinishReasonSchema.parse("STOP")).toBe("STOP");
    expect(turn.LLMUsageSchema.parse({ inputTokens: 2 })).toEqual({ inputTokens: 2 });
    expect(turn.LLMToolCallSchema.parse({ id: "call_a", name: "read_file", input: {} })).toEqual({
      id: "call_a",
      name: "read_file",
      input: {},
    });
    expect(turn.LLMTurnResultSchema).toBeDefined();
    expect((turn as Record<string, unknown>).LLMGateway).toBeUndefined();
    expect((turn as Record<string, unknown>).createOpenAICompatibleLLMProvider).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the subpath is missing**

Run: `pnpm exec vitest run packages/llm/test/turn-subpath.test.ts`

Expected: FAIL resolving `@caelush/llm/turn`, before any implementation exists.

- [ ] **Step 3: Add the re-export-only entry and package export**

```ts
// packages/llm/src/turn.ts
export { FinishReasonSchema, LLMToolCallSchema } from "./tool-call.js";
export type { FinishReason, LLMToolCall } from "./tool-call.js";
export { LLMUsageSchema } from "./usage.js";
export type { LLMUsage } from "./usage.js";
export { LLMTurnResultSchema } from "./result.js";
export type { LLMTurnResult } from "./result.js";
```

Add to `packages/llm/package.json`:

```json
"./turn": {
  "types": "./dist/turn.d.ts",
  "import": "./dist/turn.js"
}
```

- [ ] **Step 4: Build and rerun the focused test**

Run: `pnpm --filter @caelush/llm build; pnpm exec vitest run packages/llm/test/turn-subpath.test.ts`

Expected: PASS, with no gateway/provider adapter export from the subpath.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/turn.ts packages/llm/package.json packages/llm/test/turn-subpath.test.ts
git commit -m "feat(llm): expose provider-independent turn contracts"
```

### Task 2: Define Core errors and decision contracts

**Files:**

- Create: `packages/core/src/agent-errors.ts`
- Create: `packages/core/src/agent-decision.ts`
- Modify: `packages/core/package.json` (add `@caelush/llm: workspace:*`)
- Test: `packages/core/test/agent-decision.test.ts`

**Interfaces:**

- `AgentModelOutputError` exposes a finite reason union and sanitized metadata only.
- `AgentToolResultBatchError` exposes a finite reason union and sanitized metadata only.
- `AgentKernelStateError` exposes a safe message without input payloads.
- `AgentModelTurn` contains `callId`, `model`, `finishReason`, canonical `assistantMessage`, and optional `usage`.
- `AgentToolRequest` contains only `externalCallId`, `toolName`, and `args`.
- `AgentDecision` is `AgentToolCallsDecision | AgentFinalCandidateDecision`.
- `AgentLoopOutcome` is `AgentDecision | AgentMaxStepsReachedOutcome`.

- [ ] **Step 1: Write failing contract tests**

Create `packages/core/test/support/fixtures.ts` in this task with concrete test-only constructors: `makeAgentRun(overrides?: Partial<AgentRun>): AgentRun`, `makeTurnResult(overrides?: Partial<LLMTurnResult>): LLMTurnResult`, `makeToolCall(id: string, name?: string): LLMToolCall`, `makeToolRequest(id: string, name?: string): AgentToolRequest`, `makeToolResult(id: string, name?: string, isError?: boolean): LLMToolResultMessage`, `makeTimestamp(value: number): TimestampMs`, `makeStepId(): StepId`, `makeRunId(): RunId`, `makeToolDecisionWithNames(names: string[]): AgentToolCallsDecision`, `makeToolDecisionWithNamesAndSecret(text: string, secret: string): AgentToolCallsDecision`, `makeRequestsFor(kind: string): AgentToolRequest[]`, `makeResultsFor(kind: string): LLMToolResultMessage[]`, and `makeRunningStateWithSteps(steps: number): AgentState`. Each helper must use fixed valid UUIDv7 fixture strings, parse schema-backed values where applicable, and remain test-only; no production helper may generate these values.

```ts
it("exports the discriminated decision and sanitized error contracts", async () => {
  const core = await import("../src/index.js");
  expect(core.AgentModelOutputError).toBeDefined();
  expect(core.AgentToolResultBatchError).toBeDefined();
  expect(core.AgentKernelStateError).toBeDefined();
  const decision: core.AgentDecision = {
    type: "FINAL_CANDIDATE",
    modelTurn: {} as core.AgentModelTurn,
    candidateText: "candidate",
  };
  expect(decision.type).toBe("FINAL_CANDIDATE");
  const outcome: core.AgentLoopOutcome = {
    type: "MAX_STEPS_REACHED",
    stepsCompleted: 2,
    maxSteps: 2,
  };
  expect(outcome.type).toBe("MAX_STEPS_REACHED");
});

it("does not serialize sensitive output data in model errors", async () => {
  const core = await import("../src/index.js");
  const error = new core.AgentModelOutputError("OUTPUT_TRUNCATED", {
    callId: "llm_00000000-0000-7000-8000-000000000000" as never,
    model: { provider: "test", model: "fixture" },
    finishReason: "LENGTH",
    toolCallCount: 1,
  });
  expect(JSON.stringify(error)).not.toContain("CAELUSH_AGENT_KERNEL_SECRET_42");
});
```

- [ ] **Step 2: Run the focused test and observe the missing exports**

Run: `pnpm exec vitest run packages/core/test/agent-decision.test.ts`

Expected: FAIL because the new contracts are not exported.

- [ ] **Step 3: Implement minimal sanitized errors and union types**

Use `LLMAssistantMessage`, `LLMCallId`, `ModelRef`, `ToolName`, `JsonObject`, `FinishReason`, and `LLMUsage` as imported types. Error constructors may retain only reason plus safe metadata (`callId`, `model`, `finishReason`, `toolCallCount`, or a count/reason identifier); never interpolate `text`, `args`, prompts, provider response objects, secrets, or causes into public fields/messages.

- [ ] **Step 4: Run Core typecheck and focused tests**

Run: `pnpm --filter @caelush/core typecheck; pnpm exec vitest run packages/core/test/agent-decision.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-errors.ts packages/core/src/agent-decision.ts packages/core/test/agent-decision.test.ts
git commit -m "feat(core): define agent decision contracts"
```

### Task 3: Map one validated LLM turn to a Kernel decision

**Files:**

- Create: `packages/core/src/agent-decision-mapper.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-decision.test.ts`

**Interfaces:**

- `classifyAgentDecision(result: LLMTurnResult): AgentDecision`.
- The mapper must `LLMTurnResultSchema.safeParse`, check `providerId === model.provider`, reject duplicate tool IDs, build text-first canonical `LLMAssistantMessage`, preserve exact text and input objects/order, and runtime-validate the constructed assistant message.

- [ ] **Step 1: Add RED matrix tests before implementation**

Cover these exact cases: `STOP + nonblank text -> FINAL_CANDIDATE`; `OTHER + nonblank text -> FINAL_CANDIDATE`; any tools with `STOP`, `OTHER`, `TOOL_CALLS`, or nonempty text -> `TOOL_CALLS_REQUESTED`; text plus tools preserves both message parts; same-name/different-ID tools are valid; duplicate IDs reject; `LENGTH` and `CONTENT_FILTER` always reject; `TOOL_CALLS` with zero calls rejects; blank/empty STOP or OTHER rejects; malformed result and provider/model mismatch reject. Assert final candidate text equals an input such as `"  hello\\nworld  "` exactly and tool arguments deep-equal a nested JSON fixture.

```ts
it("classifies tool presence before finish reason and preserves canonical message order", () => {
  const result = makeTurnResult({
    text: "I'll inspect this.",
    toolCalls: [
      { id: "call_a", name: "read_file", input: { path: "a.ts", nested: { ok: true } } },
      { id: "call_b", name: "read_file", input: { path: "b.ts" } },
    ],
    finishReason: "STOP",
  });
  const decision = classifyAgentDecision(result);
  expect(decision.type).toBe("TOOL_CALLS_REQUESTED");
  expect(decision.toolRequests.map((request) => request.externalCallId)).toEqual([
    "call_a",
    "call_b",
  ]);
  expect(decision.modelTurn.assistantMessage.content).toEqual([
    { type: "text", text: "I'll inspect this." },
    {
      type: "tool-call",
      toolCallId: "call_a",
      toolName: "read_file",
      input: { path: "a.ts", nested: { ok: true } },
    },
    { type: "tool-call", toolCallId: "call_b", toolName: "read_file", input: { path: "b.ts" } },
  ]);
});

it.each(["LENGTH", "CONTENT_FILTER"] as const)(
  "rejects %s even when JSON tool input is parseable",
  (finishReason) => {
    expect(() =>
      classifyAgentDecision(makeTurnResult({ finishReason, toolCalls: [makeToolCall("call_a")] })),
    ).toThrow("OUTPUT_");
  },
);
```

- [ ] **Step 2: Run the matrix and verify RED**

Run: `pnpm exec vitest run packages/core/test/agent-decision.test.ts`

Expected: FAIL because `classifyAgentDecision` is missing.

- [ ] **Step 3: Implement validation, normalization, and precedence**

Build the assistant content as optional exact text first, followed by each tool call in `result.toolCalls` order. Use `result.text.trim().length` only to decide whether a no-tool final candidate is nonblank. Never trim or rewrite the candidate. Validate both input result and constructed assistant message with Zod safe parsing and translate all failures to `AgentModelOutputError` with safe metadata. Permit unknown-but-schema-valid tool names; do not consult ToolDefinition or a registry.

- [ ] **Step 4: Run the focused matrix and typecheck**

Run: `pnpm --filter @caelush/core typecheck; pnpm exec vitest run packages/core/test/agent-decision.test.ts`

Expected: PASS for all mapper cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-decision-mapper.ts packages/core/src/index.ts packages/core/test/agent-decision.test.ts
git commit -m "feat(core): classify model turns into agent decisions"
```

### Task 4: Add public decision and loop-outcome summaries

**Files:**

- Create: `packages/core/src/agent-summary.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-summary.test.ts`

**Interfaces:**

- `summarizeAgentDecision(decision: AgentDecision): string`.
- `summarizeAgentLoopOutcome(outcome: AgentLoopOutcome): string`.

- [ ] **Step 1: Write failing summary tests**

```ts
it("summarizes tool names without text or arguments", () => {
  const decision = makeToolDecisionWithNamesAndSecret(
    "CAELUSH_PRIVATE_MODEL_TEXT",
    "CAELUSH_SECRET_DO_NOT_LEAK",
  );
  const summary = summarizeAgentDecision(decision);
  expect(summary).toContain("read_file");
  expect(summary).toContain("search_text");
  expect(summary).not.toContain("CAELUSH_PRIVATE_MODEL_TEXT");
  expect(summary).not.toContain("CAELUSH_SECRET_DO_NOT_LEAK");
});

it("limits displayed tool names and summarizes max steps", () => {
  const summary = summarizeAgentDecision(makeToolDecisionWithNames(["a", "b", "c", "d", "e", "f"]));
  expect(summary).toContain("+ 1 more");
  expect(
    summarizeAgentLoopOutcome({ type: "MAX_STEPS_REACHED", stepsCompleted: 8, maxSteps: 8 }),
  ).toContain("8");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run packages/core/test/agent-summary.test.ts`

Expected: FAIL because summary helpers are missing.

- [ ] **Step 3: Implement fixed public-safe summaries**

Return a fixed final string such as `Produced a final candidate response; verification is required before completion.`. For tool decisions show at most five tool names in request order and append `+ N more` when needed. Never read `candidateText` or `request.args` into output. Keep summaries deterministic and non-secret.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run packages/core/test/agent-summary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-summary.ts packages/core/src/index.ts packages/core/test/agent-summary.test.ts
git commit -m "feat(core): add public agent decision summaries"
```

### Task 5: Normalize complete tool-result resume batches

**Files:**

- Create: `packages/core/src/agent-tool-results.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-tool-results.test.ts`

**Interfaces:**

- `normalizeToolResultBatch(requests: readonly AgentToolRequest[], results: readonly LLMToolResultMessage[]): readonly LLMToolResultMessage[]`.

- [ ] **Step 1: Write failing batch tests**

Cover one success, one `isError: true` result, parallel `B,A` input normalized to request order `A,B`, missing result, extra result, duplicate result, wrong name, invalid message, duplicate request IDs, and a secret sentinel in args proving `error.message`/`JSON.stringify(error)` never include args.

```ts
it("accepts completion order but returns assistant source order", () => {
  const requests = [
    makeToolRequest("call_a", "read_file"),
    makeToolRequest("call_b", "search_text"),
  ];
  const normalized = normalizeToolResultBatch(requests, [
    makeToolResult("call_b", "search_text"),
    makeToolResult("call_a", "read_file"),
  ]);
  expect(normalized.map((item) => item.toolCallId)).toEqual(["call_a", "call_b"]);
});

it.each(["missing", "extra", "duplicate", "wrong-name"])(
  "rejects an incomplete or inconsistent %s batch",
  (kind) => {
    expect(() => normalizeToolResultBatch(makeRequestsFor(kind), makeResultsFor(kind))).toThrow();
  },
);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm exec vitest run packages/core/test/agent-tool-results.test.ts`

Expected: FAIL because the normalizer is missing.

- [ ] **Step 3: Implement schema validation and identity/name matching**

Validate every result with `LLMToolResultMessageSchema.safeParse` before matching. Reject duplicate request IDs first, require equal cardinality, reject duplicate/unknown result IDs, require exact tool-name match, accept error results, and return `requests` order. Error metadata may contain only counts/IDs/names needed for diagnosis; never embed args or result content.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @caelush/core typecheck; pnpm exec vitest run packages/core/test/agent-tool-results.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-tool-results.ts packages/core/src/index.ts packages/core/test/agent-tool-results.test.ts
git commit -m "feat(core): normalize tool result resume batches"
```

### Task 6: Build initial AgentState and deterministic state transitions

**Files:**

- Create: `packages/core/src/agent-state.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-state.test.ts`

**Interfaces:**

- `createInitialAgentState(run: AgentRun, now: TimestampMs): AgentState`.
- `startAgentState(state: AgentState, now: TimestampMs): AgentState`.
- `beginAgentStepState(state: AgentState, stepId: StepId, now: TimestampMs): AgentState`.
- `settleAgentStepState(state: AgentState, input: { stepId: StepId; usage?: LLMUsage; now: TimestampMs }): AgentState`.
- `markAgentStateVerifying(state: AgentState, now: TimestampMs): AgentState`.
- `markAgentStateMaxStepsReached(state: AgentState, now: TimestampMs): AgentState`.

- [ ] **Step 1: Write failing state tests**

Assert exact initial projection from a `PENDING` run; reject non-PENDING and `now < run.createdAt`; use the existing `assertRunStatusTransition` for `PENDING -> RUNNING`, `RUNNING -> VERIFYING`, and `RUNNING -> MAX_STEPS_REACHED`; reject timestamp regression, double begin, begin outside RUNNING, wrong settle ID, verifying with active step, and reactivation of terminal max-step state. Assert begin leaves `usage.steps` unchanged, settle clears current step and increments steps, known input/output usage accumulates, missing fields preserve counts, total/cached/reasoning fields do not alter Protocol UsageState, and requested tools do not increment `toolCalls`.

```ts
it("projects a pending run, settles a step, and moves a final candidate to VERIFYING", () => {
  const initial = createInitialAgentState(makeAgentRun({ status: "PENDING" }), makeTimestamp(200));
  const running = startAgentState(initial, makeTimestamp(210));
  const active = beginAgentStepState(running, makeStepId(), makeTimestamp(220));
  expect(active.usage.steps).toBe(0);
  const settled = settleAgentStepState(active, {
    stepId: active.currentStepId!,
    usage: { inputTokens: 50, outputTokens: 10 },
    now: makeTimestamp(230),
  });
  expect(settled.usage.steps).toBe(1);
  const verifying = markAgentStateVerifying(settled, makeTimestamp(240));
  expect(verifying.status).toBe("VERIFYING");
  expect(verifying.verification).toBe("NOT_RUN");
  expect(verifying.status).not.toBe("COMPLETED");
});
```

- [ ] **Step 2: Run focused state tests and verify RED**

Run: `pnpm exec vitest run packages/core/test/agent-state.test.ts`

Expected: FAIL because state helpers are missing.

- [ ] **Step 3: Implement pure state transitions**

Construct fresh arrays and values from the existing `AgentState` schema. Initial state copies only the specified run fields, uses empty plan/observations/changedFiles/processes/errors, `NOT_RUN`, zero usage, no current step, no started time, and `updatedAt: now`. Every helper requires `now >= updatedAt`; all status transitions call `assertRunStatusTransition`. Do not set `COMPLETED`, copy run model/limits/finalResult/createdAt into state, call clocks, or generate IDs.

- [ ] **Step 4: Run focused state tests and typecheck**

Run: `pnpm --filter @caelush/core typecheck; pnpm exec vitest run packages/core/test/agent-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-state.ts packages/core/src/index.ts packages/core/test/agent-state.test.ts
git commit -m "feat(core): add deterministic agent state transitions"
```

### Task 7: Add AgentStep lifecycle helpers

**Files:**

- Create: `packages/core/src/agent-step.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-step.test.ts`

**Interfaces:**

- `createRunningAgentStep(input: { id: StepId; runId: RunId; sequence: number; startedAt: TimestampMs }): AgentStep`.
- `completeAgentStep(step: AgentStep, input: { finishedAt: TimestampMs; reasoningSummary: string }): AgentStep`.
- `failAgentStep(step: AgentStep, finishedAt: TimestampMs): AgentStep`.
- `cancelAgentStep(step: AgentStep, finishedAt: TimestampMs): AgentStep`.
- `nextAgentStepSequence(state: AgentState): number`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover running creation with caller-provided ID/clock/sequence; completion with preserved summary; failure/cancellation; double completion and invalid terminal transitions; finish time before start rejection; and safe-integer sequence overflow.

```ts
it("uses caller-owned identity and clock and preserves a public summary", () => {
  const step = createRunningAgentStep({
    id: makeStepId(),
    runId: makeRunId(),
    sequence: 1,
    startedAt: makeTimestamp(100),
  });
  expect(step).toMatchObject({ status: "RUNNING", sequence: 1, startedAt: makeTimestamp(100) });
  expect(
    completeAgentStep(step, {
      finishedAt: makeTimestamp(110),
      reasoningSummary: "Requested 1 tool call: read_file.",
    }).reasoningSummary,
  ).toBe("Requested 1 tool call: read_file.");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm exec vitest run packages/core/test/agent-step.test.ts`

Expected: FAIL because lifecycle helpers are missing.

- [ ] **Step 3: Implement schema-backed terminal helpers**

Reject non-RUNNING settlement and all terminal-to-terminal/reactivation transitions. Require a nonblank reasoning summary for completion through the existing `AgentStepSchema`; set `finishedAt` for every terminal helper; compute the next sequence as `usage.steps + 1` and reject values at/over `Number.MAX_SAFE_INTEGER` rather than overflowing. Do not call `createStepId`, `Date.now`, or any other generator.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @caelush/core typecheck; pnpm exec vitest run packages/core/test/agent-step.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-step.ts packages/core/src/index.ts packages/core/test/agent-step.test.ts
git commit -m "feat(core): add agent step lifecycle"
```

### Task 8: Add the structural max-step gate

**Files:**

- Create: `packages/core/src/agent-step-gate.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-step-gate.test.ts`

**Interfaces:**

- `evaluateAgentStepGate(state: AgentState, limits: RunLimits): AgentStepGate`, where allowed is `{ allowed: true; nextSequence: number }` and blocked is `{ allowed: false; outcome: AgentMaxStepsReachedOutcome }`.

- [ ] **Step 1: Write failing gate tests**

Cover `0/8 -> allowed sequence 1`, `7/8 -> allowed sequence 8`, `8/8 -> MAX_STEPS_REACHED`, `9/8 -> MAX_STEPS_REACHED`, active step rejection, non-RUNNING rejection, and demonstrate that changing `maxToolCalls`, `timeoutMs`, `maxTokens`, or `maxCost` does not change the result.

```ts
it("blocks at and beyond maxSteps without owning other budgets", () => {
  const state = makeRunningStateWithSteps(8);
  const result = evaluateAgentStepGate(state, {
    maxSteps: 8,
    maxToolCalls: 1,
    timeoutMs: 1,
    maxTokens: 1,
    maxCost: 0,
  });
  expect(result).toEqual({
    allowed: false,
    outcome: { type: "MAX_STEPS_REACHED", stepsCompleted: 8, maxSteps: 8 },
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm exec vitest run packages/core/test/agent-step-gate.test.ts`

Expected: FAIL because the gate is missing.

- [ ] **Step 3: Implement only the maxSteps decision**

Require `state.status === "RUNNING"` and no `currentStepId`, call `nextAgentStepSequence` only for allowed cases, compare `usage.steps < limits.maxSteps`, and return an expected outcome rather than throwing at the boundary. Do not enforce any other limit.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @caelush/core typecheck; pnpm exec vitest run packages/core/test/agent-step-gate.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-step-gate.ts packages/core/src/index.ts packages/core/test/agent-step-gate.test.ts
git commit -m "feat(core): add max-step gate"
```

### Task 9: Add public API, architecture guards, and pure Kernel E2E

**Files:**

- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/public-api.test.ts`
- Create: `packages/core/test/architecture.test.ts`
- Create: `packages/core/test/agent-kernel-e2e.test.ts`

**Interfaces:**

- Export exactly the required Phase 6A contracts/helpers listed by the spec, while not exporting `AgentLoop` or `runAgentLoop`.

- [ ] **Step 1: Write failing API/architecture/E2E tests**

Assert Core package dependency entries are exactly `@caelush/protocol` and `@caelush/llm` with `workspace:*`; source imports are limited to `@caelush/protocol`, `@caelush/llm/messages`, and `@caelush/llm/turn`; no `@caelush/llm` root import, context/storage/events/runtime/tools/security/verification/daemon edges, AI SDK/network/filesystem/child process/EventBus/Date.now/randomUUID/explicit `any`; declarations contain only permitted external names. The E2E fixture must run `PENDING -> RUNNING -> step 1 tool request -> settle -> manually supplied B/A results normalized to A/B -> step 2 final candidate -> VERIFYING`, plus maxSteps=1 and LENGTH+tool rejection.

```ts
it("does not expose an AgentLoop in the Phase 6A public API", async () => {
  const api = await import("../src/index.js");
  expect((api as Record<string, unknown>).AgentLoop).toBeUndefined();
  expect((api as Record<string, unknown>).runAgentLoop).toBeUndefined();
});
```

- [ ] **Step 2: Run the new focused suite and verify RED**

Run: `pnpm exec vitest run packages/core/test/public-api.test.ts packages/core/test/architecture.test.ts packages/core/test/agent-kernel-e2e.test.ts`

Expected: FAIL for missing API/E2E/architecture assertions before final exports/fixtures are complete.

- [ ] **Step 3: Complete the Core barrel and tests**

Export the schema/type/error/mapper/summary/batch/state/step/gate symbols specified by the Phase 6A contract. Keep helper implementation details private. Avoid root `@caelush/llm` imports in Core production source.

- [ ] **Step 4: Run focused Core and LLM tests**

Run: `pnpm exec vitest run packages/llm/test/turn-subpath.test.ts packages/core/test/agent-decision.test.ts packages/core/test/agent-summary.test.ts packages/core/test/agent-tool-results.test.ts packages/core/test/agent-state.test.ts packages/core/test/agent-step.test.ts packages/core/test/agent-step-gate.test.ts packages/core/test/public-api.test.ts packages/core/test/architecture.test.ts packages/core/test/agent-kernel-e2e.test.ts`

Expected: PASS with no AgentLoop execution.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/test
git commit -m "test(core): cover agent kernel boundaries"
```

### Task 10: Document the fixed Phase 6 boundary and update repository guidance

**Files:**

- Create: `docs/architecture/agent-loop.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write documentation assertions/checklist**

Before editing, verify the docs will contain the exact fixed sequence `6A Contracts & State`, `6B Resumable Loop`, `6C Run Controller / Persistence / Events`, the sentence `No additional Phase 6 rounds.`, the Observe → Build Context → LLM Provider Turn → Agent Decision diagram, the complete finish-reason table, tool-result batch integrity/order, usage semantics, maxSteps-only guard, and no-retry statement.

- [ ] **Step 2: Add the architecture document**

Document that one settled provider turn equals one Agent Step attempt (including failed attempts), tool calls are requested at an external execution boundary, tool results resume in a later step, a final is only a candidate requiring verification, and Phase 6A has no loop/Gateway/ContextBuilder/tool/storage/event integration.

- [ ] **Step 3: Update README and AGENTS**

Change the current stage to `Phase 6A — Agent Execution Contracts & Kernel State`, describe deterministic decision/step/tool-boundary/kernel-state semantics, and explicitly avoid claiming autonomous agent execution. Add the Phase 6 rules from the specification to `AGENTS.md` without weakening existing Phase 0–5 rules.

- [ ] **Step 4: Run docs/API checks and commit**

Run: `pnpm exec vitest run packages/core/test/public-api.test.ts packages/core/test/architecture.test.ts; git diff --check`

Expected: PASS.

```bash
git add docs/architecture/agent-loop.md README.md AGENTS.md
git commit -m "docs: define phase 6 agent kernel architecture"
```

## Final Verification Checklist

- [ ] Read the plan and inspect `git diff`; confirm no implementation of AgentLoop, retries, tools, Gateway, ContextBuilder, Verification, Storage, EventBus, or host integration.
- [ ] Run `pnpm install --frozen-lockfile`.
- [ ] Run focused tests and record test files/tests/failures/skipped for turn subpath, decision, summaries, tool batches, state, step, gate, public API, architecture, and E2E.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test` after build has completed.
- [ ] Run `pnpm build`.
- [ ] Run changed-file Prettier check based on `git diff --name-only b68d1a5698e9ea9dad625c19f5c8e4bdc24bfe4d...HEAD`, ensuring all supported changed files pass.
- [ ] Run `pnpm format:check`; compare final failure count with the 291-file baseline and ensure Phase 6A changed-file failures are zero.
- [ ] Run `pnpm check`; if it fails only on the known historical Prettier debt, report that accurately.
- [ ] Remove generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` safely with Node fs, never `git clean`; reinstall/build/test again.
- [ ] Audit `packages/core/dist/index.d.ts` for only `@caelush/protocol`, `@caelush/llm/messages`, and `@caelush/llm/turn` external declarations.
- [ ] Run `git diff --check`, `git status --short`, and verify no unrelated user files changed.
- [ ] Commit all intended changes in focused commits; run `git rev-parse HEAD`.
- [ ] Push `codex/phase-6a-agent-kernel-contracts` with `git push -u origin codex/phase-6a-agent-kernel-contracts` (never force push).
- [ ] Run `git ls-remote --heads origin refs/heads/codex/phase-6a-agent-kernel-contracts` and verify the remote SHA equals local HEAD.
- [ ] Do not merge master and do not create a PR unless explicitly requested.
