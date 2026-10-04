# Provider Stream Recovery and Observable Waiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. For each behavior change, use `superpowers:test-driven-development`; before claiming completion, use `superpowers:verification-before-completion`. Do not use subagents unless the user explicitly authorizes delegation.

**Goal:** Eliminate indefinite Provider-stream hangs, recover transient model failures through exactly five retries, persist restart-safe recovery state, and show accurate waiting/retry/connection state without exposing hidden chain-of-thought.

**Architecture:** `@caelush/ai` detects one-attempt stream inactivity and cancels the real transport; `@caelush/agent` projects safe transient status; Core remains the sole retry/fallback/durable recovery authority; Storage commits retry truth and events atomically; Daemon owns composition, shutdown and public projection; Client/Web own bounded presentation only.

**Tech Stack:** TypeScript strict ESM, Node.js, pnpm workspaces, Vitest, Zod Protocol schemas, Fastify/SSE, React without JSX in the current component style, SQLite durable repositories.

**Spec:** [`provider-stream-recovery-spec.md`](./provider-stream-recovery-spec.md)

## Global Constraints

- Preserve all unrelated working-tree changes. Before editing any listed file, run `git diff -- <file>` and merge deliberately with user work.
- Do not edit `node_modules`, upgrade pinned AI SDKs, add adapter-local retry, add a second Event writer, or add UI-owned execution state.
- The production meaning is fixed: `maxAttempts = 6` means one initial attempt plus five retries. UI uses `retryOrdinal = attempt - 1` and displays `1/5` through `5/5`.
- Defaults are fixed: nudge 30s, idle timeout 300s, teardown grace 5s, backoff 1/2/4/8/16s before jitter, ±10% jitter, Provider Retry-After cap 300s.
- Each red step must be observed failing for the intended assertion before production code is changed. Run only the named test first; expand after green.
- Durable events must be written in the authoritative Run transaction and notified only post-commit.
- New transient status is coalescible and lossy by design; no transient event may become conversation history.
- Do not implement automatic cross-provider or cross-model fallback.
- Temporary notes and outputs remain outside the repository.

## Review Focus

Review every task against four hazards:

1. **Leaked transport:** timeout settles the caller but fetch/iterator remains alive.
2. **Duplicate authority:** retry/fallback appears in adapter, Agent, Web, or a standalone Event writer.
3. **Unsafe replay:** restart silently resends an in-flight Tool or non-idempotent Provider request.
4. **False health claim:** UI equates no tokens with a broken browser or Provider connection.

---

## Task 0: Freeze characterization and terminology

**Files:**

- Modify: `packages/ai/test/gateway-runtime.test.ts`
- Modify: `packages/core/test/retry-controller.test.ts`
- Modify: `apps/daemon/test/run-startup-reconciliation-restart.test.ts`
- Modify: `apps/web/test/turn-presentation-feed.test.tsx`

### Step 1: Add characterization assertions only

- In `gateway-runtime.test.ts`, add a skipped/todo-described scenario for an adapter whose `next()` never settles, documenting that current behavior never emits a terminal event.
- In `retry-controller.test.ts`, assert the current default is 3 attempts and label it as the behavior this change intentionally replaces.
- In restart tests, identify the existing `WAITING_RETRY` automatic recovery case and the stale in-flight fail-closed case; do not weaken either.
- In Web tests, capture the existing distinction between `ReconnectBanner` and model waiting text.

Do not commit a permanently skipped test. This task is a local baseline checkpoint; the next tasks replace the temporary characterization with executable tests.

### Step 2: Run the baseline

```powershell
pnpm exec vitest run packages/ai/test/gateway-runtime.test.ts packages/core/test/retry-controller.test.ts apps/daemon/test/run-startup-reconciliation-restart.test.ts apps/web/test/turn-presentation-feed.test.tsx
```

Expected: existing assertions pass; the documented hang scenario is not yet executable as a passing test.

### Step 3: Inspect local changes

```powershell
git diff --check
git diff -- packages/ai/test/gateway-runtime.test.ts packages/core/test/retry-controller.test.ts apps/daemon/test/run-startup-reconciliation-restart.test.ts apps/web/test/turn-presentation-feed.test.tsx
```

---

## Task 1: Centralize standards-compliant Retry-After parsing

**Files:**

- Create: `packages/ai/src/errors/retry-after.ts`
- Modify: `packages/ai/src/errors/index.ts`
- Modify: `packages/ai/src/adapters/openai-compatible/error-normalizer.ts`
- Modify: `packages/ai/src/adapters/anthropic-messages/error-normalizer.ts`
- Create: `packages/ai/test/retry-after.test.ts`
- Modify: `packages/ai/test/adapters/openai-compatible/error-normalizer.test.ts`
- Modify: `packages/ai/test/adapters/anthropic-messages/error-normalizer.test.ts`

### Step 1: Write failing parser tests

Create table-driven tests for:

