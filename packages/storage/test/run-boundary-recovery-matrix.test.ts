import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIModelRequest } from "@caelush/ai";
import {
  AgentRunSchema,
  createEventId,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type RunId,
  type StepId,
  type TimestampMs,
} from "@caelush/protocol";
import { RunController, RunRetryRegistry } from "@caelush/core";
import { EventBus } from "@caelush/events";
import { describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeState, makeStep, verificationPlanner } from "./support/fixtures.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { modelTurnResult } from "./support/model-turns.js";

/**
 * Phase 3F — the durable recovery boundaries, across a real storage reopen.
 *
 * ```text
 * close the SQLite database   →   open it again   →   build a *new* controller   →   recover()
 * ```
 *
 * The distinction this file exists to make: re-calling a method on a live object is not a restart. Every
 * test here closes the storage handle and opens a second one on the same file, so the recovery reads
 * what was actually durable rather than what an object happened to still be holding in memory.
 *
 * The three boundaries covered are the ones a recovery-matrix audit found uncovered at this fidelity:
 * `WAITING_RESOURCE` (budget, progress and continue semantics), `WAITING_RETRY` (the original schedule
 * and the bounded attempt count) and the observation-policy fallback for a Tool continuation written
 * before the policy field existed.
 */

const DEFAULT_OBSERVATION_POLICY = {
  maxSingleObservationTokens: 3_200,
  maxObservationBatchTokens: 7_040,
};

/** The durable Tool request every Tool-boundary test resumes from. */
const TOOL_DECISION = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: {
    callId: createLLMCallId(),
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "TOOL_CALLS" as const,
    assistantMessage: {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_boundary",
          toolName: "read_file",
          input: { path: "a" },
        },
      ],
    },
  },
  toolRequests: [{ externalCallId: "call_boundary", toolName: "read_file", args: { path: "a" } }],
};

function makeRun(overrides: Record<string, unknown> = {}) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "recover a durable boundary",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 86_400_000 },
    createdAt: createTimestampMs(1),
    startedAt: createTimestampMs(2),
    ...overrides,
  });
}

/**
 * A Tool batch coordinator that records the request it was handed and parks the Run on approval.
 *
 * The recorded request is the whole point: the observation policy the adapter resolved is a field of
 * the frozen batch request, so this is where the fallback ordering becomes observable. It answers
 * `WAITING_APPROVAL` rather than `COMPLETED` so the batch genuinely stops at a durable boundary
 * instead of driving an unrelated provider turn on top of the assertion.
 */
function recordingToolBatches(): {
  readonly batches: {
    modelDefinitions(): readonly never[];
    execute(request: never): Promise<never>;
    recover(request: never): Promise<never>;
  };
  requests(): readonly { readonly observationPolicy?: unknown; readonly mode: unknown }[];
} {
  const seen: { observationPolicy?: unknown; mode: unknown }[] = [];
  const completed = {
    kind: "COMPLETED",
    results: [
      {
        kind: "TOOL_RESULT",
        externalCallId: "call_boundary",
        toolName: "read_file",
        // Deliberately far larger than any policy under test, so the projected model-facing text is a
        // function of the observation policy and of nothing else.
        content: "x".repeat(40_000),
        isError: false,
      },
    ],
  };
  return {
    batches: {
      modelDefinitions: () => [],
      execute: (request) => {
        seen.push(request as never);
        return Promise.resolve(completed as never);
      },
      recover: (request) => {
        seen.push(request as never);
        return Promise.resolve(completed as never);
      },
    },
    requests: () => seen,
  };
}

/**
 * The durable snapshot of a Run, or a failure.
 *
 * A missing Run after a reopen is the failure this whole file is about, so it is asserted rather than
 * narrowed away — an absent durable record must never read as "nothing to check".
 */
