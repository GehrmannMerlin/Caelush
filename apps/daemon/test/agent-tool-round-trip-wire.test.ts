import { createHash } from "node:crypto";

import {
  AgentRunSchema,
  createApprovalRequestId,
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationPlanId,
  createWorkspaceId,
} from "@caelush/protocol";
import type { VerificationPlanDraft } from "@caelush/protocol";
import { RunController } from "@caelush/core";
import type { RunAgentExecutionContextFactory } from "@caelush/core";
import { testRunMessageAuthority } from "../../../packages/core/test/support/run-message-authority.js";
import {
  boundToolResultContent,
  createDurableToolExecutionCoordinator,
  createModelToolFeedbackProjector,
  createToolAdmissionCoordinator,
  createToolBatchCoordinator,
  createToolCallPreparer,
  createToolFailureSettlement,
  createToolInvocationExecutor,
  createToolResultBatchNormalizer,
  createToolResultPipeline,
  AGENT_CONTEXT_SOURCE_IDS,
  createContextItemId,
  createContextMaterializer,
  createContextReceiptBuilder,
  createContextSourceItem,
  createContextSourceRegistryBuilder,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createV2ContextEngine,
  createConversationContextSourceProvider,
  createCorePolicyContextSourceProvider,
  UNBOUNDED_TOOL_BUDGET_ADMISSION,
  type AgentToolRegistry,
  type DurableToolExecutionCoordinator,
  type PreparedToolCall,
} from "@caelush/agent";
import { createModelTurnExecutor } from "@caelush/agent";
import { createAISubsystem } from "@caelush/ai";
import type { AIProviderBinding, ApiAdapter, ModelDescriptorSourcePort } from "@caelush/ai";
import { createOpenAICompatibleApiAdapter } from "@caelush/ai/adapters/openai-compatible";
import {
  assertDefaultBuiltinSecurityCoverage,
  CaelushToolExecutionUpdateSanitizer,
  createDefaultV1ToolExecutionSecurity,
  expandPermissionPreset,
  createV1ToolApprovalRequestFactory,
  DISCARDING_TOOL_UPDATE_CONSUMER,
} from "@caelush/security";
import {
  createCodingToolAdmissionPort,
  createCodingToolDurableMetadataPort,
  createCodingToolSettlementExtensionProjector,
  createDurableInvocationGatePort,
} from "@caelush/coding-agent";
import { sanitizeTerminalOutput } from "@caelush/runtime";
import { openCaelushStorage } from "@caelush/storage";
import { toContextObservationProjection } from "@caelush/core";
import { describe, expect, it } from "vitest";

import { createCodingToolComposition } from "./support/coding-tool-composition.js";
import { RunEventHub } from "../src/events/run-event-hub.js";

/**
 * The Tool-call round trip over a real OpenAI-shaped wire.
 *
 * Phase 2C cut the production model path over to the AI core, so this test drives the
 * *production* chain end to end:
 *
 * ```text
 * RunController → AgentLoop → ModelTurnExecutor → AIGateway.stream()
 *   → createOpenAICompatibleApiAdapter() → @ai-sdk/openai-compatible → fetch
 * ```
 *
 * The transport is the only stub: a `fetch` that answers with real SSE. Everything else — gateway,
 * model catalog, provider registry, stream validator, turn assembler, the canonical Tool registry over
 * the ten Coding Tools, the real Security gate and result sanitizer, the durable Tool execution
 * coordinator, the Tool batch and the durable settlement — is the production implementation.
 *
 * Phase 4F retired the legacy `ToolDispatcher` this test used to compose. The wiring below mirrors
 * `apps/daemon/src/daemon-composition.ts` with the same canonical factories, so what the round trip
 * travels through is the composition the daemon actually builds.
 */

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
    securityPolicy: expandPermissionPreset({
      presetId: "VIEW_ONLY",
      expectedVersion: 1,
      createdAt: new Date(1).toISOString(),
    }),
    // The current VIEW_ONLY preset is immutable and carries ON_BOUNDARY approval policy.
    approvalPolicy: "ON_BOUNDARY",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
    createdAt: createTimestampMs(1),
  });
}

const verificationPlanner = {
  plan: ({
    runId,
    sourceStepId,
  }: Pick<VerificationPlanDraft, "runId" | "sourceStepId">): VerificationPlanDraft => ({
    runId,
    sourceStepId,
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: [
      {
        ordinal: 0,
        stage: "ACCEPTANCE",
        requirement: "REQUIRED",
        spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
      },
    ],
  }),
};