- `"2" -> 2000`, `"0.5" -> 500`, `"0" -> 0`.
- case-insensitive header lookup remains in each adapter.
- HTTP-date later than injected `nowMs` produces the exact delta.
- HTTP-date in the past produces `0`.
- blank, negative, `NaN`, invalid date, infinity and unsafe integer produce `undefined`.

Proposed public package-internal signature:

```ts
export function parseRetryAfterMs(
  raw: string | undefined,
  nowMs: number,
): number | undefined;
```

The adapter normalizers receive an optional clock argument for deterministic tests:

```ts
normalizeOpenAICompatibleError(error, model, (nowMs = Date.now()));
normalizeAnthropicHttpError(failure, model, (nowMs = Date.now()));
```

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/ai/test/retry-after.test.ts packages/ai/test/adapters/openai-compatible/error-normalizer.test.ts packages/ai/test/adapters/anthropic-messages/error-normalizer.test.ts
```

Expected: new HTTP-date/zero-delay tests fail because both adapters currently parse delta-seconds privately.

### Step 3: Implement the smallest shared parser

- Parse numeric form before date form.
- Validate `nowMs` as a nonnegative safe integer inside tests/caller contract; never let an invalid clock fabricate a hint.
- Delete both duplicate private `readRetryAfterMs()` functions.
- Preserve sanitized error messages and existing code classification.

### Step 4: Prove green and run AI typecheck

```powershell
pnpm exec vitest run packages/ai/test/retry-after.test.ts packages/ai/test/adapters/openai-compatible/error-normalizer.test.ts packages/ai/test/adapters/anthropic-messages/error-normalizer.test.ts
pnpm --filter @caelush/ai typecheck
```

### Step 5: Suggested checkpoint

Suggested commit title if commits are requested: `fix(ai): parse Retry-After dates consistently`.

---

## Task 2: Add first-cause-wins idle cancellation to the AI abort scope

**Files:**

- Modify: `packages/ai/src/stream/abort-scope.ts`
- Create: `packages/ai/test/abort-scope.test.ts`

### Step 1: Write failing abort-scope tests

Test that:

- the new `idle_timeout` kind aborts the same stable signal observed by the adapter;
- external, total-timeout, idle-timeout and consumer cancellation are first-cause-wins;
- `cleanup()` detaches timers/listeners;
- triggering idle after cleanup does nothing;
- no timeout can be constructed with zero, negative, non-integer or infinity.

Target contract:

```ts
export type AIAbortKind = "external" | "timeout" | "idle_timeout" | "consumer";

interface AbortScope {
  readonly signal: AbortSignal;
  readonly aborted: Promise<AIAbortKind>;
  kind(): AIAbortKind | undefined;
  abortIdle(): void;
  abortConsumer(): void;
  cleanup(): void;
}
```

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/ai/test/abort-scope.test.ts
```

### Step 3: Implement idle abort without replacing the signal

Add an internal symbol reason and `abortIdle()`. Do not layer a second controller after preflight: credential resolution and adapter streaming must continue observing one invocation signal.

### Step 4: Prove green

```powershell
pnpm exec vitest run packages/ai/test/abort-scope.test.ts packages/ai/test/gateway-preflight.test.ts
```

---

## Task 3: Implement per-next Provider idle watchdog and bounded teardown

**Files:**

- Create: `packages/ai/src/stream/idle-watchdog.ts`
- Modify: `packages/ai/src/stream/index.ts`
- Modify: `packages/ai/src/stream/stream.ts`
- Modify: `packages/ai/src/stream/events.ts`
- Modify: `packages/ai/src/stream/stream-validator.ts`
- Modify: `packages/ai/src/stream/turn-assembler.ts`
- Modify: `packages/ai/src/gateway/gateway-request-resolver.ts`
- Modify: `packages/ai/src/gateway/ai-gateway.ts`
- Modify: `packages/ai/src/create-ai-subsystem.ts`
- Modify: `packages/ai/test/gateway-runtime.test.ts`
- Modify: `packages/ai/test/gateway-preflight.test.ts`
- Modify: `packages/ai/test/support/fake-adapter.ts`

### Step 1: Replace the hang characterization with failing fake-timer tests

Add tests for all of these sequences:

1. `stream.start -> stream.status(WAITING_PROVIDER)` immediately.
2. A never-settling `next()` produces `NO_RECENT_ACTIVITY` at 30s.
3. The same call aborts the adapter signal at 300s and produces one terminal `stream.error(AI_TIMEOUT)`.
4. Every adapter event resets both nudge and idle clocks.
5. Total invocation timeout can win before idle timeout and remains `AI_TIMEOUT`.
6. External abort remains `AI_ABORTED` and is not retried by this layer.
7. If iterator `return()` never settles, Gateway finishes teardown after 5s.
8. A delta that resolves after the terminal fence is ignored.
9. `stream.status` is accepted and ignored by the result assembler.

