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
import type { LLMToolResultMessage } from "@caelush/llm/messages";
import {
  AgentLoop,
  RunController,
  RunControllerConflictError,
  RunDeadlineRegistry,
} from "@caelush/core";
import { EventBus } from "@caelush/events";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { verificationPlanner } from "./support/fixtures.js";

function makeRun() {
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
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
}

function turn(
  text: string,
  toolCalls: LLMTurnResult["toolCalls"],
  finishReason: LLMTurnResult["finishReason"],
): LLMTurnResult {
  return LLMTurnResultSchema.parse({
    callId: createLLMCallId(),
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text,
    toolCalls,
    finishReason,
  });
}

describe("RunController durable boundaries", () => {
  it("times out an idle external Tool Result boundary and rejects late results", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = AgentRunSchema.parse({
      ...makeRun(),
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 100 },
    });
    await storage.sessions.insert({
      id: run.sessionId,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    } as never);
    await storage.runs.insert(run);
    const eventBus = new EventBus(storage.events);
    const callbacks: Array<{ callback: () => void | Promise<void>; cancelled: boolean }> = [];
    const clock = { value: 10 };
    const deadlineRegistry = new RunDeadlineRegistry({
      clock: { now: () => createTimestampMs(clock.value) },
      timer: {
        schedule: (_delay, callback) => {
          const task = { callback, cancelled: false };
          callbacks.push(task);
          return { cancel: () => (task.cancelled = true) };
        },
      },
    });
    const controller = new RunController({
      agentLoop: new AgentLoop({
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
          complete: async () =>
            turn("need result", [{ id: "call_a", name: "read_file", input: {} }], "TOOL_CALLS"),
        },
        clock: { now: () => createTimestampMs(clock.value) },
        stepIdFactory: { create: createStepId },
      }),
      execution: storage.execution,
      events: eventBus,
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "synthetic",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(clock.value) },
      eventIdFactory: { create: createEventId },
      verificationPlanner,
      deadlineRegistry,
    });

    const waiting = await controller.start(run.id);
    expect(waiting.status).toBe("WAITING_TOOL_RESULTS");
    clock.value = 110;
    await callbacks.find((task) => !task.cancelled)!.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await storage.runs.get(run.id))?.status).toBe("TIMEOUT");
    const late = await controller.submitToolResults(run.id, [
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "late",
        isError: false,
      },
    ]);
    expect(late.status).toBe("TERMINAL");
    await storage.close();
  });

  it("persists a tool boundary, accepts results before resume, and persists VERIFYING candidate", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun();
    const session = { id: run.sessionId, createdAt: 1, updatedAt: 1, metadata: {} } as never;
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    const eventBus = new EventBus(storage.events);
    const events: unknown[] = [];
    eventBus.subscribe(run.id, (event) => events.push(event));
    const results = [
      turn(
        "inspect",
        [{ id: "call_a", name: "read_file", input: { path: "parser.ts" } }],
        "TOOL_CALLS",
      ),
      turn("fixed", [], "STOP"),
    ];
    let now = 10;
    const loop = new AgentLoop({
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
      llmClient: { complete: async () => results.shift()! },
      clock: { now: () => createTimestampMs(now++) },
      stepIdFactory: { create: () => createStepId() },
    });
    const controller = new RunController({
      agentLoop: loop,
      execution: storage.execution,
      events: eventBus,
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "synthetic",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(now++) },
      eventIdFactory: { create: () => createEventId() },
      verificationPlanner,
    });

    const waiting = await controller.start(run.id);
    expect(waiting.status).toBe("WAITING_TOOL_RESULTS");
    expect(await storage.runs.get(run.id)).toMatchObject({ status: "RUNNING" });
    expect((await storage.steps.listByRun(run.id))[0]).toMatchObject({ status: "COMPLETED" });
    expect((await storage.continuations.get(run.id))?.checkpoint.type).toBe("WAITING_TOOL_RESULTS");
    expect((await storage.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
    ]);

    const final = await controller.submitToolResults(run.id, [
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "updated parser",
        isError: false,
      },
    ]);
    expect(final.status).toBe("AWAITING_VERIFICATION");
    expect((await storage.runs.get(run.id))?.status).toBe("VERIFYING");
    expect((await storage.runStates.get(run.id))?.status).toBe("VERIFYING");
    expect((await storage.messages.listByRun(run.id)).map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect((await storage.continuations.get(run.id))?.checkpoint.type).toBe(
      "AWAITING_VERIFICATION",
    );
    const storedPlan = await storage.verification.getPlanForRun(
      run.id,
      (final as Extract<typeof final, { status: "AWAITING_VERIFICATION" }>).sourceStepId,
    );
    expect(storedPlan?.id).toBe(
      (final as Extract<typeof final, { status: "AWAITING_VERIFICATION" }>).verificationPlanId,
    );
    expect(events.map((event) => (event as { type: string }).type)).toContain(
      "verification.planned",
    );
    expect((await storage.runs.get(run.id))?.finalResult).toBeUndefined();
    expect(events.map((event) => (event as { type: string }).type)).not.toContain("run.completed");
    expect(await storage.events.latestSequence(run.id)).toBeGreaterThan(0);
    await storage.close();
  });

  it("treats an already accepted equal Tool Result batch as idempotent and rejects a conflict", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun();
    await storage.sessions.insert({
      id: run.sessionId,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    } as never);
    await storage.runs.insert(run);
    const eventBus = new EventBus(storage.events);
    const turns = [
      turn(
        "inspect",
        [{ id: "call_a", name: "read_file", input: { path: "parser.ts" } }],
        "TOOL_CALLS",
      ),
      turn("fixed", [], "STOP"),
    ];
    let now = 10;
    let calls = 0;
    const controller = new RunController({
      agentLoop: new AgentLoop({
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
            calls += 1;
            return turns.shift()!;
          },
        },
        clock: { now: () => createTimestampMs(now++) },
        stepIdFactory: { create: () => createStepId() },
      }),
      execution: storage.execution,
      events: eventBus,
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "synthetic",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(now++) },
      eventIdFactory: { create: () => createEventId() },
      verificationPlanner,
    });
    await controller.start(run.id);
    const stored = await storage.continuations.get(run.id);
    if (stored?.checkpoint.type !== "WAITING_TOOL_RESULTS")
      throw new Error("expected waiting checkpoint");
    const accepted: LLMToolResultMessage[] = [
      {
        role: "tool" as const,
        toolCallId: "call_a",
        toolName: "read_file" as const,
        content: "source",
        isError: false,
      },
    ];
    await storage.continuations.set(
      run.id,
      { ...stored.checkpoint, receivedResults: accepted },
      createTimestampMs(30),
      stored.revision,
    );
    await expect(
      storage.continuations.set(
        run.id,
        {
          ...stored.checkpoint,
          receivedResults: [{ ...accepted[0]!, content: "different" }],
        },
        createTimestampMs(31),
        stored.revision,
      ),
    ).rejects.toThrow();
    await expect(
      controller.submitToolResults(run.id, [{ ...accepted[0]!, content: "different" }]),
    ).rejects.toBeInstanceOf(RunControllerConflictError);
    const result = await controller.submitToolResults(run.id, accepted);
    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(calls).toBe(2);
    await storage.close();
  });
});