async function loadDurable(
  storage: CaelushStorage,
  runId: RunId,
): Promise<import("@caelush/core").RunExecutionSnapshot> {
  const snapshot = await storage.execution.load(runId);
  if (snapshot === null) throw new Error(`Run ${runId} is not durable after the reopen`);
  return snapshot;
}

/**
 * The model-facing length of the Tool result the *resumed turn actually sent*.
 *
 * This is the observation policy's real effect: the policy truncates the projected result, so the text
 * that reaches the provider request is the only place the resolved policy becomes behaviour rather
 * than a recorded field.
 */
function projectedResultLength(turns: readonly { request: AIModelRequest }[]): number {
  const request = turns.at(-1)?.request;
  if (request === undefined) throw new Error("the resumed Run made no provider request");
  const results = request.messages.filter((message) => message.role === "tool");
  if (results.length === 0) throw new Error("the resumed request carried no Tool result");
  const content = results[0]?.content;
  return typeof content === "string" ? content.length : JSON.stringify(content).length;
}

function controllerOver(
  storage: CaelushStorage,
  input: {
    readonly now: () => TimestampMs;
    readonly providerCalls: { count: number };
    readonly toolBatches?: ReturnType<typeof recordingToolBatches>;
    readonly hostContextPolicy?: () => typeof DEFAULT_OBSERVATION_POLICY | undefined;
    /** Every provider request the resumed Run made, so the model-facing projection is checkable. */
    readonly turns?: { request: AIModelRequest }[];
  },
): RunController {
  const retryRegistry = new RunRetryRegistry({
    clock: { now: input.now },
    // A retry that is not yet due must be *scheduled*, not slept on. A no-op timer keeps the
    // assertion about the durable timestamp from turning into a real wall-clock wait.
    timer: { schedule: () => ({ cancel: () => undefined }) },
  });
  return new RunController({
    agentExecution: testRunAgentExecution({
      executor: fakeFrozenModelTurnExecutor(async (request) => {
        input.providerCalls.count += 1;
        input.turns?.push({ request });
        return modelTurnResult({
          callId: createLLMCallId(),
          providerId: "fixture",
          model: { provider: "fixture", model: "fixture-model" },
          text: "resumed",
          toolCalls: [],
          finishReason: "STOP",
        });
      }),
      createStepId: () => createStepId(),
    }).factory,
    executionStore: storage.execution,
    events: new EventBus(storage.events),
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    clock: { now: input.now },
    eventIdFactory: { create: createEventId },
    verificationPlanner,
    ...(input.toolBatches === undefined
      ? {}
      : { toolCoordinator: input.toolBatches.batches as never }),
    ...(input.hostContextPolicy === undefined
      ? {}
      : { contextRuntime: { getContextPolicy: input.hostContextPolicy } as never }),
    retryRegistry,
  });
}

/**
 * Seed the session/Run/Step/State a durable boundary needs, in one storage generation.
 *
 * The continuation's `sourceStepId` is the seeded Step's own id: the durable schema has a real foreign
 * key from a continuation to the Step it resumes, so a fabricated Step identity is refused by SQLite —
 * which is the database enforcing the same provenance rule the Run Layer enforces in code.
 */