Use Vitest fake timers and explicitly flush microtasks; never make this suite wait real minutes.

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/ai/test/gateway-runtime.test.ts packages/ai/test/gateway-preflight.test.ts
```

### Step 3: Add validated options and defaults

Extend:

```ts
interface AIStreamOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  nudgeAfterMs?: number;
  idleTimeoutMs?: number;
  teardownGraceMs?: number;
}

interface AIGatewayOptions {
  reasoningPolicy?: ReasoningResolutionPolicy;
  defaultTimeoutMs?: number;
  defaultNudgeAfterMs?: number;
  defaultIdleTimeoutMs?: number;
  defaultTeardownGraceMs?: number;
  clock?: { now(): number };
}
```

The resolver validates and freezes the effective values into `ResolvedGatewayRequest`; do not let adapters see policy fields other than the stable signal.

### Step 4: Implement `idle-watchdog.ts`

The helper owns exactly one pending `next()` generation and two timers. It should expose status changes through an async-safe queue or callback consumed by the Gateway generator. Requirements:

- reset only when a real adapter event arrives;
- emit nudge once per silent interval;
- call `scope.abortIdle()` at idle timeout;
- race the in-flight `next()` with `scope.aborted`, but always cancel the transport through the signal;
- retain a closed/generation token so late promises cannot yield events or unhandled rejections;
- bound iterator `return()` with teardown grace and swallow only teardown errors after the primary outcome is fixed.

### Step 5: Map idle abort correctly

Update `normalizeRuntimeError()` in `ai-gateway.ts` so both total timeout and idle timeout become the sanitized `AI_TIMEOUT`; external/consumer abort remain `AI_ABORTED`. Ensure only one terminal event.

### Step 6: Prove green and run adapter suites

```powershell
pnpm exec vitest run packages/ai/test/gateway-runtime.test.ts packages/ai/test/gateway-preflight.test.ts packages/ai/test/adapters/conformance/openai-compatible-conformance.test.ts packages/ai/test/adapters/anthropic-messages/anthropic-messages-conformance.test.ts
pnpm --filter @caelush/ai typecheck
```

---

## Task 4: Prove real adapter cancellation rather than Promise-only timeout

**Files:**

- Modify: `packages/ai/test/adapters/conformance/types.ts`
- Modify: `packages/ai/test/adapters/conformance/adapter-conformance.ts`
- Modify: `packages/ai/test/adapters/openai-compatible/adapter-stream-golden.test.ts`
- Modify: `packages/ai/test/adapters/anthropic-messages/adapter-stream-golden.test.ts`
- Modify only if tests expose a defect: `packages/ai/src/adapters/openai-compatible/adapter.ts`
- Modify only if tests expose a defect: `packages/ai/src/adapters/anthropic-messages/adapter.ts`

### Step 1: Add failing conformance cases

- Capture the signal received by the transport before it begins waiting.
- Abort it while the response body/read iterator is pending.
- Assert fetch/SDK stream and adapter iterator settle, the reader is cancelled where applicable, and no later adapter event is emitted.
- Assert OpenAI-compatible request configuration keeps `maxRetries: 0`.

### Step 2: Prove red or document already-green behavior

```powershell
pnpm exec vitest run packages/ai/test/adapters/conformance/openai-compatible-conformance.test.ts packages/ai/test/adapters/anthropic-messages/anthropic-messages-conformance.test.ts packages/ai/test/adapters/openai-compatible/adapter-stream-golden.test.ts packages/ai/test/adapters/anthropic-messages/adapter-stream-golden.test.ts
```

If the new tests are immediately green, do not churn production adapters. Record that the existing signal forwarding satisfies the new watchdog contract.

### Step 3: Apply only necessary cancellation fixes and rerun

No adapter may catch an abort and relabel it as an ordinary network failure when `signal.aborted` is true.

---

## Task 5: Project safe model status into Event V2

**Files:**

- Modify: `packages/protocol/src/events/model.ts`
- Modify: `packages/protocol/src/events/catalog.ts`
- Modify: `packages/protocol/src/events/registry.ts`
- Modify: `packages/protocol/src/events/public.ts`
- Modify: `packages/protocol/src/events/index.ts`
- Modify: `packages/protocol/test/phase-6e-transient-events.test.ts`
- Modify: `packages/protocol/test/event.test.ts`
- Modify: `packages/protocol/test/public-event.test.ts`
- Modify: `packages/agent/src/events/model-stream-signal-projector.ts`
- Modify: `packages/agent/src/loop/turn/model-turn-executor.ts`
- Modify: `packages/agent/test/phase-6e-model-stream-projector.test.ts`
- Modify: `packages/agent/test/model-turn-executor.test.ts`
- Modify: `apps/daemon/src/events/public-event-projector.ts`
- Modify: `apps/daemon/test/public-event-projector.test.ts`
- Modify: `apps/daemon/test/events-sse.test.ts`

### Step 1: Write failing Protocol schema/catalog tests

Define `model.status` as:

- schema version 1;
- `visibility: USER_VISIBLE`;
- `durability.kind: EPHEMERAL`;
- `deliveryClass: COALESCIBLE`;
- stream key exactly `model:status:<runId>:<stepId>`;
- strict bounded enum/numeric payload from the formal spec.

Reject credentials, endpoint, raw errors, arbitrary message strings and extra keys.

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/protocol/test/phase-6e-transient-events.test.ts packages/protocol/test/event.test.ts packages/protocol/test/public-event.test.ts
```

