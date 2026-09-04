import { createApprovalRequestId, createEventId, createObservationId, createRunId, createSessionId, createStepId, createTimestampMs, createToolInvocationId, createWorkspaceId, AgentRunSchema } from "@caelush/protocol";
import { AgentLoop, RunController } from "@caelush/core";
import { EventBus } from "@caelush/events";
import { createOpenAICompatibleLLMProvider, LLMGateway, LLMProviderRegistry } from "@caelush/llm";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import {
  ToolBatchCoordinator,
  ToolDispatcher,
  ToolRegistryBuilder,
  createReadOnlyFilesystemToolRegistrations,
  type ToolCommittedEventNotifier,
} from "@caelush/tools";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { verificationPlanner } from "./support/fixtures.js";

function openAIChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly delta: Record<string, unknown>;
  readonly finishReason?: string | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: 1,
    model: input.model,
    choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason ?? null }],
  };
}

function toolCallDelta(input: {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}): Record<string, unknown> {
  return {
    index: input.index,
    type: "function",
    function: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
    },
    ...(input.id === undefined ? {} : { id: input.id }),
  };
}

function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeRun(workspace: string) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect the workspace",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: workspace },
    model: { provider: "deepseek-compatible", model: "deepseek-chat" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
    createdAt: createTimestampMs(1),
  });
}

describe("real provider Tool Call round trip", () => {
  it("carries the provider toolCallId into the next provider request after Dispatcher settlement", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const run = makeRun(process.cwd());
    await storage.sessions.insert({
      id: run.sessionId,
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
      metadata: {},
    });
    await storage.runs.insert(run);

    const requests: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
    let responseNumber = 0;
    const provider = createOpenAICompatibleLLMProvider({
      id: "deepseek-compatible",
      baseURL: "http://127.0.0.1:4321/v1",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push((await request.clone().json()) as { messages: unknown[]; tools?: unknown[] });
        responseNumber += 1;
        if (responseNumber === 1) {
          return sseResponse([
            openAIChunk({
              id: "chatcmpl-tool-round-trip",
              model: "deepseek-chat",
              delta: {
                role: "assistant",
                tool_calls: [
                  toolCallDelta({
                    index: 0,
                    id: "call-list-root",
                    name: "list_directory",
                    arguments: '{"path":"."}',
                  }),
                ],
              },
            }),
            openAIChunk({
              id: "chatcmpl-tool-round-trip",
              model: "deepseek-chat",
              delta: {},
              finishReason: "tool_calls",
            }),
          ]);
        }
        return sseResponse([
          openAIChunk({
            id: "chatcmpl-final-round-trip",
            model: "deepseek-chat",
            delta: { role: "assistant", content: "Workspace inspected." },
          }),
          openAIChunk({
            id: "chatcmpl-final-round-trip",
            model: "deepseek-chat",
            delta: {},
            finishReason: "stop",
          }),
        ]);
      },
    });
    const providers = new LLMProviderRegistry();
    providers.register(provider);
    const gateway = new LLMGateway({ providers });

    const eventBus = new EventBus(storage.events);
    const registryBuilder = new ToolRegistryBuilder();
    for (const registration of createReadOnlyFilesystemToolRegistrations(
      createLocalRuntimeResolver(new LocalRuntime()),
    )) {
      registryBuilder.register(registration);
    }
    const notifier: ToolCommittedEventNotifier = {
      notifyCommitted: (events) => eventBus.notifyCommitted(events),
    };
    let now = Date.now();
    const registry = registryBuilder.build();
    const dispatcher = new ToolDispatcher({
      registry,
      store: storage.toolExecution,
      gate: { decide: async () => ({ kind: "ALLOW" as const }) },
      notifier,
      clock: { now: () => createTimestampMs(++now) },
      invocationIdFactory: { create: createToolInvocationId },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      resultSanitizer: { sanitize: ({ result }) => result },
      approvalStore: storage.approvals,
      approvalIdFactory: { create: createApprovalRequestId },
    });
    const coordinator = new ToolBatchCoordinator(dispatcher);
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
      llmClient: { complete: (request, options) => gateway.complete(request, options) },
      clock: { now: () => createTimestampMs(Date.now()) },
      stepIdFactory: { create: () => createStepId() },
    });
    const controller = new RunController({
      agentLoop: loop,
      execution: storage.execution,
      events: eventBus,
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "Inspect the workspace.",
          contextLimits: { maxInputTokens: 2_000 },
        }),
      },
      toolCoordinator: coordinator,
      clock: { now: () => createTimestampMs(Date.now()) },
      eventIdFactory: { create: createEventId },
      verificationPlanner,
    });

    try {
      const result = await controller.start(run.id);

      expect(result.status).toBe("AWAITING_VERIFICATION");
      expect(responseNumber).toBe(2);
      expect(requests).toHaveLength(2);
      const secondMessages = requests[1]?.messages ?? [];
      expect(secondMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: [
              expect.objectContaining({
                id: "call-list-root",
                function: expect.objectContaining({ name: "list_directory" }),
              }),
            ],
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-list-root",
          }),
        ]),
      );
      expect((await storage.toolInvocations.listByRun(run.id)).map((item) => item.status)).toEqual([
        "COMPLETED",
      ]);
      expect(await storage.observations.listByRun(run.id)).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });
});
