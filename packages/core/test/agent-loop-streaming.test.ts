import type { AIGateway, AIStream, AIStreamEvent, AIModelTurnResult } from "@caelush/ai";
import type {
  AgentExecutionIdentity,
  AgentTransientStreamEvent,
  ModelTurnStreamSink,
} from "@caelush/agent";
import { createModelTurnExecutor } from "@caelush/agent";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";
import { createLegacyModelTurnExecutor } from "../src/legacy-model-turn-executor.js";
import { testModelCatalog } from "./support/fake-model-turn-executor.js";

/**
 * Transient streaming through the Core composition.
 *
 * The frozen `AgentLoop.advance()` has no `streamSink` input. Streaming is a
 * `ModelTurnExecutor` concern, and the composition binds it by decorating the executor — which
 * is what this file proves: a Run driven through the Core facade reaches the real frozen executor
 * with the sink attached, and every delta carries the correlation the host needs.
 */

const CALL_ID = "llm_0195f3a0-0000-7000-8000-000000000000";
const STEP_ID = "stp_0195f3a0-0000-7000-8000-000000000000";

const RESOLUTION = {
  api: "test-api",
  reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
  cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
} as const;

/** A gateway that plays one scripted turn and counts invocations. */
function gateway(): { readonly gateway: AIGateway; calls(): number } {
  let calls = 0;
  const script: readonly AIStreamEvent[] = [
    {
      type: "stream.start",
      payload: {
        callId: CALL_ID as never,
        providerId: "fixture",
        model: { provider: "fixture", model: "fixture-model" },
        resolution: RESOLUTION as never,
      },
    },
    { type: "text.delta", payload: { text: "hel" } },
    { type: "reasoning.summary.delta", payload: { text: "thinking" } },
    { type: "text.delta", payload: { text: "lo" } },
    { type: "usage", payload: { inputTokens: 3 } },
    { type: "stream.finish", payload: { finishReason: "STOP" } },
  ];

  return {
    gateway: {
      stream(): Promise<AIStream> {
        calls += 1;
        return Promise.resolve({
          callId: CALL_ID as never,
          events: (async function* generate(): AsyncGenerator<AIStreamEvent> {
            for (const event of script) yield event;
          })(),
        });
      },
      complete(): Promise<AIModelTurnResult> {
        return Promise.reject(new Error("the streaming path must stream"));
      },
    },
    calls: () => calls,
  };
}

const IDENTITY: AgentExecutionIdentity = {
  runId: "run_0195f3a0-0000-7000-8000-000000000000" as never,
  sessionId: "ses_0195f3a0-0000-7000-8000-000000000000" as never,
  goal: "stream the answer",
};

function input(): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "stream the answer",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(0),
  });
  return {
    run: { ...pendingRun, status: "RUNNING", startedAt: createTimestampMs(0) },
    state: startAgentState(
      createInitialAgentState(pendingRun, createTimestampMs(0)),
      createTimestampMs(0),
    ),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal: new AbortController().signal,
  };
}

describe("Core transient streaming binding", () => {
  it("reaches the frozen executor with the configured sink and correlated deltas", async () => {
    const ai = gateway();
    const seen: AgentTransientStreamEvent[] = [];
    const sink: ModelTurnStreamSink = {
      publish(event): void {
        seen.push(event);
      },
    };

    // The composition the Core facade decorates: the legacy throw-based seam over the real frozen
    // executor, which is what actually projects provider deltas.
    const modelTurns = createLegacyModelTurnExecutor({
      executor: createModelTurnExecutor({ gateway: ai.gateway }),
      identity: () => IDENTITY,
      createStepId: () => STEP_ID as never,
    });

    const dependencies: AgentLoopDependencies = {
      inspector: { inspect: async () => ({}) as never },
      planner: { plan: async () => ({}) as never },
      contextBuilder: {
        build: () => ({ messages: [{ role: "user", content: "context" }], report: {} as never }),
      },
      models: testModelCatalog(),
      modelTurns,
      streamSink: sink,
      clock: { now: () => createTimestampMs(10) },
      stepIdFactory: { create: () => createStepId() },
    };

    const result = await new AgentLoop(dependencies).run(input());

    expect(result.status).toBe("OUTCOME");
    expect(ai.calls()).toBe(1);
    // Only the transient deltas crossed, and each one is correlated to the turn that produced it.
    // The envelope, the usage event and the tool-call lifecycle stayed out.
    expect(seen).toEqual([
      { type: "text.delta", runId: IDENTITY.runId, stepId: STEP_ID, text: "hel" },
      { type: "thinking.delta", runId: IDENTITY.runId, stepId: STEP_ID, text: "thinking" },
      { type: "text.delta", runId: IDENTITY.runId, stepId: STEP_ID, text: "lo" },
    ]);
    // Nothing transient became durable: the settled result is the only assistant content.
    expect(result.messagesToAppend.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("performs no provider work and publishes nothing when no sink is configured", async () => {
    const ai = gateway();
    const modelTurns = createLegacyModelTurnExecutor({
      executor: createModelTurnExecutor({ gateway: ai.gateway }),
      identity: () => IDENTITY,
      createStepId: () => STEP_ID as never,
    });

    const dependencies: AgentLoopDependencies = {
      inspector: { inspect: async () => ({}) as never },
      planner: { plan: async () => ({}) as never },
      contextBuilder: {
        build: () => ({ messages: [{ role: "user", content: "context" }], report: {} as never }),
      },
      models: testModelCatalog(),
      modelTurns,
      clock: { now: () => createTimestampMs(10) },
      stepIdFactory: { create: () => createStepId() },
    };

    const result = await new AgentLoop(dependencies).run(input());

    // A host without presentation still gets exactly the same durable outcome.
    expect(result.status).toBe("OUTCOME");
    expect(ai.calls()).toBe(1);
  });
});