### Step 3: Implement Protocol contract and registry entries

Keep static catalog metadata authoritative. Do not add a new package or bus.

### Step 4: Write failing Agent projection tests

Assert AI `stream.status` becomes one correlated Protocol event with daemon-injected event id/timestamp, the fixed coalescible stream key, and no durable write. Assert ordinary deltas still keep ordered stream sequences.

### Step 5: Implement the projector path

Add `stream.status` handling to `createModelStreamSignalProjector()` and allow `emitCanonicalTransient()` to forward it. Keep the legacy sink limited to its old three delta types unless compatibility requirements prove otherwise.

### Step 6: Write and implement Daemon public projection/SSE tests

Assert the safe status survives public projection and appears on SSE without `id:` because ephemeral events never receive durable SSE ids.

### Step 7: Run the vertical slice

```powershell
pnpm exec vitest run packages/protocol/test/phase-6e-transient-events.test.ts packages/protocol/test/event.test.ts packages/protocol/test/public-event.test.ts packages/agent/test/phase-6e-model-stream-projector.test.ts packages/agent/test/model-turn-executor.test.ts apps/daemon/test/public-event-projector.test.ts apps/daemon/test/events-sse.test.ts
pnpm check:architecture:ci
```

---

## Task 6: Change Core to five retries with correct Retry-After policy

**Files:**

- Modify: `packages/core/src/retry-policy.ts`
- Modify: `packages/core/src/retry-controller.ts`
- Modify: `packages/core/test/retry-controller.test.ts`
- Modify: `packages/core/test/run-controller-start.test.ts`
- Modify: `packages/core/test/run-retry-registry.test.ts`

### Step 1: Write failing policy tests

Assert:

- `DEFAULT_RETRY_POLICY.maxAttempts === 6`;
- base/max/jitter/provider cap equal `1000/30000/0.10/300000`;
- attempts 1–5 schedule attempts 2–6; attempt 6 stops;
- deterministic jitter samples `0`, `0.5`, and just below `1` produce -10%, 0%, +10% bounds;
- Provider Retry-After bypasses jitter and may exceed local `maxDelayMs` up to 300s;
- Retry-After above 300s returns `RETRY_AFTER_EXCEEDS_POLICY`;
- Retry-After zero creates a durable zero-delay schedule decision;
- a delay that reaches/exceeds deadline stops;
- cancellation and limits retain precedence.

