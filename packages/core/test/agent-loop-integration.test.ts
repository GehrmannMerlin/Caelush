import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import {
  LLMGateway,
  LLMProviderRegistry,
  type LLMCapabilities,
  type LLMProvider,
  type LLMProviderCallContext,
  type LLMProviderRequest,
  type LLMStreamEvent,
} from "@caelush/llm";
import { describe, expect, it } from "vitest";
import {
  ContextBuilder,
  createLocalProjectInspector,
  createLocalRelevantFilePlanner,
} from "@caelush/context";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput } from "../src/agent-loop-input.js";
import type { AgentLoopDependencies } from "../src/agent-loop-ports.js";

const model = { provider: "fixture", model: "fixture-model" };
const capabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
};

class IntegrationProvider implements LLMProvider {
  readonly id = "fixture" as const;
  readonly observedRequests: LLMProviderRequest[] = [];
  toolExecutionCount = 0;

  supportsModel(candidate: typeof model): boolean {
    return candidate.provider === this.id;
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  async *stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.observedRequests.push(request);
    yield { type: "stream.start", payload: { callId: context.callId, providerId: this.id, model } };
    if (this.observedRequests.length === 1) {
      yield { type: "tool_call.start", payload: { toolCallId: "call_a", toolName: "read_file" } };
      yield {
        type: "tool_call.completed",
        payload: { id: "call_a", name: "read_file", input: { path: "src/parser.ts" } },
      };
      yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
      return;
    }
    yield { type: "text.delta", payload: { text: "parser fixed" } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
  }
}

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-loop-integration-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "AGENTS.md"), "Keep parser tests passing.\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  await writeFile(
    path.join(root, "src", "parser.ts"),
    `export function parse(value: string): boolean {\n  return value.length > 0;\n}\n${"// parser implementation context\n".repeat(30)}`,
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "parser.test.ts"),
    "test('parser', () => expect(parse('value')).toBe(true));\n",
    "utf8",
  );
  return root;
}

function makeInput(root: string): AgentLoopCommonInput {
  const pendingRun = AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "Fix parser behavior without breaking its tests.",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: root },
    model,
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
    baseSystemPrompt: "You are a careful coding agent.",
    contextLimits: { maxInputTokens: 4000, safetyMarginTokens: 0 },
    cwd: root,
    tools: [
      {
        name: "read_file",
        description: "Read a project file.",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
        riskLevel: "LOW",
        requiredCapabilities: ["FS_READ"],
        runtimeRequirements: {},
      },
    ],
  };
}

function dependencies(root: string, provider: IntegrationProvider): AgentLoopDependencies {
  const registry = new LLMProviderRegistry();
  registry.register(provider);
  const gateway = new LLMGateway({ providers: registry });
  return {
    inspector: createLocalProjectInspector(),
    planner: createLocalRelevantFilePlanner(),
    contextBuilder: new ContextBuilder(),
    llmClient: gateway,
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
  };
}

describe("real Context → Gateway resumable loop", () => {
  it("re-observes the fixture after the external tool boundary", async () => {
    const root = await makeFixture();
    try {
      const provider = new IntegrationProvider();
      const initial = makeInput(root);
      const loop = new AgentLoop(dependencies(root, provider));
      const first = await loop.run(initial);
      expect(first.status).toBe("OUTCOME");
      if (first.status !== "OUTCOME" || first.outcome.type !== "TOOL_CALLS_REQUESTED") {
        throw new Error("expected tool request");
      }
      expect(first.state.status).toBe("RUNNING");
      expect(first.state.usage.steps).toBe(1);
      expect(first.messagesToAppend.map((message) => message.role)).toEqual(["user", "assistant"]);

      const updated = `export function parse(value: string): boolean { return value.trim() !== ''; }\n${"// updated parser\n".repeat(30)}`;
      await writeFile(path.join(root, "src", "parser.ts"), updated, "utf8");
      const resumed = await loop.resumeWithToolResults({
        ...initial,
        state: first.state,
        history: first.messagesToAppend,
        pendingDecision: first.outcome,
        toolResults: [
          {
            role: "tool",
            toolCallId: "call_a",
            toolName: "read_file",
            content: updated,
            isError: false,
          },
        ],
      });
      expect(resumed.status).toBe("OUTCOME");
      if (resumed.status !== "OUTCOME") throw new Error("expected final outcome");
      expect(resumed.outcome.type).toBe("FINAL_CANDIDATE");
      expect(resumed.state.status).toBe("VERIFYING");
      expect(resumed.state.usage.steps).toBe(2);
      expect(provider.observedRequests).toHaveLength(2);
      expect(provider.toolExecutionCount).toBe(0);
      expect(resumed.messagesToAppend.map((message) => message.role)).toEqual([
        "tool",
        "assistant",
      ]);
      expect(
        provider.observedRequests[1]?.messages.some((message) => message.role === "tool"),
      ).toBe(true);
      expect(
        provider.observedRequests[1]?.messages.some(
          (message) => message.role === "user" && message.content.includes("updated parser"),
        ),
      ).toBe(true);
      expect(resumed.state.status).not.toBe("COMPLETED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
