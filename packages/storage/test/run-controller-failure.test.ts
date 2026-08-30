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
import { LLMTurnResultSchema, type LLMTurnResult } from "@caelush/llm/turn";
import {
  AgentLoop,
  RunController,
  RunControllerInfrastructureError,
  type RunExecutionStorePort,
} from "@caelush/core";
import { EventBus } from "@caelush/events";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

function makeRun(maxSteps = 4) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect parser",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
}

async function setup(options: {
  maxSteps?: number;
  complete: (count: number, signal: AbortSignal) => Promise<LLMTurnResult>;
  inspect?: () => Promise<never>;
  execution?: (storage: Awaited<ReturnType<typeof openCaelushStorage>>) => RunExecutionStorePort;
}) {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const run = makeRun(options.maxSteps);
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  } as never);
  await storage.runs.insert(run);
  const eventBus = new EventBus(storage.events);
  const events: { type: string }[] = [];
  eventBus.subscribe(run.id, (event) => events.push({ type: event.type }));
  let now = 10;
  let count = 0;
  const loop = new AgentLoop({
    inspector: { inspect: options.inspect ?? (async () => ({}) as never) },
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
      complete: async (_request, { signal }) => options.complete(++count, signal),
    },
    clock: { now: () => createTimestampMs(now++) },
    stepIdFactory: { create: () => createStepId() },
  });
  const controller = new RunController({
    agentLoop: loop,
    execution: options.execution?.(storage) ?? storage.execution,
    events: eventBus,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    clock: { now: () => createTimestampMs(now++) },
    eventIdFactory: { create: () => createEventId() },
  });
  return { storage, run, controller, events, providerCalls: () => count };
}

function finalTurn(text = "answer") {
  return LLMTurnResultSchema.parse({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls: [],
    finishReason: "STOP",
  });
}

function toolTurn() {
  return LLMTurnResultSchema.parse({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text: "inspect",
    toolCalls: [{ id: "call_a", name: "read_file", input: { path: "parser.ts" } }],
    finishReason: "TOOL_CALLS",
  });
}

describe("RunController failure and maxSteps boundaries", () => {
  it("cancels a pending Run without creating AgentState or a Step", async () => {
    const fixture = await setup({ complete: async () => finalTurn() });

    const result = await fixture.controller.cancel(fixture.run.id);

    expect(result.status).toBe("TERMINAL");
    expect((await fixture.storage.runs.get(fixture.run.id))?.status).toBe("CANCELLED");
    expect(await fixture.storage.runStates.get(fixture.run.id)).toBeNull();
    expect(await fixture.storage.steps.listByRun(fixture.run.id)).toEqual([]);
    expect(fixture.providerCalls()).toBe(0);
    await fixture.storage.close();
  });

  it("settles provider failures as a failed Step and Run without llm.completed", async () => {
    const fixture = await setup({
      complete: async () => {
        throw new Error("provider secret");
      },
    });
    const result = await fixture.controller.start(fixture.run.id);
    expect(result.status).toBe("FAILED");
    expect((await fixture.storage.runs.get(fixture.run.id))?.status).toBe("FAILED");
    expect((await fixture.storage.steps.listByRun(fixture.run.id))[0]?.status).toBe("FAILED");
    expect((await fixture.storage.runStates.get(fixture.run.id))?.usage.steps).toBe(1);
    expect(fixture.events.map((event) => event.type)).not.toContain("llm.completed");
    expect(fixture.events).toEqual(
      expect.arrayContaining([
        { type: "error" },
        { type: "status.changed" },
        { type: "run.failed" },
      ]),
    );
    await fixture.storage.close();
  });

  it("emits llm.completed when the provider returned a rejected model output", async () => {
    const rejected = LLMTurnResultSchema.parse({
      ...finalTurn("partial"),
      finishReason: "LENGTH",
      toolCalls: [{ id: "call_a", name: "read_file", input: {} }],
    });
    const fixture = await setup({ complete: async () => rejected });
    await fixture.controller.start(fixture.run.id);
    expect(fixture.events.map((event) => event.type)).toContain("llm.completed");
    expect((await fixture.storage.runs.get(fixture.run.id))?.status).toBe("FAILED");
    await fixture.storage.close();
  });

  it("fails context preparation without creating a Step or LLM events", async () => {
    const fixture = await setup({
      complete: async () => finalTurn(),
      inspect: async () => {
        throw new Error("context secret");
      },
    });
    await fixture.controller.start(fixture.run.id);
    expect(await fixture.storage.steps.listByRun(fixture.run.id)).toEqual([]);
    expect(fixture.providerCalls()).toBe(0);
    expect(fixture.events.map((event) => event.type)).not.toContain("llm.started");
    await fixture.storage.close();
  });

  it("does not fail a Run for expected maxSteps control flow", async () => {
    const fixture = await setup({ maxSteps: 1, complete: async () => toolTurn() });
    const waiting = await fixture.controller.start(fixture.run.id);
    expect(waiting.status).toBe("WAITING_TOOL_RESULTS");
    const result = await fixture.controller.submitToolResults(fixture.run.id, [
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "source",
        isError: false,
      },
    ]);
    expect(result.status).toBe("MAX_STEPS_REACHED");
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.events.map((event) => event.type)).not.toContain("run.failed");
    expect(
      (await fixture.storage.messages.listByRun(fixture.run.id)).map((entry) => entry.message.role),
    ).toEqual(["user", "assistant", "tool"]);
    await fixture.storage.close();
  });

  it("does not retry after a final settlement persistence failure", async () => {
    const fixture = await setup({
      complete: async () => finalTurn(),
      execution: (storage) => ({
        load: (runId) => storage.execution.load(runId),
        requestCancellation: (runId, intent) => storage.execution.requestCancellation(runId, intent),
        commit: async (command) => {
          if (command.run.status === "VERIFYING") throw new Error("final commit failed");
          return storage.execution.commit(command);
        },
      }),
    });
    await expect(fixture.controller.start(fixture.run.id)).rejects.toBeInstanceOf(
      RunControllerInfrastructureError,
    );
    expect(fixture.providerCalls()).toBe(1);
    expect((await fixture.storage.steps.listByRun(fixture.run.id))[0]?.status).toBe("RUNNING");
    const recovered = await fixture.controller.recover(fixture.run.id);
    expect(recovered.status).toBe("FAILED");
    expect(fixture.providerCalls()).toBe(1);
    await fixture.storage.close();
  });

  it("propagates cancellation through an in-flight provider turn and settles durably", async () => {
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const fixture = await setup({
      complete: async (_count, signal) => {
        providerStarted();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    });

    const startPromise = fixture.controller.start(fixture.run.id);
    await started;
    const cancelResult = await fixture.controller.cancel(fixture.run.id);
    const startResult = await startPromise;

    expect(cancelResult.status).toBe("TERMINAL");
    expect(startResult.status).toBe("TERMINAL");
    expect((await fixture.storage.runs.get(fixture.run.id))?.status).toBe("CANCELLED");
    expect((await fixture.storage.runStates.get(fixture.run.id))?.status).toBe("CANCELLED");
    expect((await fixture.storage.runStates.get(fixture.run.id))?.usage.steps).toBe(1);
    expect((await fixture.storage.steps.listByRun(fixture.run.id))[0]?.status).toBe("CANCELLED");
    expect(await fixture.storage.messages.listByRun(fixture.run.id)).toEqual([]);
    expect(fixture.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["status.changed", "run.cancelled"]),
    );
    await fixture.storage.close();
  });
});