async function seedBoundary(
  storage: CaelushStorage,
  run: ReturnType<typeof makeRun>,
  continuation: (ids: { readonly sourceStepId: StepId; readonly failedStepId: StepId }) => unknown,
): Promise<{ readonly sourceStepId: StepId; readonly failedStepId: StepId }> {
  const step = makeStep(run.id, {
    id: createStepId(),
    status: "COMPLETED",
    startedAt: createTimestampMs(10),
    finishedAt: createTimestampMs(10),
  });
  // The attempt that failed, for a retry checkpoint. It is a real Step of this Run because the durable
  // schema says so: a retry must name the attempt it is retrying.
  const failedStep = makeStep(run.id, {
    id: createStepId(),
    sequence: 2,
    status: "FAILED",
    startedAt: createTimestampMs(10),
    finishedAt: createTimestampMs(11),
  });
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  } as never);
  await storage.runs.insert(run);
  await storage.steps.insert(step);
  await storage.steps.insert(failedStep);
  await storage.runStates.save(
    makeState(run, {
      // The Run and AgentState projections must agree: the store refuses a snapshot where they do not.
      status: run.status as never,
      startedAt: createTimestampMs(2),
      updatedAt: createTimestampMs(10),
      // Two attempts are already durable (the Step that completed and the one that failed). Step
      // sequence is unique per Run and is allocated from this accounting, so a state that claimed zero
      // settled attempts would allocate sequence 1 again and collide with the Step seeded here.
      usage: { steps: 2, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    }),
  );
  await storage.messages.append(run.id as RunId, [
    { createdAt: createTimestampMs(2), message: { role: "user", content: run.goal } },
    // The assistant turn that requested the Tools. A resume is only valid behind the message that asked
    // for them, so the durable ledger has to hold it before a Tool boundary can be recovered.
    {
      createdAt: createTimestampMs(10),
      sourceStepId: step.id,
      message: TOOL_DECISION.modelTurn.assistantMessage,
    },
  ]);
  const ids = { sourceStepId: step.id, failedStepId: failedStep.id };
  await storage.continuations.set(
    run.id as RunId,
    continuation(ids) as never,
    createTimestampMs(10),
    null,
  );
  return ids;
}

/**
 * Run one test against a real SQLite file, over as many storage generations as it opens.
 *
 * Every handle is closed before the directory is removed, so a failing assertion reports the
 * assertion rather than a Windows file-lock error from the cleanup path.
 */
