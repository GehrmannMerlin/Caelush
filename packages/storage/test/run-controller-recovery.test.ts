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
import { AgentLoop, RunController } from "@caelush/core";
import { EventBus } from "@caelush/events";
import { LLMTurnResultSchema } from "@caelush/llm/turn";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeState, makeStep } from "./support/fixtures.js";

function run() {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "recover run",
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

function controller(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  calls: { count: number },
  output = "recovered",
) {
  let now = 20;
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
    llmClient: {
      complete: async () => {
        calls.count += 1;
        return LLMTurnResultSchema.parse({
          callId: createLLMCallId(),
          providerId: "fixture",
          model: { provider: "fixture", model: "fixture-model" },
          text: output,
          toolCalls: [],
          finishReason: "STOP",
        });
      },
    },
    clock: { now: () => createTimestampMs(now++) },
    stepIdFactory: { create: () => createStepId() },
  });
  return new RunController({
    agentLoop: loop,
    execution: storage.execution,
    events: new EventBus(storage.events),
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    clock: { now: () => createTimestampMs(now++) },
    eventIdFactory: { create: () => createEventId() },
  });
}

async function insertParents(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  currentRun: ReturnType<typeof run>,
) {
  await storage.sessions.insert({
    id: currentRun.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  } as never);
  await storage.runs.insert(currentRun);
}

describe("RunController recovery", () => {
  it("fails a stale active provider Step closed without calling the provider", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const pending = run();
    const step = makeStep(pending.id, { id: createStepId(), startedAt: createTimestampMs(10) });
    const currentRun = AgentRunSchema.parse({
      ...pending,
      status: "RUNNING" as const,
      currentStepId: step.id,
      startedAt: createTimestampMs(2),
    });
    const state = makeState(pending, {
      status: "RUNNING",
      currentStepId: step.id,
      startedAt: createTimestampMs(2),
      updatedAt: createTimestampMs(10),
    });
    await insertParents(storage, currentRun);
    await storage.steps.insert(step);
    await storage.runStates.save(state);
    await storage.events.append({
      eventId: createEventId(),
      schemaVersion: 1,
      runId: pending.id,
      sessionId: pending.sessionId,
      stepId: step.id,
      timestamp: createTimestampMs(10),
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1 },
      type: "llm.started",
      payload: { model: pending.model },
    });
    const calls = { count: 0 };
    const result = await controller(storage, calls).recover(pending.id);
    expect(result.status).toBe("FAILED");
    expect(calls.count).toBe(0);
    expect((await storage.steps.get(step.id))?.status).toBe("FAILED");
    expect((await storage.runs.get(pending.id))?.currentStepId).toBeUndefined();
    expect((await storage.runStates.get(pending.id))?.status).toBe("FAILED");
    await storage.close();
  });

  it("recovers a waiting Tool boundary without a provider call", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const pending = run();
    const currentRun = AgentRunSchema.parse({
      ...pending,
      status: "RUNNING" as const,
      startedAt: createTimestampMs(2),
    });
    const state = makeState(pending, { status: "RUNNING", startedAt: createTimestampMs(2) });
    const step = makeStep(pending.id, {
      id: createStepId(),
      status: "COMPLETED",
      finishedAt: createTimestampMs(10),
    });
    await insertParents(storage, currentRun);
    await storage.steps.insert(step);
    await storage.runStates.save(state);
    await storage.messages.append(pending.id, [
      { createdAt: createTimestampMs(2), message: { role: "user", content: pending.goal } },
      {
        createdAt: createTimestampMs(10),
        sourceStepId: step.id,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_a",
              toolName: "read_file",
              input: { path: "a" },
            },
          ],
        },
      },
    ]);
    await storage.continuations.set(
      pending.id,
      {
        type: "WAITING_TOOL_RESULTS",
        runId: pending.id,
        sourceStepId: step.id,
        pendingDecision: {
          type: "TOOL_CALLS_REQUESTED",
          modelTurn: {
            callId: createLLMCallId(),
            model: pending.model,
            finishReason: "TOOL_CALLS",
            assistantMessage: {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_a",
                  toolName: "read_file",
                  input: { path: "a" },
                },
              ],
            },
          },
          toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a" } }],
        },
      },
      createTimestampMs(10),
      null,
    );
    const calls = { count: 0 };
    const result = await controller(storage, calls).recover(pending.id);
    expect(result.status).toBe("WAITING_TOOL_RESULTS");
    expect(calls.count).toBe(0);
    await storage.close();
  });
});