/**
 * Project durable invocation state back onto the canonical prepared call.
 *
 * The canonical registry resolved the Tool at registration and the arguments come from the durable
 * invocation itself, so nothing is resolved, normalized or validated a second time here. This is the
 * same projection `daemon-composition.ts` makes.
 */
function preparedCallFromDurableState(
  registry: AgentToolRegistry,
  invocation: import("@caelush/protocol").ToolInvocation,
  externalCallId: string,
): PreparedToolCall {
  const resolved = registry.resolve(invocation.toolName);
  if (resolved === undefined) {
    throw new Error(
      `The canonical Tool entry "${invocation.toolName}" is unavailable for execution.`,
    );
  }
  return Object.freeze({
    request: Object.freeze({
      externalCallId,
      toolName: invocation.toolName,
      args: invocation.args,
    }),
    resolved,
    args: invocation.args,
  });
}

describe("real provider Tool Call round trip", () => {
  it("carries the provider toolCallId into the next provider request after settlement", async () => {
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
    const modelFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
    };

    const descriptorSource: ModelDescriptorSourcePort & {
      list(): readonly import("@caelush/ai").ModelDescriptor[];
    } = {
      id: "daemon-wire-fixture",
      priority: 0,
      resolve: (ref) =>
        ref.provider === "deepseek-compatible" && ref.model === "deepseek-chat"
          ? {
              ref,
              api: "openai-compatible-chat",
              limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
              capabilities: {
                streaming: "SUPPORTED",
                toolCalling: "SUPPORTED",
                parallelToolCalls: "SUPPORTED",
                structuredOutput: "UNKNOWN",
                vision: "UNKNOWN",
                reasoning: "UNKNOWN",
                reasoningSummary: "UNKNOWN",
                promptCaching: "UNKNOWN",
                usageReporting: "UNKNOWN",
              },
              source: "CONFIGURATION",
            }
          : undefined,
      list: () => [],
    };
    const binding: AIProviderBinding = {
      id: "deepseek-compatible",
      endpoint: "http://127.0.0.1:4321/v1",
      defaultApi: "openai-compatible-chat",
      allowUnknownModels: true,
      credentials: { resolve: async () => ({ apiKey: "wire-fixture" }) },
      transport: { fetch: modelFetch as unknown as typeof globalThis.fetch },
    };
    const ai = createAISubsystem({
      modelSources: [descriptorSource],
      providers: [binding],
      adapters: [createOpenAICompatibleApiAdapter() as ApiAdapter],
    });

    const eventHub = new RunEventHub(storage.eventReader);
    const contextClock = { now: () => createTimestampMs(Date.now()) };
    const contextTokenEstimator = createUtf8HeuristicTokenEstimator();
    const contextInputKinds: string[] = [];
    const contextSourceRegistry = createContextSourceRegistryBuilder()
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.corePolicy,
        priority: 0,
        criticality: "REQUIRED",
        provider: createCorePolicyContextSourceProvider({ text: "Inspect the workspace." }),
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.conversation,
        priority: 10,
        criticality: "REQUIRED",
        provider: createConversationContextSourceProvider(),
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.branchContext,
        priority: 20,
        criticality: "REQUIRED",
        provider: {
          id: AGENT_CONTEXT_SOURCE_IDS.branchContext,
          async collect(input) {
            contextInputKinds.push(input.input.kind);
            const text =
              input.input.kind === "TOOL_RESULTS"
                ? "runtime status after tool execution"
                : "runtime status before tool execution";
            return {
              providerId: AGENT_CONTEXT_SOURCE_IDS.branchContext,
              providerVersion: "tool-round-trip.v1",
              items: [
                createContextSourceItem({
                  id: createContextItemId("agent.branch-context:tool-round-trip"),
                  type: "agent.branch-context",
                  source: {
                    providerId: AGENT_CONTEXT_SOURCE_IDS.branchContext,
                    sourceRef: "tool-round-trip-runtime",
                    version: "v1",
                  },
                  scope: "RUN",
                  retention: "RETRIEVABLE",
                  priorityClass: "LOW",
                  tokenEstimate: 12,
                  cacheStability: "DYNAMIC",
                  freshness: "CURRENT",
                  sensitivity: "INTERNAL",
                  whyLoaded: "controlled local Tool round-trip fixture",
                  payload: { kind: "TEXT", text },
                }),
              ],
              diagnostics: [],
            };
          },
        },
      })
      .build();
    const contextEngine = createV2ContextEngine({
      promptSurfaceStore: storage.promptSurface,
      sourceRegistry: contextSourceRegistry,
      checkpointRepository: storage.contextCheckpointsV2,
      authorityProvider: {
        async snapshot() {
          return { goal: "inspect the workspace" };
        },
      },
      usageStore: storage.contextUsage,
      materializer: createContextMaterializer({
        projectors: createStandardAgentMessageProjectorRegistry(),
        tokenEstimator: contextTokenEstimator,
      }),
      receiptBuilder: createContextReceiptBuilder({
        now: contextClock.now,
        tokenEstimator: contextTokenEstimator,
      }),
      clock: contextClock,
    });
    /**
     * The production Tool composition.
     *
     * ```text
     * Runtime Operations adapters      → the ten Coding Tool definitions
     * DefaultAgentToolRegistryBuilder  → the canonical AgentToolRegistry
     * CodingToolCatalogBuilder         → the Coding overlay, aligned to that registry
     * createDefaultV1ToolExecutionSecurity → the real gate, result sanitizer and presentation
     * createDurableToolExecutionCoordinator → the durable invocation lifecycle
     *        ↓
     * canonical ToolBatchCoordinator   → the Run Layer
     * ```
     */
    const { registry, catalog, definitions } = createCodingToolComposition();
    const toolSecurity = createDefaultV1ToolExecutionSecurity({
      terminalOutputSanitizer: sanitizeTerminalOutput,
    });
    let now = Date.now();
    const clock = { now: () => createTimestampMs(++now) };
    const gate = createDurableInvocationGatePort({
      gate: toolSecurity.gate,
      invocations: {
        resolve: async (request) =>
          (await storage.toolExecution.load(request.invocationId as never))?.invocation,
      },
    });
    const toolApprovalRequests = createV1ToolApprovalRequestFactory({
      registry,
      catalog,
      gate,
      approvalIdFactory: { create: createApprovalRequestId },
    });
    // The startup self-check the production root runs: every Tool this host offers is described by the
    // Coding catalog and executable by the registry it built.
    assertDefaultBuiltinSecurityCoverage(
      registry,
      catalog,
      definitions.map((definition) => definition.tool.name),
    );
    const toolAdmission = createToolAdmissionCoordinator({
      policy: createCodingToolAdmissionPort({
        gate,
        registry,
        catalog,
        approvalPresentation: (decision) => decision.safeAction,
      }),
      approvals: storage.approvals,
      approvalRequests: toolApprovalRequests,
      budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
      clock,
      eventIdFactory: { create: createEventId },
    });
    const toolDurableCoordinator: DurableToolExecutionCoordinator =
      createDurableToolExecutionCoordinator({
        store: storage.toolExecution,
        admission: toolAdmission,
        metadata: createCodingToolDurableMetadataPort({ registry, catalog }),
        approvalRequests: toolApprovalRequests,
        approvalLookup: storage.approvals,
        invocationIdFactory: { create: createToolInvocationId },
        observationIdFactory: { create: createObservationId },
        eventIdFactory: { create: createEventId },
        clock,
        invocationExecutorFactory: ({ invocation, updateSanitizer }) =>
          createToolInvocationExecutor({
            invocation,
            updateSanitizer,
            transientUpdates: DISCARDING_TOOL_UPDATE_CONSUMER,
          }),
        updateSanitizer: new CaelushToolExecutionUpdateSanitizer(),
        resultPipelineFactory: ({ invocation, environment, sessionId }) =>
          createToolResultPipeline({
            sanitizer: toolSecurity.resultSanitizer,
            settlementExtension: createCodingToolSettlementExtensionProjector({
              catalog,
              invocation: {
                invocation,
                ...(sessionId === undefined ? {} : { sessionId }),
                environment,
                nextEventId: () => createEventId(),
                presentation: toolSecurity.presentation,
              },
            }),
          }),
        preparedCallFactory: ({ invocation, externalCallId }) =>
          preparedCallFromDurableState(registry, invocation, externalCallId),
        failureSettlement: createToolFailureSettlement({
          store: storage.toolExecution,
          clock,
          observationIdFactory: { create: createObservationId },
          eventIdFactory: { create: createEventId },
          presentation: toolSecurity.presentation,
          boundContent: (content) => boundToolResultContent(content),
          notifier: eventHub,
        }),
        presentation: toolSecurity.presentation,
        notifier: eventHub,
        boundFailureContent: (content) => boundToolResultContent(content),
      });
    // The canonical Tool turn pipeline: the canonical durable coordinator drives the batch, and the
    // projector and normalizer beside it are the production canonical ones.
    const toolTurn = {
      batches: createToolBatchCoordinator({
        preparer: createToolCallPreparer(registry),
        budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
        durable: toolDurableCoordinator,
        registry,
      }),
      feedback: createModelToolFeedbackProjector({
        projection: toContextObservationProjection(),
      }),
      normalizer: createToolResultBatchNormalizer(),
      modelSpecs: () => registry.modelSpecs(),
    };
    /**
     * The Run Layer's direct Agent execution dependencies.
     *
     * Phase 3C checkpoint 6 retired the legacy Core `AgentLoop` from this path: the controller
     * composes the frozen loop itself and drives it through the frozen execution driver, so this
     * test hands it the frozen collaborator ports — exactly as the production daemon does.
     */
    const agentExecution: RunAgentExecutionContextFactory = {
      async resolve() {
        return {
          models: ai.models,
          modelTurnExecutor: createModelTurnExecutor({ gateway: ai.gateway }),
          stepIds: { create: () => createStepId() },
          tools: [],
          createContextEngine: () => contextEngine,
        };
      },
    };
    const controller = new RunController({
      agentExecution,
      executionStore: storage.execution,
      messages: testRunMessageAuthority({
        records: (runId) => storage.messageRecords.listByRun(runId),
      }),
      completionStore: storage.execution,
      events: eventHub,
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "Inspect the workspace.",
          contextLimits: { maxInputTokens: 2_000 },
        }),
      },
      toolTurn,
      clock: { now: () => createTimestampMs(Date.now()) },
      eventIdFactory: { create: createEventId },
      completion: {
        gateId: "tool-round-trip-wire-test",
        openEvaluation() {
          // This test stops at the durable verification boundary; completion review is outside scope.
          return undefined;
        },
        async planCandidateBoundary(input) {
          const draft = verificationPlanner.plan({
            runId: input.run.id,
            sourceStepId: input.continuation.sourceStepId,
          });
          const id = createVerificationPlanId();
          const createdAt = createTimestampMs(Date.now());
          return {
            plan: {
              id,
              runId: draft.runId,
              sourceStepId: draft.sourceStepId,
              plannerVersion: draft.plannerVersion,
              planHash: draft.planHash,
              candidateHash: createHash("sha256")
                .update(input.candidate.candidateText, "utf8")
                .digest("hex"),
              checks: draft.checks.map((check) => ({
                ...check,
                id: createVerificationCheckId(),
                planId: id,
                status: "PENDING" as const,
                createdAt,
              })),
              createdAt,
            },
          };
        },
        async compileRepairContext() {
          return undefined;
        },
      },
    });

    try {
      const result = await controller.start(run.id);

      // Two transport attempts for two Agent Steps: the gateway never retried.
      expect(responseNumber).toBe(2);
      expect(requests).toHaveLength(2);
      expect(contextInputKinds).toEqual(["USER_INPUT", "TOOL_RESULTS"]);
      expect(result.status).toBe("AWAITING_VERIFICATION");
      const firstMessages = requests[0]?.messages ?? [];
      const secondMessages = requests[1]?.messages ?? [];
      expect(firstMessages.map((message) => (message as { role?: string }).role)).toEqual([
        "system",
        "user",
        "user",
      ]);
      expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
      const assistantToolCallIndex = secondMessages.findIndex(
        (message) =>
          (message as { role?: string }).role === "assistant" &&
          Array.isArray((message as { tool_calls?: unknown }).tool_calls),
      );
      const toolResultIndex = secondMessages.findIndex(
        (message) => (message as { role?: string }).role === "tool",
      );
      expect(toolResultIndex).toBe(assistantToolCallIndex + 1);
      expect((secondMessages.at(-1) as { role?: string }).role).toBe("user");
      expect(JSON.stringify(secondMessages.at(-1))).toContain("after tool execution");
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
      await eventHub.dispose();
      await storage.close();
    }
  });
});
