import {
  AgentRunSchema,
  createEventId,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type VerificationPlanDraft,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop.js";
import { RunController } from "../src/run-controller.js";
import { RunDeadlineRegistry } from "../src/run-deadline-registry.js";
import type {
  DurableAgentEvent,
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "../src/run-execution-store.js";
import type { RunEventNotifier, RunExecutionConfigResolver } from "../src/run-controller-ports.js";
import type { RunBudgetPort } from "../src/budget-ports.js";
import { fakeModelTurnExecutor, testModelCatalog } from "./support/fake-model-turn-executor.js";

function makeRun(overrides: Partial<ReturnType<typeof AgentRunSchema.parse>> = {}) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
    ...overrides,
  });
}

class MemoryExecutionStore implements RunExecutionStorePort {
  snapshot: RunExecutionSnapshot;
  stateRevision: number | undefined;
  commits: RunExecutionCommit[] = [];
  sequence = 0;

  constructor(run: ReturnType<typeof makeRun>) {
    this.snapshot = { run, conversation: [] };
  }

  async load(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(
    runId: ReturnType<typeof createRunId>,
    intent: RunExecutionSnapshot["cancellationIntent"],
  ) {
    if (intent === undefined || intent.runId !== runId) throw new Error("invalid cancellation");
    this.snapshot = { ...this.snapshot, cancellationIntent: intent };
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    this.commits.push(command);
    this.stateRevision =
      command.state === undefined ? this.stateRevision : (this.stateRevision ?? 0) + 1;
    const activeStep = command.stepWrites.find((write) => write.step.status === "RUNNING")?.step;
    const updatedConversation = [
      ...this.snapshot.conversation,
      ...command.messagesToAppend.map((entry, index) => ({
        runId: command.run.id,
        sequence: this.snapshot.conversation.length + index + 1,
        ...entry,
      })),
    ];
    const stateProjection =
      command.state === undefined
        ? {}
        : { state: command.state, stateRevision: this.stateRevision! };
    this.snapshot = {
      run: command.run,
      ...(this.snapshot.cancellationIntent === undefined
        ? {}
        : { cancellationIntent: this.snapshot.cancellationIntent }),
      ...stateProjection,
      ...(activeStep === undefined ? {} : { activeStep }),
      conversation: updatedConversation,
      ...(command.continuation?.operation === "SET"
        ? { continuation: command.continuation.checkpoint, continuationRevision: 1 }
        : {}),
      ...(command.verificationPlan === undefined
        ? this.snapshot.verificationPlan === undefined
          ? {}
          : { verificationPlan: this.snapshot.verificationPlan }
        : { verificationPlan: command.verificationPlan }),
    };
    const events: DurableAgentEvent[] = command.events.map((draft) => ({
      ...draft,
      durability: { ...draft.durability, sequence: ++this.sequence },
    }));
    return { snapshot: this.snapshot, events };
  }
}

const verificationPlanner = {
  plan: ({
    runId,
    sourceStepId,
  }: {
    runId: ReturnType<typeof createRunId>;
    sourceStepId: ReturnType<typeof createStepId>;
  }): VerificationPlanDraft => ({
    runId,
    sourceStepId,
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: [
      {
        ordinal: 0,
        stage: "ACCEPTANCE",
        requirement: "REQUIRED",
        spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
      },
    ],
  }),
};

function makeLoop(
  store: MemoryExecutionStore,
  providerFirstLine: () => void,
  providerWait?: (signal: AbortSignal) => Promise<void>,
): AgentLoop {
  return new AgentLoop({
    inspector: { inspect: async () => ({}) as never },
    planner: { plan: async () => ({}) as never },
    contextBuilder: {
      build: (input) => ({
        messages:
          input.mode === "TOOL_CONTINUATION"
            ? input.currentTurnMessages
            : [input.currentUserMessage],
        report: {} as never,
      }),
    },
    models: testModelCatalog(),
    modelTurns: fakeModelTurnExecutor(async (_request, signal) => {
      const current = store.snapshot;
      expect(current.run.currentStepId).toBeDefined();
      expect(current.state?.currentStepId).toBe(current.run.currentStepId);
      expect(current.activeStep?.status).toBe("RUNNING");
      expect(store.commits.at(-1)?.events[0]?.type).toBe("llm.started");
      providerFirstLine();
      if (providerWait !== undefined) await providerWait(signal);
      return {
        callId: createLLMCallId(),
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture-model" },
        text: "candidate",
        toolCalls: [],
        finishReason: "STOP" as const,
      };
    }),
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
  });
}

describe("RunController.start", () => {
  it("aborts an in-flight provider when the Run deadline fires", async () => {
    const run = makeRun({
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 100 },
    });
    const store = new MemoryExecutionStore(run);
    let now = 10;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const tasks: Array<() => void | Promise<void>> = [];
    const controller = new RunController({
      agentLoop: makeLoop(
        store,
        () => providerEntered(),
        async (signal) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
              once: true,
            });
          });
        },
      ),
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(now) },
      eventIdFactory: { create: () => createEventId() },
      deadlineRegistry: new RunDeadlineRegistry({
        clock: { now: () => createTimestampMs(now) },
        timer: {
          schedule: (_delay, callback) => {
            tasks.push(callback);
            return { cancel: () => undefined };
          },
        },
      }),
    });

    const resultPromise = controller.start(run.id);
    await entered;
    now = 110;
    await tasks.at(-1)!();
    const result = await resultPromise;

    expect(result.status).toBe("TERMINAL");
    expect(store.snapshot.run.status).toBe("TIMEOUT");
    expect(store.commits.at(-1)?.events.map((event) => event.type)).toEqual([
      "status.changed",
      "run.timed_out",
    ]);
  });

  it("settles a deadline reached after RUNNING commit before calling the provider", async () => {
    const run = makeRun({
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1 },
    });
    const store = new MemoryExecutionStore(run);
    let now = 10;
    let providerCalls = 0;
    const controller = new RunController({
      agentLoop: makeLoop(store, () => {
        providerCalls += 1;
      }),
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(now++) },
      eventIdFactory: { create: () => createEventId() },
      deadlineRegistry: new RunDeadlineRegistry({
        clock: { now: () => createTimestampMs(now) },
        timer: { schedule: () => ({ cancel: () => undefined }) },
      }),
    });

    const result = await controller.start(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(store.snapshot.run.status).toBe("TIMEOUT");
    expect(providerCalls).toBe(0);
  });

  it("returns TIMEOUT_PENDING until Run-owned cleanup is confirmed, then retries recovery", async () => {
    const run = makeRun({
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1 },
    });
    const store = new MemoryExecutionStore(run);
    let now = 10;
    let cleanupCalls = 0;
    const deadlineRegistry = new RunDeadlineRegistry({
      clock: { now: () => createTimestampMs(now) },
      timer: { schedule: () => ({ cancel: () => undefined }) },
    });
    const controller = new RunController({
      agentLoop: makeLoop(store, () => {
        throw new Error("timeout cleanup must precede provider execution");
      }),
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(now++) },
      eventIdFactory: { create: () => createEventId() },
      deadlineRegistry,
      resources: {
        cancelOwnedResources: async () => {
          cleanupCalls += 1;
          return { stoppedResourceIds: [], confirmed: cleanupCalls > 1 };
        },
      },
    });

    const pending = await controller.start(run.id);
    expect(pending.status).toBe("TIMEOUT_PENDING");
    expect(store.snapshot.run.status).toBe("RUNNING");
    expect(cleanupCalls).toBe(1);

    const recovered = await controller.recover(run.id);
    expect(recovered.status).toBe("TERMINAL");
    expect(recovered.run.status).toBe("TIMEOUT");
    expect(cleanupCalls).toBe(2);
    expect(store.commits.at(-1)?.events.map((event) => event.type)).toEqual([
      "status.changed",
      "run.timed_out",
    ]);
  });

  it("durably starts a pending Run and checkpoints before the first provider call", async () => {
    const run = makeRun();
    const store = new MemoryExecutionStore(run);
    let providerCalls = 0;
    const notified: DurableAgentEvent[] = [];
    const notifier: RunEventNotifier = { notifyCommitted: (events) => notified.push(...events) };
    const resolver: RunExecutionConfigResolver = {
      resolve: async () => ({
        baseSystemPrompt: "private synthetic prompt",
        contextLimits: { maxInputTokens: 1000 },
      }),
    };
    const controller = new RunController({
      agentLoop: makeLoop(store, () => {
        providerCalls += 1;
      }),
      execution: store,
      events: notifier,
      configResolver: resolver,
      clock: { now: () => createTimestampMs(10) },
      eventIdFactory: { create: () => createEventId() },
      verificationPlanner,
    });

    const result = await controller.start(run.id);
    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(store.snapshot.run.status).toBe("VERIFYING");
    expect(store.commits[0]?.run.status).toBe("RUNNING");
    expect(store.commits[0]?.events.map((event) => event.type)).toEqual([
      "run.started",
      "status.changed",
    ]);
    expect(store.commits.at(-1)?.events.map((event) => event.type)).toContain(
      "verification.planned",
    );
    expect(notified.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(providerCalls).toBe(1);
  });

  it("does not duplicate run.started when start is called again at a durable boundary", async () => {
    const run = makeRun();
    const store = new MemoryExecutionStore(run);
    const controller = new RunController({
      agentLoop: makeLoop(store, () => undefined),
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(10) },
      eventIdFactory: { create: () => createEventId() },
      verificationPlanner,
    });

    await controller.start(run.id);
    const second = await controller.start(run.id);
    expect(second.status).toBe("AWAITING_VERIFICATION");
    expect(
      store.commits.filter((commit) => commit.events.some((event) => event.type === "run.started")),
    ).toHaveLength(1);
  });

  it("finalizes a budget admission failure without creating a Step or failing the Run", async () => {
    const run = makeRun({
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000, maxTokens: 1 },
    });
    const store = new MemoryExecutionStore(run);
    let providerCalls = 0;
    const budget: RunBudgetPort = {
      admitLLM: async () => ({
        kind: "EXCEEDED",
        dimension: "TOKENS",
        accounted: 1,
        limit: 1,
      }),
      settleLLM: async () => undefined,
    };
    const controller = new RunController({
      agentLoop: makeLoop(store, () => {
        providerCalls += 1;
      }),
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(10) },
      eventIdFactory: { create: () => createEventId() },
      budget,
    });

    const result = await controller.start(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("BUDGET_EXCEEDED");
    expect(store.snapshot.state?.status).toBe("BUDGET_EXCEEDED");
    expect(store.snapshot.state?.currentStepId).toBeUndefined();
    expect(store.commits.flatMap((commit) => commit.stepWrites)).toHaveLength(0);
    expect(providerCalls).toBe(0);
    expect(store.commits.at(-1)?.events.map((event) => event.type)).toEqual([
      "budget.exceeded",
      "status.changed",
    ]);
  });
});