Update `RetryPolicy` with `maxProviderRetryAfterMs`. Change scheduled event delay validation to nonnegative in Task 7 so zero is representable.

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/core/test/retry-controller.test.ts
```

### Step 3: Implement decision order exactly as specified

Do not clamp an excessive Provider delay to the local max and do not silently fall back to an earlier exponential delay. Keep random sampling injected; never use hidden `Math.random()` in tests.

### Step 4: Add RunController attempt-count tests

Use a fake model executor that fails six times. Assert five `WAITING_RETRY` checkpoints/schedules and terminal failure only after the sixth attempt. Verify each retry creates exactly one new Step and no failed partial assistant message.

### Step 5: Prove green

```powershell
pnpm exec vitest run packages/core/test/retry-controller.test.ts packages/core/test/run-controller-start.test.ts packages/core/test/run-retry-registry.test.ts
```

---

## Task 7: Add durable retry exhaustion truth and retry ordinals

**Files:**

- Modify: `packages/protocol/src/events/llm.ts`
- Modify: `packages/protocol/src/events/catalog.ts`
- Modify: `packages/protocol/src/events/registry.ts`
- Modify: `packages/protocol/src/events/public.ts`
- Modify: `packages/protocol/src/events/index.ts`
- Modify: `packages/protocol/test/event.test.ts`
- Modify: `packages/protocol/test/public-event.test.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-commit-event-materializer.ts` if event drafts are centralized there
- Modify: `packages/core/test/run-commit-event-materializer.test.ts`
- Modify: `packages/core/test/run-controller-start.test.ts`
- Modify: `packages/storage/test/run-controller-failure.test.ts`

### Step 1: Write failing schema tests

Add strict `retry.exhausted` schema exactly as specified. Change `retry.scheduled.delayMs` from positive to nonnegative so a valid `Retry-After: 0` can still pass through the durable scheduler.

Add cross-field refinements:

- `attempt === maxAttempts === 6` for the default behavior is not hard-coded into the schema, but `retriesUsed === attempt - 1` and `maxRetries === maxAttempts - 1` must hold.
- ordinals remain within max 10 attempts.

### Step 2: Prove red and implement Protocol

```powershell
pnpm exec vitest run packages/protocol/test/event.test.ts packages/protocol/test/public-event.test.ts
```

### Step 3: Write failing atomicity tests

For attempts exhausted, deadline exceeded, max steps and excessive Retry-After:

- fail the authoritative Storage transaction and assert neither Run truth nor event commits;
- succeed and assert failed Step, `llm.failed`, `retry.exhausted`, Run terminal transition and notifier order are one authoritative transaction followed by notification;
- assert NOT_RETRYABLE does not emit `retry.exhausted`.

### Step 4: Implement materialization in the existing transaction

Do not append durable events through `RunEventHub`. Reuse the existing Run/Step commit path.

### Step 5: Prove green

```powershell
pnpm exec vitest run packages/core/test/run-commit-event-materializer.test.ts packages/core/test/run-controller-start.test.ts
pnpm check:architecture:ci
```

---

## Task 8: Persist same-provider/same-model transport fallback

**Files:**

- Modify: `packages/ai/src/providers/provider-binding.ts`
- Modify: `packages/ai/src/providers/resolved-provider-connection.ts`
- Modify: `packages/ai/src/gateway/gateway-request-resolver.ts`
- Modify: `packages/ai/test/providers.test.ts`
- Modify: `packages/ai/test/gateway-preflight.test.ts`
- Create: `packages/core/src/model-transport-recovery-port.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/agent-continuation.ts`
- Modify: `packages/core/src/agent-continuation-schema.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/test/agent-continuation.test.ts`
- Modify: `packages/core/test/run-controller-start.test.ts`
- Modify: `packages/protocol/src/events/llm.ts` or create `packages/protocol/src/events/transport.ts`
- Modify: Protocol catalog/registry/public/index files
- Modify: `apps/daemon/src/daemon-composition.ts`
- Modify: `apps/daemon/src/providers/provider-presets.ts` only after merging the user's current edits
- Create: `apps/daemon/src/providers/model-transport-recovery.ts`
- Create: `apps/daemon/test/model-transport-recovery.test.ts`
- Modify: `apps/daemon/test/daemon-composition.test.ts`

### Step 1: Write failing AI binding tests

Replace the single opaque `transport` selection with explicit candidates while retaining source compatibility for one transport:

```ts
interface AIProviderTransportCandidate {
  readonly id: string;
  readonly endpoint: string;
  readonly api: ApiId;
  readonly compatibility?: JsonObject;
  readonly transport?: AIProviderTransportOverride;
  readonly rateLimitDomain?: string;
}

interface AIStreamOptions {
  // existing fields
  readonly transportId?: string;
}
```

Validate unique bounded ids, absolute HTTP(S) endpoints, and matching provider/model policy. Resolver must reject unknown transport ids before Provider I/O. The default candidate must preserve current behavior.

### Step 2: Prove red and implement one-attempt selection

```powershell
pnpm exec vitest run packages/ai/test/gateway-preflight.test.ts packages/ai/test/providers.test.ts
```

AI still performs exactly one selected attempt and knows nothing about fallback order.

### Step 3: Write failing Core continuation/selection tests

Add optional `transport` recovery data to `WAITING_RETRY`:

```ts
{
  currentTransportId: string;
  attemptedTransportIds: readonly string[];
}
```

Test backward decoding of old checkpoints with the field absent. Test that:

- NETWORK/TIMEOUT can select the next equivalent candidate;
- RATE_LIMIT changes candidate only when rate-limit domains differ and policy permits;
- no candidate means retry same transport;
- provider/model identity can never change;
- selection is persisted before new Provider I/O and survives restart.

### Step 4: Add `transport.fallback.selected` schema and atomic event tests

Payload contains bounded safe ids, attempt/maxAttempts and from/to only. No endpoints, headers or credentials.

### Step 5: Implement Daemon adapter over provider bindings

The Daemon port maps configured candidates into Core's generic port. Production presets must expose only real configured candidates; do not invent a second URL. Use fake dual transports only in tests.

### Step 6: Thread selection to the one-turn executor

Add an optional transport selection to the Run-owned execution input/port, then forward only `transportId` through `ModelTurnExecutionInput` to `gateway.stream()`. Update these likely files after confirming the smallest path with `rg -n "ModelTurnExecutionInput"`:

- `packages/agent/src/loop/turn/model-turn-executor.ts`
- `packages/core/src/run-agent-execution.ts`
- `packages/core/src/legacy-model-turn-executor.ts`
- `packages/core/src/run-model-turn-boundary.ts`

Do not put Provider endpoint or credentials in Agent contracts.

### Step 7: Run the vertical slice

```powershell
pnpm exec vitest run packages/ai/test/gateway-preflight.test.ts packages/core/test/agent-continuation.test.ts packages/core/test/run-controller-start.test.ts apps/daemon/test/model-transport-recovery.test.ts apps/daemon/test/daemon-composition.test.ts
pnpm check:architecture:ci
```

---

## Task 9: Make managed Daemon shutdown checkpoint active model attempts

**Files:**

- Modify: `packages/core/src/run-controller.ts`
- Modify: `packages/core/src/run-controller-ports.ts`
- Create: `packages/core/src/run-shutdown.ts`
- Create: `packages/core/test/run-controller-managed-shutdown.test.ts`
- Modify: `apps/daemon/src/execution/run-execution-supervisor.ts`
- Modify: `apps/daemon/src/daemon-composition.ts`
- Modify: `apps/daemon/src/daemon.ts`
- Modify: `apps/daemon/test/shutdown.test.ts`
- Modify: `apps/daemon/test/daemon-control-e2e.test.ts`
- Modify: `apps/daemon/test/run-startup-reconciliation-restart.test.ts`

### Step 1: Define a structured stop reason and write failing Core tests

Use an internal typed reason, not string matching:

```ts
type RunExecutionStopReason =
  "USER_CANCELLED" | "MANAGED_RESTART" | "RUN_DEADLINE";
