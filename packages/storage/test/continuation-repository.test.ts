import { describe, expect, it } from "vitest";
import {
  createLLMCallId,
  createStepId,
  createTimestampMs,
  type RunId,
  type StepId,
} from "@caelush/protocol";
import type { WaitingRetryContinuation, WaitingToolResultsContinuation } from "@caelush/core";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

function waitingCheckpoint(runId: RunId, sourceStepId: StepId): WaitingToolResultsContinuation {
  return {
    type: "WAITING_TOOL_RESULTS" as const,
    runId,
    sourceStepId,
    pendingDecision: {
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
              toolCallId: "call_a",
              toolName: "read_file" as const,
              input: { path: "src/index.ts" },
            },
          ],
        },
      },
      toolRequests: [
        {
          externalCallId: "call_a",
          toolName: "read_file" as const,
          args: { path: "src/index.ts" },
        },
      ],
    },
  };
}

describe("ContinuationRepository", () => {
  it("maps a WAITING_RETRY failedStepId to the legacy source-step index", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(1) });
    const step = makeStep(run.id, {
      status: "FAILED",
      finishedAt: createTimestampMs(2),
    });
    const checkpoint: WaitingRetryContinuation = {
      type: "WAITING_RETRY",
      runId: run.id,
      failedStepId: step.id,
      attempt: 2,
      maxAttempts: 3,
      nextAttemptAt: createTimestampMs(1_000),
      errorCode: "LLM_NETWORK",
      mode: "START",
    };
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);

    await storage.continuations.set(run.id, checkpoint, createTimestampMs(3), null);

    expect(await storage.continuations.get(run.id)).toMatchObject({ checkpoint });
    await storage.close();
  });

  it("persists, versions, reads, and clears a continuation checkpoint", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id);
    const step = makeStep(run.id, { id: createStepId() });
    const checkpoint = waitingCheckpoint(run.id, step.id);
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);

    const first = await storage.continuations.set(run.id, checkpoint, createTimestampMs(100), null);
    expect(first.revision).toBe(1);
    expect(await storage.continuations.get(run.id)).toEqual({
      checkpoint,
      revision: 1,
      updatedAt: createTimestampMs(100),
    });

    const second = await storage.continuations.set(
      run.id,
      {
        ...checkpoint,
        receivedResults: [
          {
            role: "tool",
            toolCallId: "call_a",
            toolName: "read_file",
            content: "ok",
            isError: false,
          },
        ],
      },
      createTimestampMs(101),
      1,
    );
    expect(second.revision).toBe(2);
    await expect(
      storage.continuations.set(run.id, checkpoint, createTimestampMs(102), 1),
    ).rejects.toThrow();

    await storage.continuations.clear(run.id, 2);
    expect(await storage.continuations.get(run.id)).toBeNull();
    await storage.close();
  });

  it("fails closed when a stored checkpoint is corrupted", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id);
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    expect(storage.continuations).toBeDefined();
    await storage.close();
  });
});