describe("RunController.cancel", () => {
  it("persists intent before cancelling a pending Run", async () => {
    const run = makeRun();
    const store = new MemoryExecutionStore(run);
    const notified: DurableAgentEvent[] = [];
    const controller = new RunController({
      agentLoop: makeLoop(store, () => {
        throw new Error("pending cancellation must not invoke the provider");
      }),
      execution: store,
      events: { notifyCommitted: (events) => notified.push(...events) },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(20) },
      eventIdFactory: { create: () => createEventId() },
    });

    const result = await controller.cancel(run.id);

    expect(result.status).toBe("TERMINAL");
    expect(store.snapshot.run.status).toBe("CANCELLED");
    expect(store.snapshot.cancellationIntent?.cause).toBe("USER_REQUESTED");
    expect(notified.map((event) => event.type)).toEqual(["status.changed", "run.cancelled"]);
  });
});

describe("RunController project verification driving", () => {
  it("drives project checks only after the Final Candidate transaction commits", async () => {
    const run = makeRun({ permissionProfile: "FULL_ACCESS", approvalPolicy: "DANGEROUS_ONLY" });
    const store = new MemoryExecutionStore(run);
    let runnerCalls = 0;
    let profileCalls = 0;
    let runtimeCalls = 0;
    const controller = new RunController({
      agentLoop: makeLoop(store, () => undefined),
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(10) },
      eventIdFactory: { create: () => createEventId() },
      verificationPlanner: {
        plan: ({ runId, sourceStepId }) => ({
          runId,
          sourceStepId,
          plannerVersion: "phase-11a.v1",
          planHash: "a".repeat(64),
          checks: [
            {
              ordinal: 0,
              stage: "FAST_STATIC",
              requirement: "IF_AVAILABLE",
              spec: { kind: "PROJECT", purpose: "TEST", source: "SYSTEM" },
            },
          ],
        }),
      },
      verificationRunner: {
        run: async (input) => {
          runnerCalls += 1;
          expect(store.snapshot.run.status).toBe("VERIFYING");
          expect(input.plan.checks[0]?.status).toBe("PENDING");
          return {
            outcome: "PROJECT_CHECKS_PASSED",
            executedCount: 1,
            passedCount: 1,
            failedCount: 0,
            errorCount: 0,
            skippedCount: 0,
          };
        },
      },
      projectProfileProvider: {
        getFreshProfile: async () => {
          profileCalls += 1;
          return {
            ecosystems: ["NODE"],
            packageManager: { name: "pnpm" },
            tooling: [],
            isMonorepo: false,
          };
        },
      },
      verificationExecution: {
        executeArgv: async () => {
          runtimeCalls += 1;
          throw new Error("fake runner should not call runtime");
        },
        interact: async () => {
          throw new Error("fake runner should not call runtime");
        },
      },
      verificationExecutionStore: {
        startCheck: async (input) => ({ check: input.check, events: [] }),
        settleCheck: async (input) => ({ check: input.check, events: [] }),
      },
      verificationSecurity: { assess: () => ({ kind: "ALLOW", safeReason: "allowed" }) },
      verificationEvidenceSanitizer: {
        redactText: (value) => value,
        boundText: (value) => ({ text: value, omittedBytes: 0, truncated: false }),
      },
    });

    const result = await controller.start(run.id);
    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(runnerCalls).toBe(1);
    expect(profileCalls).toBe(1);
    expect(runtimeCalls).toBe(0);
    expect(store.snapshot.run.status).toBe("VERIFYING");

    const plan = store.snapshot.verificationPlan!;
    store.snapshot = {
      ...store.snapshot,
      verificationPlan: {
        ...plan,
        checks: [{ ...plan.checks[0]!, status: "RUNNING", startedAt: createTimestampMs(11) }],
      },
    };
    await expect(controller.recover(run.id)).resolves.toMatchObject({
      status: "AWAITING_VERIFICATION",
    });
    expect(runnerCalls).toBe(1);
  });
});