```

Tests must prove:

- user cancel remains terminal cancellation and never schedules retry;
- run deadline remains timeout policy;
- managed restart during an active model Step aborts the Gateway, commits that attempt as failed/recoverable, and creates `WAITING_RETRY` before returning checkpointed;
- managed restart during a Tool does not replay or fabricate success;
- transaction failure prevents shutdown from claiming checkpoint success.

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/core/test/run-controller-managed-shutdown.test.ts
```

### Step 3: Implement a bounded Core checkpoint API

Add a controller method such as:

```ts
prepareForShutdown(runId: RunId): Promise<"CHECKPOINTED" | "ALREADY_SAFE" | "UNSAFE_IN_FLIGHT">;
```

It must reuse the canonical Run transition and retry transaction logic; it may not manually write Run rows or events from Daemon.

### Step 4: Write failing Supervisor tests

Add `beginDrain()` to reject new start/recover/approval/continue scheduling while allowing cancel/checkpoint operations. Snapshot active run ids, request checkpoint once per run, and bound drain. Prove concurrent close is idempotent.

### Step 5: Implement Daemon close order

Refactor `startDaemon().close()` to:

1. abort public active SSE controllers only when appropriate after checkpoint notification;
2. begin supervisor drain;
3. checkpoint active executions;
4. close Fastify intake;
5. await bounded composition dispose;
6. close Storage last.

Use an injected shutdown deadline in tests; production default must be bounded. Do not simply `Promise.race()` and abandon active writes—after deadline, fence execution from using closed Storage.

### Step 6: Prove restart recovery

E2E sequence:

1. first Daemon starts a Run against a hanging fake Provider;
2. close is invoked;
3. inspect SQLite and assert `WAITING_RETRY` plus durable schedule exists;
4. second Daemon starts on the same database;
5. startup reconciliation resumes exactly one next attempt;
6. no old SSE/iterator is reused and no duplicate Step appears.

### Step 7: Run targeted tests

```powershell
pnpm exec vitest run packages/core/test/run-controller-managed-shutdown.test.ts apps/daemon/test/shutdown.test.ts apps/daemon/test/daemon-control-e2e.test.ts apps/daemon/test/run-startup-reconciliation-restart.test.ts
```

---

## Task 10: Keep hard-crash recovery fail closed unless idempotency is proven

**Files:**

- Modify: `packages/ai/src/providers/provider-binding.ts`
- Modify: `packages/core/src/agent-continuation.ts` only if an idempotency key must be checkpointed before I/O
- Modify: `packages/core/src/run-controller.ts`
- Modify: `apps/daemon/src/execution/run-startup-reconciliation.ts`
- Modify: `apps/daemon/test/run-startup-reconciliation.test.ts`
- Modify: `apps/daemon/test/run-startup-reconciliation-restart.test.ts`

### Step 1: Write failing recovery matrix tests

- stale `WAITING_RETRY` resumes as today;
- stale model RUNNING Step without an idempotency guarantee fails closed;
- stale Tool RUNNING remains fail closed under every configuration;
- only a provider candidate explicitly declaring a supported idempotency mechanism and carrying a previously persisted key may auto-retry an in-flight model attempt;
- capability declaration without a persisted key is insufficient;
- persisted key without provider capability is insufficient.

### Step 2: Prove red for the opt-in path while preserving existing green fail-closed tests

```powershell
pnpm exec vitest run apps/daemon/test/run-startup-reconciliation.test.ts apps/daemon/test/run-startup-reconciliation-restart.test.ts
```

### Step 3: Implement minimal opt-in metadata

