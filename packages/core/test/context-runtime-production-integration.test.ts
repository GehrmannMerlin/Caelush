import type { LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import {
  AgentRunSchema,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ContextBuilder,
  ContextRuntimeCoordinator,
  Utf8HeuristicTokenEstimator,
} from "@caelush/context";
import {
  aiError,
  fakeModelTurnExecutor,
  modelTurnResult,
  testModelCatalog,
} from "./support/fake-model-turn-executor.js";
import type { AIModelRequest } from "@caelush/ai";
import { AgentLoop } from "../src/agent-loop.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";

function snapshot() {
  const root = "/repo";
  const workspace = { id: createWorkspaceId(), path: root };
  return {
    workspace: { workspace, logicalRoot: root, realRoot: root, cwd: root, realCwd: root },
    projectRoot: { projectRoot: root, reason: "CWD_FALLBACK" as const },
    environment: {
      platform: "linux" as const,
      arch: "x64",
      hostNodeVersion: "v24.0.0",
      pathStyle: "POSIX" as const,
      workspaceRoot: root,
      projectRoot: root,
      cwd: root,
    },
    profile: {
      ecosystems: [],
      languageSignals: [],
      manifestEvidence: [],
      packageManager: { name: "UNKNOWN" as const, evidencePaths: [] },
      tooling: [],
      isMonorepo: false,
      monorepoEvidence: [],
    },
    instructions: { entries: [], totalBytes: 0, maxBytes: 0 },
    diagnostics: [],
  };
}

function toolTurn(content: string, rawArtifactRef: string): readonly LLMMessage[] {
  return [
    { role: "user", content: "inspect the workspace" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "large.txt" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content,
      isError: false,
      rawArtifactRef,
    } satisfies LLMToolResultMessage,
  ];
}

describe("Context Runtime production integration", () => {
  it("uses the durable raw observation when the real builder must recover an open turn", async () => {
    const raw = "raw-head-" + "x".repeat(100_000) + "-raw-tail";
    const loaded: string[] = [];
    const coordinator = new ContextRuntimeCoordinator({
      builder: new ContextBuilder({ tokenEstimator: new Utf8HeuristicTokenEstimator() }),
      rawObservationLoader: async ({ runId, artifactRef }) => {
        expect(runId).toBe("run-production-context");
        loaded.push(artifactRef);
        return raw;
      },
    });

    const result = await coordinator.prepareModelContext({
      runId: "run-production-context",
      providerId: "fixture",
      modelId: "fixture-model",
      context: {
        mode: "TOOL_CONTINUATION",
        baseSystemPrompt: "inspect the workspace",
        snapshot: snapshot(),
        history: [],
        currentTurnMessages: toolTurn("bounded placeholder ".repeat(5_000), "artifact:raw-1"),
        limits: { maxInputTokens: 2_000 },
      },
      signal: new AbortController().signal,
    });

    expect(loaded).toEqual(["artifact:raw-1"]);
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("raw-head-");
    expect(toolMessage?.content).toContain("raw-tail");
    expect(toolMessage?.content.length).toBeLessThan(raw.length);
  });

  it("rebuilds a real provider request after overflow using closed history", async () => {
    const pendingRun = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "continue the workspace task",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: "/repo" },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "fixture" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
      createdAt: createTimestampMs(1),
    });
    const run = { ...pendingRun, status: "RUNNING" as const, startedAt: createTimestampMs(2) };
    const state = startAgentState(
      createInitialAgentState(pendingRun, createTimestampMs(1)),
      createTimestampMs(2),
    );
    const history: readonly LLMMessage[] = [
      { role: "user", content: "previous task" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "previous-call",
            toolName: "read_file",
            input: { path: "previous.txt" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "previous-call",
        toolName: "read_file",
        content: "previous result",
        isError: false,
      },
    ];
    const coordinator = new ContextRuntimeCoordinator({
      builder: new ContextBuilder({ tokenEstimator: new Utf8HeuristicTokenEstimator() }),
      checkpointRepository: {
        getLatestByRun: async () => undefined,
        create: async (input) => ({ ...input, schemaVersion: 1 }),
      },
    });
    const requests: AIModelRequest["messages"][] = [];
    let calls = 0;
    const loop = new AgentLoop({
      inspector: { inspect: async () => snapshot() },
      planner: { plan: async () => undefined as never },
      contextBuilder: { build: () => ({ messages: [], report: {} as never }) },
      contextRuntime: coordinator,
      models: testModelCatalog(),
      modelTurns: fakeModelTurnExecutor(async (request) => {
        requests.push(request.messages);
        calls += 1;
        if (calls === 1) throw aiError("AI_CONTEXT_OVERFLOW");
        return modelTurnResult({
          callId: createLLMCallId(),
          providerId: "fixture",
          model: { provider: "fixture", model: "fixture-model" },
          text: "done",
          toolCalls: [],
          finishReason: "STOP",
        });
      }),
      clock: { now: () => createTimestampMs(3) },
      stepIdFactory: { create: () => createStepId() },
    });

    const result = await loop.run({
      run,
      state,
      history,
      baseSystemPrompt: "inspect the workspace",
      contextLimits: { maxInputTokens: 2_000 },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("OUTCOME");
    expect(calls).toBe(2);
    expect(requests[1]).not.toEqual(requests[0]);
    expect(coordinator.getContextUsage(run.id)?.compactionCount).toBeGreaterThan(0);
  });
});
