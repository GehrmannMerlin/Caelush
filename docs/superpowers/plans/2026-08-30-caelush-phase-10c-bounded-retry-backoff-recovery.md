# Caelush Phase 10C Bounded Retry & Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, durable, restart-safe, cancel-aware, deadline-aware automatic retry for transient LLM/provider failures without ever automatically replaying Tool side effects.

**Architecture:** Keep provider classification in `LLMError.retryable`, expose only safe retry metadata from `AgentLoop`, and make a provider-independent Core `RetryController` calculate bounded backoff decisions. Persist retry state as a strict `WAITING_RETRY` continuation in the existing atomic Run execution commit, then use a separate tokenized `RunRetryRegistry` to wake a fresh controller execution that creates a new Step and LLM call. Reuse existing cancellation, deadline, security, approval, dispatcher, and stale-step boundaries.

**Tech Stack:** TypeScript ESM monorepo, Zod protocol schemas, Vitest, SQLite through existing `RunExecutionStorePort`, pnpm workspace scripts.

**Spec:** `docs/superpowers/specs/2026-08-30-caelush-phase-10c-bounded-retry-design.md`

## Global Constraints

- Phase 10 contains exactly 10A, 10B, 10C, and 10D; this round implements only 10C.
- Automatic retry is only for transient Provider/LLM failures; generic Tool retry is forbidden.
- `LLMError.retryable` is the primary provider-independent classification contract; Core must not inspect HTTP status, headers, provider names, or error messages.
- Retryable durable categories are exactly `LLM_RATE_LIMIT`, `LLM_NETWORK`, and `LLM_TIMEOUT`; `LLM_ABORTED`, authentication, invalid request, unsupported model/capability, invalid response, and generic provider errors are not retried.
- `maxAttempts` includes the initial Provider attempt, is a safe integer in `[1, 10]`, and defaults to `3`.
- Default backoff is bounded exponential with `baseDelayMs = 1000`, `maxDelayMs = 30000`, and injected jitter; no unsafe exponentiation and no hard-coded `Math.random()` in pure logic.
- Every Provider attempt is one Agent Step attempt with a new StepId and new Gateway-owned LLMCallId; failed Steps settle exactly once and increment `usage.steps` exactly once.
- Failed or partial Provider output is never appended to durable Conversation; retry after Tool Results repeats only the Provider turn and never redispatches Tools.
- `WAITING_RETRY` is a strict durable continuation, not a RunStatus or AgentState status. Persist it before notifying or arming a timer.
- Run cancellation, Run deadline, and maxSteps take priority over retry. Retry waiting counts toward the original Phase 10B wall-clock deadline.
- No Phase 10D budgets, Verification execution, COMPLETED transition, transport retry API, remote runtime, browser/computer use, or hard sandbox is added.
- Use TDD: each production behavior gets a failing test first; never change `node_modules`, the lockfile, or pinned AI SDK dependencies.
- Finish with `pnpm check`, `git diff --check`, and a clean worktree; do not use `git reset --hard`, `git clean`, force push, or automatic merge.

### Task 1: Add the pure Retry Policy and decision engine

**Files:**
- Create: `packages/core/src/retry-policy.ts`
- Create: `packages/core/src/retry-controller.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/retry-controller.test.ts`

**Interfaces:**
- Produces `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `RetryJitterSource`, `RetryDecision`, `RetryStopReason`, and `RetryController.decide(input)`.
- `decide` consumes `{ retryable, attempt, maxSteps, steps, now, deadlineAt?, retryAfterMs?, policy, jitter }` and returns either `{ kind: "RETRY", attempt, delayMs }` or `{ kind: "STOP", reason }`.

- [ ] **Step 1: Write failing policy/default and eligibility tests**

```ts
it("defaults to three bounded attempts", () => {
  expect(DEFAULT_RETRY_POLICY).toEqual({
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0,
  });
});