Do not enable idempotent replay for current production adapters unless the Provider API and SDK request path actually transmit and honor the key. If no currently supported transport proves this, implement only the fail-closed test and capability seam, leave every preset disabled, and expose explicit user continuation separately.

### Step 4: Prove green

Rerun the two startup suites plus `packages/core/test/run-controller-start.test.ts`.

---

## Task 11: Extend Client read models for model wait and recovery status

**Files:**

- Modify: `packages/client/src/live-activity.ts`
- Modify: `packages/client/src/timeline/model.ts`
- Modify: `packages/client/src/timeline/reducer.ts`
- Modify: `packages/client/src/timeline/presentation.ts`
- Modify: `packages/client/test/live-activity.test.ts`
- Modify: `packages/client/test/timeline-model.test.ts`
- Modify: `packages/client/test/timeline-reducer.test.ts`
- Modify: `packages/client/test/timeline-presentation.test.ts`

### Step 1: Write failing client reducer tests

Test:

- coalescible `model.status` replaces only the status for the same Run/Step;
- content delta updates last Provider activity without claiming transport health;
- `retry.scheduled` projects `retryOrdinal = attempt - 1`, `maxRetries = maxAttempts - 1`;
- default attempt 2/6 renders retry 1/5; attempt 6/6 renders 5/5;
- `retry.started`, fallback and exhausted events advance the phase deterministically;
- reconnect/replay deduplication does not resurrect a settled model status;
- terminal durable Run event settles transient wait status.

### Step 2: Prove red

```powershell
pnpm exec vitest run packages/client/test/live-activity.test.ts packages/client/test/timeline-model.test.ts packages/client/test/timeline-reducer.test.ts packages/client/test/timeline-presentation.test.ts
```

### Step 3: Implement bounded state

Either add `modelWait` to `LiveActivityState` or introduce a focused exported `ModelWaitState` reduced alongside it. Do not store a per-second elapsed counter; store timestamps and compute elapsed in Web. Keep browser SSE connection state out of this model.

### Step 4: Prove green

Run the same four suites and `pnpm --filter @caelush/client typecheck`.

---

## Task 12: Implement accurate Web waiting UX and text animation

**Files:**

- Modify: `apps/web/src/application/session-manager.ts`
- Modify: `apps/web/src/components/turn-presentation-feed.ts`
- Modify: `apps/web/src/components/timeline.ts`
- Modify: `apps/web/src/components/reconnect-banner.ts` only to clarify local-service wording if current copy is ambiguous
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/test/turn-presentation-feed.test.tsx`
- Modify: `apps/web/test/timeline.test.tsx`
- Modify: `apps/web/test/daemon-timeline-e2e.test.ts`
- Create: `apps/web/test/model-wait-presentation.test.tsx` if a focused component is extracted

**Conflict warning:** `turn-presentation-feed.ts`, `styles.css`, and its test already have user modifications. Inspect their diffs before every patch and preserve them.

### Step 1: Write failing rendering/accessibility tests

Use fake clock/timers to assert exact text:

- normal wait: `思考中` and `正在等待模型响应`;
- 30s silence: `模型近期没有返回新数据，仍在等待`;
- last activity wall-clock and elapsed duration;
- scheduled retry: `将在 … 后重新连接 1/5`;
- started retry: `正在重新连接 1/5`;
- fallback: identifies a transport switch without leaking endpoint;
- idle timeout: `Provider 连续 5 分钟没有返回数据，正在终止本次请求`;
- exhausted: explicit failure after five retries;
- local SSE disconnect copy remains independent of Provider silence;
- `role=status`/`aria-live=polite` for changing wait text and `role=alert` only for terminal actionable failure.

Assert there is no added loading dot element. Assert classes are applied to the text spans themselves.

### Step 2: Prove red

```powershell
pnpm exec vitest run apps/web/test/turn-presentation-feed.test.tsx apps/web/test/timeline.test.tsx apps/web/test/daemon-timeline-e2e.test.ts
```

### Step 3: Implement a single presentation function

Prefer a pure function/component such as `modelWaitPresentation(status, now)` so both the process feed and Timeline use identical ordinal and wording rules. SessionManager only reduces events; it must not infer execution state from wall-clock silence.

Use a one-second local display tick only while wait status is visible. Derive elapsed from `now - lastProviderActivityAt`; on tab resume it self-corrects.

### Step 4: Implement text-only loading animation

Add a class such as `.model-wait-text--loading` on the words themselves. Use background-position shimmer or opacity/translate pulse with restrained contrast. Do not add pseudo-element dots. Add:

```css
@media (prefers-reduced-motion: reduce) {
  .model-wait-text--loading {
    animation: none;
  }
}
```

Keep text readable without animation and avoid changing layout width during frames.

### Step 5: Prove green and build Web

```powershell
pnpm exec vitest run apps/web/test/turn-presentation-feed.test.tsx apps/web/test/timeline.test.tsx apps/web/test/daemon-timeline-e2e.test.ts
pnpm --filter @caelush/web typecheck
pnpm --filter @caelush/web build
```

---

## Task 13: End-to-end fault injection matrix

**Files:**

- Create: `apps/daemon/test/provider-stream-recovery-e2e.test.ts`
- Modify: `apps/daemon/test/support/...` only to add a reusable controllable Provider server; locate the closest existing fake Provider fixture first
- Modify: `apps/web/test/daemon-timeline-e2e.test.ts`

### Step 1: Build a controllable local Provider fixture

The fixture must support:

- headers then permanent body silence;
- one delta then silence;
- transient 429 with delta Retry-After;
- transient 429 with HTTP-date Retry-After;
- network reset;
- delayed successful attempt;
- primary transport failure and secondary success;
- response after cancellation to test late-event fencing;
- call count, timestamps, selected transport id and observed abort.

Never use an internet Provider in tests.

### Step 2: Write the failing matrix

Use short injected timeouts and deterministic jitter. Assert:

1. silence → nudge → idle cancellation → durable retry;
2. exactly five retries, never six retries;
3. actual request timestamps respect exponential/jitter bounds;
4. Retry-After is never violated;
5. secondary equivalent transport is selected only on a later durable attempt;
6. partial output from failed attempts is absent from Transcript;
7. partial Tool arguments never create ToolInvocation;
8. terminal exhausted failure appears through SSE and session presentation;
9. disconnecting the Web SSE client does not stop the Run;
10. daemon restart during backoff resumes once;
11. managed restart during hung model request checkpoints and resumes once;
12. hard-crash characterization remains fail closed without idempotency.

### Step 3: Prove red then implement only missing wiring

```powershell
pnpm exec vitest run apps/daemon/test/provider-stream-recovery-e2e.test.ts apps/web/test/daemon-timeline-e2e.test.ts
```

### Step 4: Prove green repeatedly

Run the fault suite at least three times to catch timer races:

```powershell
1..3 | ForEach-Object { pnpm exec vitest run apps/daemon/test/provider-stream-recovery-e2e.test.ts }
```

No test may depend on real-time multi-minute waits.

---

## Task 14: Documentation, configuration diagnostics and rollout guard

**Files:**

- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/diagnostics.ts`
- Modify: the existing user-facing configuration documentation discovered with `rg -n "retry|timeout|provider" README.md docs apps/daemon`
- Modify: relevant config/diagnostic tests

