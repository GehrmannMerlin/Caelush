import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { RunController, type RunControllerResult } from "@caelush/core";
import { EventBus } from "@caelush/events";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { verificationPlanner } from "./support/fixtures.js";
import { modelTurnResult } from "./support/model-turns.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
  type FakeFrozenModelTurnExecutor,
} from "./support/run-agent-execution.js";

/**
 * A scripted model turn authority.
 *
 * Phase 2C removed the LLM provider seam from Core, so "how many provider turns
 * happened" is now observed on the `ModelTurnExecutor` itself: one `execute()` call is
 * exactly one Agent Step attempt and exactly one gateway stream.
 *
 * Phase 3C checkpoint 6 retired the legacy facade, so the script answers the frozen union
 * directly and the Run Layer composes the loop itself.
 */
function restartModelTurns(): FakeFrozenModelTurnExecutor {
  return fakeFrozenModelTurnExecutor((_request, _signal, callIndex) =>
    callIndex === 0
      ? modelTurnResult({
          text: "inspect",
          toolCalls: [{ id: "call_a", name: "read_file", input: { path: "parser.ts" } }],
          finishReason: "TOOL_CALLS",
        })
      : modelTurnResult({ text: "updated parser", finishReason: "STOP" }),
  );
}

function makeRun(workspacePath: string) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect parser",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: workspacePath },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
}

function createController(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  modelTurns: FakeFrozenModelTurnExecutor,
  now: { value: number },
): RunController {
  // The Run Layer composes the frozen AgentLoop itself: the test hands it the collaborator ports
  // a host would — the model catalog, the frozen turn executor, the Step identity factory and the
  // Context Engine. There is no facade, so no test-visible loop lifecycle can decide a Step.
  const execution = testRunAgentExecution({
    executor: modelTurns,
    createStepId: () => createStepId(),
  });
  return new RunController({
    agentExecution: execution.factory,
    executionStore: storage.execution,
    events: new EventBus(storage.events),
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic context is not durable conversation",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    clock: { now: () => createTimestampMs(now.value++) },
    eventIdFactory: { create: () => createEventId() },
    verificationPlanner,
  });
}

async function openRunDatabase(
  directory: string,
  run: ReturnType<typeof makeRun>,
): Promise<Awaited<ReturnType<typeof openCaelushStorage>>> {
  const storage = await openCaelushStorage({ path: path.join(directory, "caelush.sqlite") });
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  });
  await storage.runs.insert(run);
  return storage;
}

function assertWaiting(result: RunControllerResult) {
  expect(result.status).toBe("WAITING_TOOL_RESULTS");
  if (result.status !== "WAITING_TOOL_RESULTS") throw new Error("expected waiting result");
  return result;
}

describe("RunController file-backed restart recovery", () => {
  it("recovers tool and verification boundaries across real SQLite restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-phase-6c-"));
    await mkdir(path.join(directory, "project"));
    const run = makeRun(path.join(directory, "project"));
    const modelTurns = restartModelTurns();
    const now = { value: 10 };
    const firstStorage = await openRunDatabase(directory, run);
    const firstController = createController(firstStorage, modelTurns, now);

    const waiting = assertWaiting(await firstController.start(run.id));
    expect(waiting.toolRequests).toEqual([
      { externalCallId: "call_a", toolName: "read_file", args: { path: "parser.ts" } },
    ]);
    expect(modelTurns.callCount()).toBe(1);
    expect(
      (await firstStorage.messages.listByRun(run.id)).map((entry) => entry.message.role),
    ).toEqual(["user", "assistant"]);
    expect(await firstStorage.events.latestSequence(run.id)).toBe(5);
    await firstStorage.close();

    const secondStorage = await openCaelushStorage({
      path: path.join(directory, "caelush.sqlite"),
    });
    const secondController = createController(secondStorage, modelTurns, now);
    const recoveredWaiting = assertWaiting(await secondController.recover(run.id));
    expect(recoveredWaiting.toolRequests).toEqual(waiting.toolRequests);
    // Recovery performs zero provider turns: a stale RUNNING step is never resent.
    expect(modelTurns.callCount()).toBe(1);

    const final = await secondController.submitToolResults(run.id, [
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "updated parser",
        isError: false,
      },
    ]);
    expect(final.status).toBe("AWAITING_VERIFICATION");
    expect(modelTurns.callCount()).toBe(2);
    expect((await secondStorage.runs.get(run.id))?.finalResult).toBeUndefined();
    expect(
      (await secondStorage.messages.listByRun(run.id)).map((entry) => entry.message.role),
    ).toEqual(["user", "assistant", "tool", "assistant"]);
    await secondStorage.close();

    const thirdStorage = await openCaelushStorage({ path: path.join(directory, "caelush.sqlite") });
    const thirdController = createController(thirdStorage, modelTurns, now);
    const recoveredFinal = await thirdController.recover(run.id);
    expect(recoveredFinal.status).toBe("AWAITING_VERIFICATION");
    if (recoveredFinal.status !== "AWAITING_VERIFICATION")
      throw new Error("expected verification result");
    expect(recoveredFinal.candidateText).toBe("updated parser");
    expect(recoveredFinal.verificationPlanId).toBeDefined();
    expect(modelTurns.callCount()).toBe(2);
    const events = await thirdStorage.events.replay(run.id, { limit: 100 });
    expect(events.map((event) => event.durability.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.map((event) => event.type)).not.toContain("run.completed");
    expect(events.map((event) => event.type)).toContain("verification.planned");
    await thirdStorage.close();
    await rm(directory, { recursive: true, force: true });
  });
});