it("stops non-retryable, exhausted, max-step, and deadline cases", () => {
  expect(new RetryController().decide(input({ retryable: false }))).toEqual({
    kind: "STOP",
    reason: "NOT_RETRYABLE",
  });
  expect(new RetryController().decide(input({ attempt: 3 }))).toEqual({
    kind: "STOP",
    reason: "ATTEMPTS_EXHAUSTED",
  });
  expect(new RetryController().decide(input({ steps: 3, maxSteps: 3 }))).toEqual({
    kind: "STOP",
    reason: "MAX_STEPS_REACHED",
  });
});
```

- [ ] **Step 2: Run the focused test and observe the expected missing-symbol failure**

Run: `pnpm exec vitest run packages/core/test/retry-controller.test.ts`

Expected: FAIL because the Retry policy/controller exports do not exist yet.

- [ ] **Step 3: Implement strict policy validation and deterministic eligibility**

```ts
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0,
});
```

Validate safe integer/range constraints at construction and apply the stop-order `deadline → maxSteps → retryability → attempts` after terminal/cancellation checks supplied by the controller caller.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm exec vitest run packages/core/test/retry-controller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry-policy.ts packages/core/src/retry-controller.ts packages/core/src/index.ts packages/core/test/retry-controller.test.ts
git commit -m "feat(core): add bounded provider retry policy"
```

### Task 2: Implement bounded backoff, jitter, and Retry-After handling

**Files:**
- Modify: `packages/core/src/retry-controller.ts`
- Modify: `packages/core/test/retry-controller.test.ts`

**Interfaces:**
- `RetryJitterSource.next(): number` must return `0 <= x < 1`; invalid values fail closed with a Core input error.
- Delay calculation uses retry index `attempt - 1`, clamps before overflow, applies bounded jitter, and prefers valid positive safe `retryAfterMs` before the policy maximum.

- [ ] **Step 1: Add failing sequence, clamp, jitter, hint, and overflow tests**

```ts
it("calculates bounded deterministic exponential delays", () => {
  const jitter = { next: () => 0.5 };
  expect(controller.decide(input({ attempt: 1, jitter })).delayMs).toBe(1_000);
  expect(controller.decide(input({ attempt: 2, jitter })).delayMs).toBe(2_000);
  expect(controller.decide(input({ attempt: 10, jitter })).delayMs).toBe(30_000);
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "ignores invalid Retry-After %s",
  (retryAfterMs) => {
    expect(controller.decide(input({ attempt: 2, retryAfterMs })).delayMs).toBe(2_000);
  },
);
```

- [ ] **Step 2: Run the focused test and observe failure**

Run: `pnpm exec vitest run packages/core/test/retry-controller.test.ts`

Expected: FAIL on unimplemented delay/hint behavior.

- [ ] **Step 3: Implement overflow-safe bounded delay arithmetic and jitter clamp**

Use a loop that doubles only while the current value is below the cap and `value <= floor(cap / 2)`, then apply jitter without allowing negative, non-finite, or over-cap output.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/core/test/retry-controller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry-controller.ts packages/core/test/retry-controller.test.ts
git commit -m "test(core): cover retry backoff and recovery math"
```

### Task 3: Expose safe provider retry metadata and optional Retry-After

**Files:**
- Modify: `packages/llm/src/errors.ts`
- Modify: `packages/llm/src/index.ts`
- Modify: `packages/core/src/agent-loop-input.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/agent-error-mapper.ts`
- Tests: `packages/llm/test/errors.test.ts`, `packages/core/test/agent-loop-failures.test.ts`

**Interfaces:**
- `LLMErrorContext` accepts optional `retryAfterMs?: number`; the constructor validates it as an optional safe nonnegative integer and does not expose raw response details.
- `AgentLoopFailureResult` optionally carries `{ code: "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT"; retryable: boolean; retryAfterMs?: number }` only when the caught error is an `LLMError` in the safe provider metadata path.

- [ ] **Step 1: Add failing tests for metadata preservation and non-retryable classification**

```ts
it("preserves a safe Retry-After hint on a rate-limit error", () => {
  const error = new LLMRateLimitError(undefined, { retryAfterMs: 2_500 });
  expect(error.retryAfterMs).toBe(2_500);
  expect(error.retryable).toBe(true);
});