### Step 1: Write failing config tests

Assert production effective defaults are always positive and finite. Reject zero/infinite idle timeout. Log safe effective values at startup without endpoint credentials. Do not expose a flag that silently makes timeout infinite.

### Step 2: Implement and verify

Document:

- five retries versus six total attempts;
- 30s nudge and 5m idle timeout;
- Retry-After cap behavior;
- fallback eligibility;
- managed versus hard-crash recovery;
- connection-status semantics.

Run only the located focused config tests and Prettier for changed docs/source.

---

## Task 15: Final verification and handoff

### Step 1: Run targeted aggregate tests

```powershell
pnpm exec vitest run packages/ai/test/gateway-runtime.test.ts packages/ai/test/retry-after.test.ts packages/core/test/retry-controller.test.ts packages/core/test/run-controller-managed-shutdown.test.ts packages/client/test/live-activity.test.ts apps/daemon/test/provider-stream-recovery-e2e.test.ts apps/daemon/test/run-startup-reconciliation-restart.test.ts apps/web/test/turn-presentation-feed.test.tsx apps/web/test/daemon-timeline-e2e.test.ts
```

### Step 2: Run repository gates in this order

```powershell
pnpm check:architecture:ci
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm check
```

If `pnpm check` already subsumes earlier commands, still retain the individual outputs needed to identify which layer failed. Do not report success if any command is skipped or red.

### Step 3: Inspect all changes

```powershell
git status --short
git diff --check
git diff
```

Review specifically for:

- accidental edits to the user's pre-existing Web/provider preset changes;
- private cross-package imports;
- raw Provider errors or endpoints in public events;
- a second retry loop in adapter/Agent/Web;
- durable event writes outside authoritative transactions;
- `Promise.race()` paths that do not abort the real transport;
- UI copy that calls silence “unhealthy”;
- any retry display of `6/6` instead of `5/5`.

### Step 4: Manual acceptance

With a local controllable Provider, observe the Web page through normal wait, 30-second nudge, one retry and final success. Then run a shortened configured test profile to exhaustion and verify explicit failure. Confirm:

- the words animate, with no pulse dot;
- reduced-motion disables animation;
- last activity and elapsed wait remain accurate after backgrounding the tab;
- local-service reconnect and Provider wait are visually distinct;
- final answer and durable Timeline remain correct after reconnect.

### Step 5: Handoff evidence

Report exact commands and exit codes, the tested retry timestamp sequence, persisted continuation/event samples with sensitive fields absent, and any production fallback candidates intentionally left disabled because no equivalent transport exists.
