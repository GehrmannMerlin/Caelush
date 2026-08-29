import {
  AgentRunSchema,
  createEventId,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent-loop.js";
import { RunController } from "../src/run-controller.js";
import type {
  DurableAgentEvent,
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "../src/run-execution-store.js";
import type { RunEventNotifier, RunExecutionConfigResolver } from "../src/run-controller-ports.js";

function makeRun() {
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
      ...stateProjection,
      ...(activeStep === undefined ? {} : { activeStep }),
      conversation: updatedConversation,
      ...(command.continuation?.operation === "SET"
        ? { continuation: command.continuation.checkpoint, continuationRevision: 1 }
        : {}),
    };
    const events: DurableAgentEvent[] = command.events.map((draft) => ({
      ...draft,
      durability: { ...draft.durability, sequence: ++this.sequence },
    }));
    return { snapshot: this.snapshot, events };
  }
}

function makeLoop(store: MemoryExecutionStore, providerFirstLine: () => void): AgentLoop {
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
    llmClient: {
      complete: async () => {
        const current = store.snapshot;
        expect(current.run.currentStepId).toBeDefined();
        expect(current.state?.currentStepId).toBe(current.run.currentStepId);
        expect(current.activeStep?.status).toBe("RUNNING");
        expect(store.commits.at(-1)?.events[0]?.type).toBe("llm.started");
        providerFirstLine();
        return {
          callId: createLLMCallId(),
          providerId: "fixture",
          model: { provider: "fixture", model: "fixture-model" },
          text: "candidate",
          toolCalls: [],
          finishReason: "STOP" as const,
        };
      },
    },
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
  });
}

describe("RunController.start", () => {
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
    });

    const result = await controller.start(run.id);
    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(store.snapshot.run.status).toBe("VERIFYING");
    expect(store.commits[0]?.run.status).toBe("RUNNING");
    expect(store.commits[0]?.events.map((event) => event.type)).toEqual([
      "run.started",
      "status.changed",
    ]);
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
    });

    await controller.start(run.id);
    const second = await controller.start(run.id);
    expect(second.status).toBe("AWAITING_VERIFICATION");
    expect(
      store.commits.filter((commit) => commit.events.some((event) => event.type === "run.started")),
    ).toHaveLength(1);
  });
});
