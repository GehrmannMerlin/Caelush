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
import { createAssistantMessageAppend, createUserMessageAppend, RunController } from "@caelush/core";
import { EventBus } from "./support/test-event-notifier.js";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeState, makeStep, verificationPlanner } from "./support/fixtures.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";
import { appendDurableEventsInTransaction } from "../src/events/sqlite-durable-event-store.js";

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
  return new RunController({
    agentExecution: testRunAgentExecution({
      executor: fakeFrozenModelTurnExecutor(async () => {
        calls.count += 1;
        return {
          callId: createLLMCallId(),
          providerId: "fixture",
          model: { provider: "fixture", model: "fixture-model" },
          text: output,
          toolCalls: [],
          finishReason: "STOP",
        };
      }),
      createStepId: () => createStepId(),
    }).factory,
    executionStore: storage.execution,
    messages: testRunMessageAuthority({
      records: (runId) => storage.messageRecords.listByRun(runId),
    }),
    events: new EventBus(storage.eventReader),
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
    const messages = testRunMessageAuthority();
    await storage.messageRecords.append(currentRun.id, [
      createUserMessageAppend(messages, currentRun, "GOAL").draft,
    ]);
    await storage.steps.insert(step);
    await storage.runStates.save(state);
    const client = storage.messageRecords.database.client;
    client.exec("BEGIN IMMEDIATE");
    appendDurableEventsInTransaction(client, [{
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
    }]);
    client.exec("COMMIT");
    const calls = { count: 0 };
    const result = await controller(storage, calls).recover(pending.id);
    expect(result.status).toBe("FAILED");
    expect(calls.count).toBe(0);
    expect((await storage.steps.get(step.id))?.status).toBe("FAILED");
    expect((await storage.runs.get(pending.id))?.currentStepId).toBeUndefined();
    expect((await storage.runStates.get(pending.id))?.status).toBe("FAILED");
    await storage.close();
  });

  it("recovers an expired waiting boundary as TIMEOUT without calling the provider", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const pending = run();
    const currentRun = AgentRunSchema.parse({
      ...pending,
      status: "RUNNING" as const,
      limits: { ...pending.limits, timeoutMs: 10 },
      startedAt: createTimestampMs(2),
    });
    const state = makeState(currentRun, {
      status: "RUNNING",
      startedAt: createTimestampMs(2),
      updatedAt: createTimestampMs(10),
    });
    const step = makeStep(currentRun.id, {
      id: createStepId(),
      status: "COMPLETED",
      finishedAt: createTimestampMs(10),
    });
    await insertParents(storage, currentRun);
    await storage.steps.insert(step);
    await storage.runStates.save(state);
    await storage.continuations.set(
      currentRun.id,
      {
        type: "WAITING_TOOL_RESULTS",
        runId: currentRun.id,
        sourceStepId: step.id,
        pendingDecision: {
          type: "TOOL_CALLS_REQUESTED",
          modelTurn: {
            callId: createLLMCallId(),
            model: currentRun.model,
            finishReason: "TOOL_CALLS",
            assistantMessage: {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_expired",
                  toolName: "read_file",
                  input: { path: "a" },
                },
              ],
            },
          },
          toolRequests: [
            { externalCallId: "call_expired", toolName: "read_file", args: { path: "a" } },
          ],
        },
      },
      createTimestampMs(10),
      null,
    );
    const calls = { count: 0 };
    const result = await controller(storage, calls).recover(currentRun.id);
    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("TIMEOUT");
    expect(calls.count).toBe(0);
    expect((await storage.continuations.get(currentRun.id))?.checkpoint).toBeUndefined();
    expect(
      (await storage.eventReader.replay(currentRun.id, { afterSequence: 0, throughSequence: Number.MAX_SAFE_INTEGER, limit: 1000 })).filter(
        (event) => event.type === "run.timed_out",
      ),
    ).toHaveLength(1);
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
    const messages = testRunMessageAuthority();
    await storage.messageRecords.append(pending.id, [
      createUserMessageAppend(messages, pending, "GOAL").draft,
      createAssistantMessageAppend(messages, pending, step.id, {
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
      }).draft,
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