it("does not create retry metadata for authentication errors", async () => {
  const result = await runLoopThatFails(new LLMAuthenticationError());
  expect(result.status).toBe("FAILED");
  expect(result.retry).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused tests and observe missing metadata failure**

Run: `pnpm exec vitest run packages/llm/test/errors.test.ts packages/core/test/agent-loop-failures.test.ts`

Expected: FAIL because `retryAfterMs` and failure metadata are absent.

- [ ] **Step 3: Implement validated metadata and safe AgentLoop projection**

Map only `LLMError.code`, `LLMError.retryable`, and validated `retryAfterMs`; retain the existing `AgentError` mapping and discard raw error/message/cause from public results.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/llm/test/errors.test.ts packages/core/test/agent-loop-failures.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src packages/llm/test/errors.test.ts packages/core/src/agent-loop-input.ts packages/core/src/agent-loop.ts packages/core/src/agent-error-mapper.ts packages/core/test/agent-loop-failures.test.ts
git commit -m "feat(llm): expose bounded retry metadata"
```

### Task 4: Add strict WAITING_RETRY continuation and Protocol retry events

**Files:**
- Modify: `packages/core/src/agent-continuation.ts`
- Modify: `packages/core/src/agent-continuation-schema.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Modify: `packages/protocol/src/events/llm.ts`
- Modify: `packages/protocol/src/events/index.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Tests: `packages/core/test/agent-continuation.test.ts`, `packages/protocol/test/event.test.ts`

**Interfaces:**
- `WaitingRetryContinuation` has `type`, `runId`, `failedStepId`, `attempt` (the next attempt number), `maxAttempts`, `nextAttemptAt`, `errorCode`, `mode`, and conditionally required Tool Result context.
- `retry.scheduled` and `retry.started` are strict durable events; `retry.scheduled` payload is `{ attempt, maxAttempts, delayMs, nextAttemptAt, errorCode }`, and `retry.started` payload is `{ attempt, maxAttempts }`.
- Add `llm.failed` with safe `{ model, error: AgentError }` payload for provider failures.

- [ ] **Step 1: Add failing schema/invariant/result tests**

```ts
it("accepts a START retry continuation and rejects unsafe error codes", () => {
  expect(RunContinuationCheckpointSchema.parse(startRetry)).toMatchObject({
    type: "WAITING_RETRY",
    attempt: 2,
  });
  expect(() => RunContinuationCheckpointSchema.parse({ ...startRetry, errorCode: "LLM_AUTHENTICATION" })).toThrow();
});

it("requires complete Tool Result context for a TOOL_RESULTS retry", () => {
  expect(() => RunContinuationCheckpointSchema.parse({ ...startRetry, mode: "TOOL_RESULTS" })).toThrow();
});
```

- [ ] **Step 2: Run focused tests and observe schema failure**

Run: `pnpm exec vitest run packages/core/test/agent-continuation.test.ts packages/protocol/test/event.test.ts`

Expected: FAIL because the continuation/event variants do not exist.

- [ ] **Step 3: Implement strict schemas and invariant handling**

Allow `RUNNING + WAITING_RETRY` only when there is no active Step; allow no continuation for PENDING or terminal Runs; ensure `TOOL_RESULTS` stores the existing pending decision and normalized result batch without adding synthetic conversation messages.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/core/test/agent-continuation.test.ts packages/protocol/test/event.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent-continuation.ts packages/core/src/agent-continuation-schema.ts packages/core/src/run-execution-state.ts packages/core/src/run-controller-input.ts packages/protocol/src/events packages/core/src/run-controller-events.ts packages/core/test/agent-continuation.test.ts packages/protocol/test/event.test.ts
git commit -m "feat(core): persist retry continuation and scheduling"
```

### Task 5: Add the injectable RunRetryRegistry

**Files:**
- Create: `packages/core/src/run-retry-registry.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/index.ts`
- Tests: `packages/core/test/run-retry-registry.test.ts`

**Interfaces:**
- `RunRetryTimerPort.schedule(delayMs, callback)` returns `{ cancel(): void }`.
- `RunRetryRegistry.arm(runId, nextAttemptAt, callback)`, `disarm(runId)`, `dispose()`, and `size`; one registration per Run, token-protected stale callback no-op, bounded timer chunks, injectable clock/timer, and `onError` sink.

- [ ] **Step 1: Add failing deterministic timer tests**

```ts
it("re-arms remaining delay and ignores stale callbacks", () => {
  const timer = new FakeRetryTimer();
  const clock = new FakeClock(1_000);
  const registry = new RunRetryRegistry({ clock, timer });
  const calls: string[] = [];
  registry.arm("run_a" as never, 5_000 as never, () => calls.push("new"));
  registry.arm("run_a" as never, 8_000 as never, () => calls.push("replacement"));
  timer.fireStale(0);
  expect(calls).toEqual([]);
  clock.nowValue = 8_000;
  timer.fireCurrent();
  expect(calls).toEqual(["replacement"]);
});
```

- [ ] **Step 2: Run focused test and observe missing registry failure**

Run: `pnpm exec vitest run packages/core/test/run-retry-registry.test.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement registry lifecycle and background error containment**

Use the same timer discipline as `RunDeadlineRegistry`, but keep retry registrations in a separate map and never hold a `RunExecutionScope` during a waiting interval.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/core/test/run-retry-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run-retry-registry.ts packages/core/src/run-controller-ports.ts packages/core/src/index.ts packages/core/test/run-retry-registry.test.ts
git commit -m "feat(core): add durable retry wake registry"
```

### Task 6: Integrate failed-provider interception and atomic retry scheduling

**Files:**
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Modify: `packages/core/src/index.ts`
- Tests: `packages/storage/test/run-controller-retry.test.ts`

**Interfaces:**
- `RunControllerDependencies` accepts optional `retryPolicy` and `retryRegistry`; defaults are Core-owned.
- `RunController` adds `dispose()` and private `resumeRetryLocked()`/`scheduleRetry()` paths; no public retry endpoint.
- `RunControllerResult` adds `WAITING_RETRY` with `run`, `state`, `nextAttemptAt`, `attempt`, `maxAttempts`, and safe `errorCode`.

- [ ] **Step 1: Add failing storage/controller tests for initial transient retry**

```ts
it("settles a transient provider Step and atomically persists WAITING_RETRY", async () => {
  const first = await controller.start(run.id);
  expect(first.status).toBe("WAITING_RETRY");
  const checkpoint = await storage.continuations.get(run.id);
  expect(checkpoint?.checkpoint).toMatchObject({
    type: "WAITING_RETRY",
    attempt: 2,
    errorCode: "LLM_NETWORK",
  });
  expect((await storage.steps.listByRun(run.id))[0]?.status).toBe("FAILED");
  expect((await execution.load(run.id))?.state?.usage.steps).toBe(1);
});
```

- [ ] **Step 2: Run focused test and observe no retry boundary**

Run: `pnpm exec vitest run packages/storage/test/run-controller-retry.test.ts`

Expected: FAIL because transient failures currently go directly to `FAILED`.

- [ ] **Step 3: Implement the atomic transient-failure branch**

In `settle`, use only the failure result's safe retry metadata and the pure controller. For `RETRY`, commit `RUNNING` Run/State, failed Step, `WAITING_RETRY`, `llm.failed`, and `retry.scheduled` together; append no failure partial messages and notify before arming the registry. For `ATTEMPTS_EXHAUSTED` and non-retryable errors, preserve the existing final failure path and add safe `llm.failed` only for provider attempts.

- [ ] **Step 4: Run focused test and verify pass**

Run: `pnpm exec vitest run packages/storage/test/run-controller-retry.test.ts`

Expected: PASS with one failed Step, one usage increment, Run still RUNNING, and one retry continuation.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test packages/storage/test/run-controller-retry.test.ts
git commit -m "feat(core): persist retry continuation and scheduling"
```

### Task 7: Implement retry wake, new Step semantics, and provider-turn context preservation

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-events.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Tests: `packages/storage/test/run-controller-retry.test.ts`, `packages/storage/test/run-controller-retry-e2e.test.ts`

**Interfaces:**
- Wake path reloads first, rechecks terminal/cancellation/deadline/maxSteps, and calls `executeLoop(snapshot, false|true)` based on retry continuation mode.
- `beforeProviderTurn` clears `WAITING_RETRY`, inserts the new Step, emits `retry.started` then `llm.started` in one commit.

- [ ] **Step 1: Add failing wake/context/no-replay tests**

```ts
it("retries after Tool Results without redispatching the completed Tool", async () => {
  const waitingTool = await controller.start(run.id);
  const waitingRetry = await controller.submitToolResults(run.id, toolResults);
  expect(waitingRetry.status).toBe("WAITING_RETRY");
  await retryTimer.fireWhenReady();
  expect(toolHandlerCalls).toBe(1);
  expect(providerCalls).toBe(2);
});

it("uses a new StepId for a retry", async () => {
  expect(stepIds).toHaveLength(2);
  expect(stepIds[0]).not.toBe(stepIds[1]);
});
```

- [ ] **Step 2: Run focused tests and observe missing wake behavior**

Run: `pnpm exec vitest run packages/storage/test/run-controller-retry.test.ts packages/storage/test/run-controller-retry-e2e.test.ts`

Expected: FAIL because timer wake and retry context are not connected.

- [ ] **Step 3: Implement wake path and exact provider-only replay**

For `START`, call `AgentLoop.run`; for `TOOL_RESULTS`, call `resumeWithToolResults` with the continuation's original pending decision/results. Never call the Tool coordinator from a retry branch. Keep the existing security/approval path for any new Tool decision after a successful retry.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/storage/test/run-controller-retry.test.ts packages/storage/test/run-controller-retry-e2e.test.ts`

Expected: PASS with one Tool invocation, two Provider calls, two Steps, and no duplicate user/Tool messages.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run-controller.ts packages/core/src/run-controller-events.ts packages/core/src/run-execution-state.ts packages/storage/test/run-controller-retry.test.ts packages/storage/test/run-controller-retry-e2e.test.ts
git commit -m "feat(core): recover durable provider retries"
```

### Task 8: Add cancellation, deadline, maxSteps, exhaustion, and crash recovery coverage

**Files:**
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-input.ts`
- Modify: `packages/core/src/run-execution-state.ts`
- Tests: `packages/storage/test/run-controller-retry.test.ts`, `packages/storage/test/run-controller-retry-recovery.test.ts`, `packages/core/test/run-execution-state.test.ts`

**Interfaces:**
- Recovery order is terminal → cancellation intent → expired deadline → WAITING_RETRY → stale Step/approval/tool boundary.
- Before `nextAttemptAt`, `recover()` re-arms original remaining delay and makes zero provider calls; at/after it starts exactly one attempt.
- Cancellation and timeout disarm retry; if backoff would reach/past deadline, settle the failed Step as RUNNING boundary and let the existing deadline authority produce TIMEOUT.

- [ ] **Step 1: Add failing race and crash tests**

```ts
it("cancellation during WAITING_RETRY wins and makes zero retry calls", async () => {
  expect((await controller.cancel(run.id)).status).toBe("CANCELLED");
  await retryTimer.fireAll();
  expect(providerCalls).toBe(1);
});

it("recovery before nextAttemptAt preserves the original timestamp", async () => {
  await closeAndReopenControllerBefore(nextAttemptAt);
  expect(providerCalls).toBe(1);
  expect(timer.delayFor(run.id)).toBe(nextAttemptAt - clock.now());
});
```

- [ ] **Step 2: Run focused tests and observe failures**

Run: `pnpm exec vitest run packages/storage/test/run-controller-retry.test.ts packages/storage/test/run-controller-retry-recovery.test.ts packages/core/test/run-execution-state.test.ts`

Expected: FAIL until recovery priority and authority cleanup are implemented.

- [ ] **Step 3: Implement priority/disarm/recovery behavior without changing RunStatus**

Disarm on cancellation, timeout, terminal settlement, and dispose. Do not add `RETRY` or `RETRYING` statuses. Reuse `finalizeCancellation` and `finalizeTimeout`; never turn timeout into failed/exhausted retry.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/storage/test/run-controller-retry.test.ts packages/storage/test/run-controller-retry-recovery.test.ts packages/core/test/run-execution-state.test.ts`

Expected: PASS for cancel, timeout, maxSteps, exhaustion, stale timer, and recovery-before/after timestamp cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/run-execution-state.test.ts packages/storage/test/run-controller-retry*.test.ts
git commit -m "test(core): cover retry cancellation timeout and recovery"
```

### Task 9: Add observability, architecture guards, and LLM regression coverage

**Files:**
- Modify: `packages/protocol/test/event.test.ts`
- Modify: `packages/llm/test/errors.test.ts`
- Create or modify: `packages/core/test/architecture.test.ts`, `packages/storage/test/run-controller-retry-e2e.test.ts`
- Modify: `packages/core/src/run-controller-events.ts`

**Interfaces:**
- Verify durable trace ordering `llm.started → llm.failed → retry.scheduled → retry.started → llm.started → llm.completed` where applicable.
- Verify no raw provider error, stack, prompt, partial completion, Tool args, or secret enters retry events/errors.

- [ ] **Step 1: Add failing event/partial-stream/static-boundary tests**

```ts
it("discards partial provider output before retry", async () => {
  const result = await runWithProviderEvents(["partial", "NETWORK"], ["complete"]);
  expect(conversationText(result.runId)).not.toContain("partial");
  expect(conversationText(result.runId)).toContain("complete");
});

it("does not import concrete retry/provider/runtime implementation into RetryController", () => {
  expect(source("packages/core/src/retry-controller.ts")).not.toMatch(/from ["']@caelush\/(runtime|tools)/);
});
```

- [ ] **Step 2: Run focused tests and observe missing observability/guards**

Run: `pnpm exec vitest run packages/protocol/test/event.test.ts packages/llm/test/errors.test.ts packages/core/test/architecture.test.ts packages/storage/test/run-controller-retry-e2e.test.ts`

Expected: FAIL until event order and partial-output protections are complete.

- [ ] **Step 3: Implement only safe event projections and architecture assertions**

Keep `llm.failed` limited to safe AgentError data and retry events limited to bounded metadata. Do not add a provider-specific retry controller or Tool retry hook.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm exec vitest run packages/protocol/test/event.test.ts packages/llm/test/errors.test.ts packages/core/test/architecture.test.ts packages/storage/test/run-controller-retry-e2e.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/llm packages/core packages/storage
git commit -m "test: prove provider retry never replays tools"
```

### Task 10: Document Phase 10C and update durable architecture rules

**Files:**
- Create: `docs/architecture/retry.md`
- Modify: `docs/architecture/timeout.md`
- Modify: `docs/architecture/cancellation.md`
- Modify: `docs/architecture/agent-loop.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Documentation explains retry scope, classification, policy, backoff/jitter/Retry-After, Step and LLMCall identity, conversation integrity, continuation, registry, persist-before-arm, cancellation/deadline/maxSteps interactions, crash recovery, events, and no side-effect replay.

- [ ] **Step 1: Write the documentation with the two required diagrams**

Include the LLM failure decision flow and the Tool-side-effect/provider-failure separation; state that Phase 10D budgets and Verification remain unimplemented.

- [ ] **Step 2: Run documentation architecture checks**

Run: `rg -n "WAITING_RETRY|retry\.scheduled|retry\.started|Tool retry|Phase 10D" docs/architecture/retry.md README.md AGENTS.md`

Expected: all required terms are present and no claim says all failures or Tools are retried.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/retry.md docs/architecture/timeout.md docs/architecture/cancellation.md docs/architecture/agent-loop.md README.md AGENTS.md
git commit -m "docs: document phase 10c retry architecture"
```

### Task 11: Run full regressions, clean verification, and final audit

**Files:**
- No planned source changes; only test/build artifacts may be removed through the approved Node filesystem cleanup.

- [ ] **Step 1: Run the focused retry suite**

Run: `pnpm exec vitest run packages/core/test/retry-controller.test.ts packages/core/test/run-retry-registry.test.ts packages/storage/test/run-controller-retry*.test.ts packages/protocol/test/event.test.ts packages/llm/test/errors.test.ts`

Expected: PASS with no retry-specific failures.

- [ ] **Step 2: Run strict full verification serially**

Run each separately and require exit 0: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

- [ ] **Step 3: Perform the clean verification requested by the specification**

Use a Node filesystem script to remove only `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` under this worktree, never `git clean`; then run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` serially.

- [ ] **Step 4: Evaluate formatting without rewriting the repository**

Run `pnpm format:check` and `pnpm check`; confirm changed Phase 10C files introduce zero new warnings and total warnings do not exceed `PHASE_10C_FORMAT_BASELINE=599`. Do not run `prettier --write .`.

- [ ] **Step 5: Run final architecture/scope/VCS audit**

```bash
git diff --check
git status --short
git log --oneline --decorate -20
```

Confirm no budget/Verification/Tool retry leakage, no `RETRY` RunStatus or `RETRYING` AgentState, no raw provider data, no reused StepId/LLMCallId, and no uncommitted files.

- [ ] **Step 6: Commit any final test-only corrections, then report actual status**

Only commit if a verified, in-scope correction was required. Report baseline flake/format debt honestly and do not claim completion until all required evidence is fresh.

