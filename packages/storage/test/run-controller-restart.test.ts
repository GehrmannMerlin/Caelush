import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  ToolDefinitionSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { AgentLoop, RunController, type RunControllerResult } from "@caelush/core";
import {
  LLMGateway,
  LLMProviderRegistry,
  type LLMCapabilities,
  type LLMProvider,
  type LLMProviderCallContext,
  type LLMProviderRequest,
  type LLMStreamEvent,
} from "@caelush/llm";
import { EventBus } from "@caelush/events";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

const capabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
};

class RestartProvider implements LLMProvider {
  readonly id = "fixture" as const;
  callCount = 0;

  supportsModel(model: { provider: string }): boolean {
    return model.provider === this.id;
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  async *stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.callCount += 1;
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
    if (this.callCount === 1) {
      yield { type: "text.delta", payload: { text: "inspect" } };
      yield { type: "tool_call.start", payload: { toolCallId: "call_a", toolName: "read_file" } };
      yield {
        type: "tool_call.completed",
        payload: { id: "call_a", name: "read_file", input: { path: "parser.ts" } },
      };
      yield { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } };
      return;
    }
    yield { type: "text.delta", payload: { text: "updated parser" } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
  }
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
  provider: RestartProvider,
  now: { value: number },
): RunController {
  const registry = new LLMProviderRegistry();
  registry.register(provider);
  const gateway = new LLMGateway({ providers: registry });
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
    llmClient: { complete: (request) => gateway.complete(request) },
    clock: { now: () => createTimestampMs(now.value++) },
    stepIdFactory: { create: () => createStepId() },
  });
  return new RunController({
    agentLoop: loop,
    execution: storage.execution,
    events: new EventBus(storage.events),
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic context is not durable conversation",
        contextLimits: { maxInputTokens: 1000 },
        tools: [
          ToolDefinitionSchema.parse({
            name: "read_file",
            description: "Read a project file",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            riskLevel: "LOW",
            requiredCapabilities: [],
            runtimeRequirements: {},
          }),
        ],
      }),
    },
    clock: { now: () => createTimestampMs(now.value++) },
    eventIdFactory: { create: () => createEventId() },
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
    const provider = new RestartProvider();
    const now = { value: 10 };
    const firstStorage = await openRunDatabase(directory, run);
    const firstController = createController(firstStorage, provider, now);

    const waiting = assertWaiting(await firstController.start(run.id));
    expect(waiting.toolRequests).toEqual([
      { externalCallId: "call_a", toolName: "read_file", args: { path: "parser.ts" } },
    ]);
    expect(provider.callCount).toBe(1);
    expect(
      (await firstStorage.messages.listByRun(run.id)).map((entry) => entry.message.role),
    ).toEqual(["user", "assistant"]);
    expect(await firstStorage.events.latestSequence(run.id)).toBe(5);
    await firstStorage.close();

    const secondStorage = await openCaelushStorage({
      path: path.join(directory, "caelush.sqlite"),
    });
    const secondController = createController(secondStorage, provider, now);
    const recoveredWaiting = assertWaiting(await secondController.recover(run.id));
    expect(recoveredWaiting.toolRequests).toEqual(waiting.toolRequests);
    expect(provider.callCount).toBe(1);

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
    expect(provider.callCount).toBe(2);
    expect((await secondStorage.runs.get(run.id))?.finalResult).toBeUndefined();
    expect(
      (await secondStorage.messages.listByRun(run.id)).map((entry) => entry.message.role),
    ).toEqual(["user", "assistant", "tool", "assistant"]);
    await secondStorage.close();

    const thirdStorage = await openCaelushStorage({ path: path.join(directory, "caelush.sqlite") });
    const thirdController = createController(thirdStorage, provider, now);
    const recoveredFinal = await thirdController.recover(run.id);
    expect(recoveredFinal.status).toBe("AWAITING_VERIFICATION");
    if (recoveredFinal.status !== "AWAITING_VERIFICATION")
      throw new Error("expected verification result");
    expect(recoveredFinal.candidateText).toBe("updated parser");
    expect(provider.callCount).toBe(2);
    const events = await thirdStorage.events.replay(run.id, { limit: 100 });
    expect(events.map((event) => event.durability.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.map((event) => event.type)).not.toContain("run.completed");
    await thirdStorage.close();
    await rm(directory, { recursive: true, force: true });
  });
});