async function withDatabase(
  prefix: string,
  body: (open: () => Promise<CaelushStorage>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const opened: CaelushStorage[] = [];
  try {
    await body(async () => {
      const storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
      opened.push(storage);
      return storage;
    });
  } finally {
    for (const storage of opened) await storage.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("Phase 3F durable recovery boundaries", () => {
  it("leaves a WAITING_RESOURCE Run parked across a reopen, with its progress intact", async () => {
    const providerCalls = { count: 0 };
    await withDatabase("caelush-resource-recovery-", async (open) => {
      const first = await open();
      const run = makeRun({
        status: "WAITING_RESOURCE",
        resourcePolicy: {
          mode: "ADAPTIVE",
          operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
          batch: { maxToolCallsPerTurn: 16 },
          progress: {
            windowTurns: 8,
            identicalCallNudgeThreshold: 3,
            noProgressTurnsBeforeReplan: 4,
            replansBeforePause: 2,
          },
          hardLimits: {},
          inactivity: {},
        },
      });
      const ids = await seedBoundary(first, run, ({ sourceStepId }) => ({
        type: "WAITING_RESOURCE",
        runId: run.id,
        sourceStepId,
        pendingDecision: TOOL_DECISION,
        reason: "NO_PROGRESS",
        replanCount: 2,
      }));
      await first.close();

      /* A second storage generation, over the same file, with a brand-new controller. */
      const second = await open();
      const toolBatches = recordingToolBatches();
      const result = await controllerOver(second, {
        now: () => createTimestampMs(100),
        providerCalls,
        toolBatches,
      }).recover(run.id);

      // Recovery does not resume it: a resource decision is an external resolution, so the Run stays
      // parked and nothing is executed on its behalf.
      expect(result.status).toBe("WAITING_RESOURCE");
      expect(providerCalls.count).toBe(0);
      expect(toolBatches.requests()).toHaveLength(0);

      // The durable state survived the reopen unchanged, decisions and progress included.
      const reloaded = await loadDurable(second, run.id);
      expect(reloaded.run.status).toBe("WAITING_RESOURCE");
      const continuation = reloaded.continuation;
      if (continuation?.type !== "WAITING_RESOURCE") {
        throw new Error("the WAITING_RESOURCE boundary must have survived the reopen");
      }
      expect(continuation.replanCount).toBe(2);
      expect(continuation.reason).toBe("NO_PROGRESS");
      expect(continuation.pendingDecision.toolRequests).toEqual(TOOL_DECISION.toolRequests);
      expect(continuation.sourceStepId).toBeDefined();
      expect(reloaded.state?.usage.steps).toBe(2);
      void ids;

      // And the explicit Continue does move it, on the same Run, without re-running a Tool: the batch
      // it resumes is the one it was already waiting on, so no handler runs twice.
      const continued = await controllerOver(second, {
        now: () => createTimestampMs(200),
        providerCalls,
        toolBatches,
      }).continueResourceGuard(run.id);
      expect(continued.run.id).toBe(run.id);
      expect(toolBatches.requests()).toHaveLength(1);
      expect(providerCalls.count).toBe(1);
    });
  });

  it("preserves the original retry schedule and attempt count across a reopen", async () => {
    const providerCalls = { count: 0 };
    const nextAttemptAt = createTimestampMs(5_000);
    await withDatabase("caelush-retry-recovery-", async (open) => {
      const first = await open();
      const run = makeRun();
      const ids = await seedBoundary(first, run, ({ sourceStepId, failedStepId }) => ({
        type: "WAITING_RETRY",
        runId: run.id,
        mode: "TOOL_RESULTS",
        failedStepId,
        sourceStepId,
        attempt: 2,
        maxAttempts: 4,
        nextAttemptAt,
        errorCode: "LLM_NETWORK",
        pendingDecision: TOOL_DECISION,
        receivedResults: [
          {
            role: "tool",
            toolCallId: "call_boundary",
            toolName: "read_file",
            content: "source",
            isError: false,
          },
        ],
      }));
      void ids;
      await first.close();

      const second = await open();
      // A clock strictly *before* the durable schedule: this is the branch that must not run yet.
      let now = createTimestampMs(1_000);
      const before = await controllerOver(second, {
        now: () => now,
        providerCalls,
      }).recover(run.id);

      expect(before.status).toBe("WAITING_RETRY");
      expect(providerCalls.count).toBe(0);
      const stillWaiting = await loadDurable(second, run.id);
      const continuation = stillWaiting.continuation;
      if (continuation?.type !== "WAITING_RETRY") {
        throw new Error("the WAITING_RETRY boundary must have survived the reopen");
      }
      // The original schedule is the durable one: not refreshed to `now + delay`, not moved by the
      // restart, and the bounded attempt count is preserved with it.
      expect(continuation.nextAttemptAt).toBe(nextAttemptAt);
      expect(continuation.attempt).toBe(2);
      expect(continuation.maxAttempts).toBe(4);
      expect(before.status === "WAITING_RETRY" && before.nextAttemptAt).toBe(nextAttemptAt);

      // A second recovery still before the schedule changes nothing at all: the boundary is not
      // re-scheduled and no attempt is spent.
      now = createTimestampMs(4_999);
      const again = await controllerOver(second, { now: () => now, providerCalls }).recover(run.id);
      expect(again.status).toBe("WAITING_RETRY");
      expect(providerCalls.count).toBe(0);
      const after = await loadDurable(second, run.id);
      expect(after.continuation?.type === "WAITING_RETRY" && after.continuation.nextAttemptAt).toBe(
        nextAttemptAt,
      );

      // And the attempt that failed was never re-opened: a retry is a new attempt, not a replay of the
      // one that exhausted its provider turn.
      expect((await second.steps.get(ids.failedStepId))?.status).toBe("FAILED");
      expect(await second.steps.listByRun(run.id)).toHaveLength(2);
    });
  });

  it("degrades a Tool continuation written before the policy field existed, deterministically", async () => {
    const providerCalls = { count: 0 };
    await withDatabase("caelush-policy-fallback-", async (open) => {
      const first = await open();
      // Two Runs, each parked on the same shape of checkpoint: a `WAITING_TOOL_RESULTS` continuation
      // written before `observationPolicy` existed. Two Runs rather than one, because recovering the
      // first consumes its boundary — and the fallback ordering has to be observed on a Run that is
      // genuinely still parked on a policy-less continuation.
      const withoutHostRun = makeRun();
      const withHostRun = makeRun();
      for (const run of [withoutHostRun, withHostRun]) {
        await seedBoundary(first, run, ({ sourceStepId }) => ({
          type: "WAITING_TOOL_RESULTS",
          runId: run.id,
          sourceStepId,
          pendingDecision: TOOL_DECISION,
        }));
      }
      await first.close();

      const second = await open();
      const withoutHost = recordingToolBatches();
      const defaultTurns: { request: AIModelRequest }[] = [];
      await controllerOver(second, {
        now: () => createTimestampMs(100),
        providerCalls,
        toolBatches: withoutHost,
        turns: defaultTurns,
      }).recover(withoutHostRun.id);

      // No persisted policy and no host policy: the fixed default, unchanged by the reopen. The
      // projected text is what the resumed turn actually sent, so its size is the policy.
      expect(withoutHost.requests()).toHaveLength(1);
      expect(projectedResultLength(defaultTurns)).toBeGreaterThan(
        DEFAULT_OBSERVATION_POLICY.maxSingleObservationTokens,
      );

      const withHost = recordingToolBatches();
      const hostPolicy = { maxSingleObservationTokens: 111, maxObservationBatchTokens: 222 };
      const hostTurns: { request: AIModelRequest }[] = [];
      await controllerOver(second, {
        now: () => createTimestampMs(200),
        providerCalls,
        toolBatches: withHost,
        hostContextPolicy: () => hostPolicy,
        turns: hostTurns,
      }).recover(withHostRun.id);

      // A host policy is the *next* fallback, and it is consulted only because the durable record has
      // none. That ordering is the whole compatibility contract for an older checkpoint — and a
      // continuation with no recorded policy is the only one that may consult it.
      expect(withHost.requests()).toHaveLength(1);
      // Both projections are far below the 40,000-character result, so both policies truncated; the
      // host's is the smaller by an order of magnitude, which is what makes the fallback observable.
      expect(projectedResultLength(hostTurns)).toBeLessThan(
        projectedResultLength(defaultTurns) / 10,
      );
    });
  });

  it("uses the persisted observation policy even when the host now configures a different one", async () => {
    const providerCalls = { count: 0 };
    const durablePolicy = { maxSingleObservationTokens: 900, maxObservationBatchTokens: 1_800 };
    await withDatabase("caelush-policy-durable-", async (open) => {
      const first = await open();
      const run = makeRun();
      await seedBoundary(first, run, ({ sourceStepId }) => ({
        type: "WAITING_TOOL_RESULTS",
        runId: run.id,
        sourceStepId,
        pendingDecision: TOOL_DECISION,
        observationPolicy: durablePolicy,
      }));
      await first.close();

      const second = await open();
      const batches = recordingToolBatches();
      const turns: { request: AIModelRequest }[] = [];
      await controllerOver(second, {
        now: () => createTimestampMs(100),
        providerCalls,
        toolBatches: batches,
        // A restarted process with a *different* Context configuration must not retroactively
        // re-truncate a batch the model already asked for.
        hostContextPolicy: () => ({ maxSingleObservationTokens: 5, maxObservationBatchTokens: 5 }),
        turns,
      }).recover(run.id);

      expect(batches.requests()).toHaveLength(1);
      // The durable policy won: the projection is nowhere near what the 5-token host policy would give.
      const projected = projectedResultLength(turns);
      expect(projected).toBeGreaterThan(300);
      expect(projected).toBeLessThanOrEqual(durablePolicy.maxSingleObservationTokens * 4 + 256);
    });
  });
});
