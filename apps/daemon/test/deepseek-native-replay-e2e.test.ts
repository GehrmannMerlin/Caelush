import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import {
  computeSecurityPolicyDigest,
  createLLMCallId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  makeRun,
  makeSecurityPolicy,
  makeSession,
  makeStep,
} from "../../../packages/storage/test/support/fixtures.js";
import type { CaelushStorage } from "@caelush/storage";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import { createReplayProtection, createInjectedReplayKeyProvider } from "@caelush/security";
import type { AgentMessageRecordDraft, RunEventNotifierPort } from "@caelush/agent";
import {
  createPrivateReplayReference,
  createRequestedToolInvocation,
  startToolInvocation,
} from "@caelush/agent";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  effectsChangeAgentState,
} from "@caelush/coding-agent";
import { composeDaemon } from "../src/daemon-composition.js";
import type { DaemonComposition } from "../src/daemon-composition.js";
import {
  createAssistantMessageAppend,
  createExternalToolResultMessageAppend,
  createUserMessageAppend,
} from "@caelush/core";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { SessionPresentationService } from "../src/services/session-presentation-service.js";
import { SessionTranscriptService } from "../src/services/session-transcript-service.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  writeOpenAIChunk,
} from "./support/controllable-provider-server.js";
import type { ControllableProviderServer } from "./support/controllable-provider-server.js";

const MODEL_ID = "deepseek-reasoner";
const API_ID = "openai-compatible-chat";
const REASONING_A = "C3_PRIVATE_REASONING_SENTINEL reasoning A";
const REASONING_B = "private reasoning B with Unicode 雪";
const REASONING_C = "private final-answer reasoning";
const PATCH_TEXT = [
  "*** Begin Patch",
  "*** Add File: replay-created.txt",
  "+native replay",
  "*** End Patch",
].join("\n");
const PATCH_RAW_ARGUMENTS = `{"patch": ${JSON.stringify(PATCH_TEXT)}}`;
const READ_RAW_ARGUMENTS = '{"path": "README.md"}';

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;
let provider: ControllableProviderServer | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  composition = undefined;
  provider = undefined;
});

function modelSource(): ModelDescriptorSourcePort {
  const descriptor: ModelDescriptor = {
    ref: { provider: "deepseek", model: MODEL_ID },
    api: API_ID,
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 16_384 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "SUPPORTED",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "SUPPORTED",
    },
    source: "CONFIGURATION",
    adapterMetadata: {
      "openai-compatible": { requiresReasoningReplayWithTools: true },
    },
  };
  return {
    id: "c3-deepseek-fixture",
    priority: 100,
    resolve: (ref) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
    list: () => [descriptor],
  };
}

function notifyWithRestartFailpoint(
  toolResultCounter: { value: number },
  stop: boolean,
  publicEvents: unknown[],
): RunEventNotifierPort {
  return {
    notifyCommitted(events) {
      publicEvents.push(...events);
      if (!stop) return;
      for (const event of events) {
        if (
          event.type === "conversation.message.committed" &&
          event.payload.messageType === "TOOL_RESULT"
        ) {
          toolResultCounter.value += 1;
          if (toolResultCounter.value === 2)
            throw new Error("C3 restart failpoint after Tool Result commit");
        }
      }
    },
    emitTransient(event) {
      publicEvents.push(event);
    },
  };
}

function finishResponse(response: ServerResponse, finishReason: "tool_calls" | "stop"): void {
  writeOpenAIChunk(response, {
    model: MODEL_ID,
    delta: {},
    finishReason,
  });
  response.end("data: [DONE]\n\n");
}

function sendToolTurn(
  response: ServerResponse,
  reasoning: string,
  toolCallId: string,
  toolName: string,
  rawArguments: string,
): void {
  beginOpenAISse(response);
  writeOpenAIChunk(response, { model: MODEL_ID, delta: { reasoning_content: reasoning } });
  writeOpenAIChunk(response, {
    model: MODEL_ID,
    delta: {
      tool_calls: [
        {
          index: 0,
          id: toolCallId,
          type: "function",
          function: { name: toolName, arguments: rawArguments },
        },
      ],
    },
  });
  finishResponse(response, "tool_calls");
}

function providerHandler() {
  return async (request: { readonly index: number }, response: ServerResponse): Promise<void> => {
    switch (request.index) {
      case 0:
        sendToolTurn(response, REASONING_A, "call-apply-patch", "apply_patch", PATCH_RAW_ARGUMENTS);
        return;
      case 1:
        sendToolTurn(response, REASONING_B, "call-read-file", "read_file", READ_RAW_ARGUMENTS);
        return;
      case 2:
      case 4:
        beginOpenAISse(response);
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { reasoning_content: REASONING_C },
        });
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { content: "The file is updated and verified." },
        });
        finishResponse(response, "stop");
        return;
      default:
        beginOpenAISse(response);
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { content: JSON.stringify({ verdict: "PASS", summary: "verified" }) },
        });
        finishResponse(response, "stop");
    }
  };
}

function canonicalReplayJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReplayJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalReplayJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function openStore(databasePath: string): Promise<CaelushStorage> {
  return openCaelushStorage({
    path: databasePath,
    replayProtection: createReplayProtection(
      createInjectedReplayKeyProvider("c3-fixture-key", Buffer.alloc(32, 0x5a)),
    ),
    toolSettlementExtension: createCodingToolSettlementExtensionDecoder({
      effects: toHostToolEffectsPort({
        changesState: effectsChangeAgentState,
        apply: applyToolEffectsToAgentState,
      }),
    }),
  });
}

async function compose(
  currentStorage: CaelushStorage,
  publicEvents: unknown[],
  failpoint: { readonly enabled: boolean; readonly counter: { value: number } },
): Promise<DaemonComposition> {
  return composeDaemon({
    storage: currentStorage,
    notifier: notifyWithRestartFailpoint(failpoint.counter, failpoint.enabled, publicEvents),
    modelSources: [modelSource()],
    providers: [
      {
        provider: "deepseek",
        baseUrl: provider!.endpoint,
        apiKey: "fixture-only",
        allowedModels: [MODEL_ID],
      },
    ],
    defaultModel: { provider: "deepseek", model: MODEL_ID },
    toolExposure: "AVAILABLE",
  });
}

describe("DeepSeek private native replay production trajectory", () => {
  it("closes an interrupted open Tool batch before a new Provider request and preserves native replay", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-ic-a-replay-"));
    provider = await createControllableProviderServer(async (request, response) => {
      beginOpenAISse(response);
      if (request.index === 0) {
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { reasoning_content: "private continuation reasoning" },
        });
      }
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: {
          content:
            request.index === 0
              ? "Continuity preserved."
              : JSON.stringify({ verdict: "PASS", summary: "verified" }),
        },
      });
      finishResponse(response, "stop");
    });
    storage = await openStore(join(directory, "caelush.db"));

    const workspace = await new WorkspaceService({
      repository: storage.workspaces,
    }).registerWorkspace({
      path: directory,
    });
    const workspaceRef = {
      id: workspace.workspace.id,
      path: workspace.workspace.canonicalPath,
    };
    const session = makeSession({
      workspaceId: workspace.workspace.id,
      defaultWorkspace: workspaceRef,
    });
    const interruptedRun = makeRun(session.id, {
      goal: "Complete the interrupted Tool batch.",
      workspace: workspaceRef,
      model: { provider: "deepseek", model: MODEL_ID },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 8, maxToolCalls: 16, timeoutMs: 60_000 },
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(interruptedRun);
    const publicEvents: unknown[] = [];
    composition = await compose(storage, publicEvents, {
      enabled: false,
      counter: { value: 0 },
    });

    const calls = Array.from({ length: 12 }, (_, index) => {
      const id = `ic-a-call-${index + 1}`;
      if (index === 8) {
        const input = {
          cmd: "node -e \"require('node:fs').writeFileSync('possible-side-effect.txt', 'started')\"",
        };
        return {
          id,
          toolName: "exec_command" as const,
          input,
          rawArguments: JSON.stringify(input),
        };
      }
      const input = { path: `historical-${index + 1}.txt` };
      return { id, toolName: "read_file" as const, input, rawArguments: JSON.stringify(input) };
    });
    const batches = [calls.slice(0, 2), calls.slice(2, 4), calls.slice(4, 8), calls.slice(8, 12)];
    const interruptedSteps = batches.map((_, index) =>
      makeStep(interruptedRun.id, {
        sequence: index + 1,
        status: "COMPLETED",
        startedAt: createTimestampMs(110 + index * 10),
        finishedAt: createTimestampMs(115 + index * 10),
      }),
    );
    for (const step of interruptedSteps) await storage.steps.insert(step);

    const originalUserDraft = createUserMessageAppend(
      composition.messages,
      interruptedRun,
      "GOAL",
    ).draft;
    const providerBinding = composition.ai.providers.get("deepseek");
    const descriptor = composition.ai.models.resolve({ provider: "deepseek", model: MODEL_ID });
    const queryParams = providerBinding.queryParams ?? {};
    const adapterCompatibility = descriptor.adapterMetadata?.["openai-compatible"];
    const connectionFingerprint = createHash("sha256")
      .update(
        canonicalReplayJson({
          endpoint: providerBinding.endpoint,
          queryParams,
          providerCompatibility: providerBinding.compatibility ?? null,
          modelCompatibility: adapterCompatibility,
        }),
      )
      .digest("hex");

    const authority = composition.messages;
    const beforeRunRecords: AgentMessageRecordDraft[] = [originalUserDraft];
    const privateReplayWrites = [];
    const replayIdentities = [];
    const reasoningByBatch = [
      REASONING_A,
      REASONING_B,
      REASONING_C,
      "private interruption reasoning D",
    ];
    for (const [batchIndex, batch] of batches.entries()) {
      const step = interruptedSteps[batchIndex];
      const reasoning = reasoningByBatch[batchIndex];
      if (step === undefined || reasoning === undefined)
        throw new Error("incomplete batch fixture");
      const llmCallId = createLLMCallId();
      const assistantAppend = createAssistantMessageAppend(
        authority,
        interruptedRun,
        step.id,
        {
          callId: llmCallId,
          model: { provider: "deepseek", model: MODEL_ID },
          finishReason: "TOOL_CALLS",
          assistantMessage: {
            role: "assistant",
            content: batch.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.toolName,
              input: call.input,
            })),
          },
        },
        "COMMENTARY",
      );
      const identity = {
        sessionId: String(session.id),
        runId: String(interruptedRun.id),
        messageId: String(assistantAppend.draft.messageId),
        callId: llmCallId,
        providerId: "deepseek",
        model: MODEL_ID,
        api: API_ID,
        replayVersion: 1 as const,
      };
      replayIdentities.push(identity);
      beforeRunRecords.push({
        ...assistantAppend.draft,
        data: {
          ...assistantAppend.draft.data,
          providerState: createPrivateReplayReference(identity),
        },
      });

      const privateReplayPayload = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          providerId: "deepseek",
          model: MODEL_ID,
          api: API_ID,
          connectionFingerprint,
          reasoning: { state: "PRESENT", content: reasoning },
          toolCalls: batch.map((call) => ({
            id: call.id,
            name: call.toolName,
            rawArguments: call.rawArguments,
            argumentMode: "PROVIDER_JSON",
          })),
        }),
      );
      privateReplayWrites.push(await storage.privateReplay.prepare(identity, privateReplayPayload));
      privateReplayPayload.fill(0);

      if (batchIndex < 3) {
        for (const call of batch) {
          beforeRunRecords.push(
            createExternalToolResultMessageAppend(
              authority,
              interruptedRun,
              step.id,
              {
                role: "tool",
                toolCallId: call.id,
                toolName: call.toolName,
                content: `existing result ${calls.indexOf(call) + 1}`,
                isError: false,
              },
              {
                maxSingleObservationTokens: 4_096,
                maxObservationBatchTokens: 16_384,
              },
            ).draft,
          );
        }
      }
    }
    const orderedRunRecords = beforeRunRecords.map((draft, index) => ({
      ...draft,
      createdAt: createTimestampMs(110 + index),
    }));
    await storage.execution.commit({
      run: interruptedRun,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [],
      messagesToAppend: orderedRunRecords.map((draft) => ({ draft })),
      privateReplayWrites,
      events: [],
    });
    await storage.runs.update({
      ...interruptedRun,
      status: "RUNNING",
      startedAt: createTimestampMs(105),
    });
    const uncertainCall = calls[8];
    const uncertainStep = interruptedSteps[3];
    if (uncertainCall === undefined || uncertainStep === undefined) {
      throw new Error("the unknown-outcome fixture is incomplete");
    }
    const requestedUnknownCall = createRequestedToolInvocation({
      id: createToolInvocationId(),
      runId: interruptedRun.id,
      stepId: uncertainStep.id,
      externalCallId: uncertainCall.id,
      toolName: uncertainCall.toolName,
      args: uncertainCall.input,
      riskLevel: "CRITICAL",
      createdAt: createTimestampMs(119),
    });
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation: requestedUnknownCall,
      expectedRevision: null,
      events: [],
    });
    await storage.toolExecution.commit({
      sessionId: session.id,
      invocation: startToolInvocation(requestedUnknownCall, createTimestampMs(120)),
      expectedRevision: 1,
      events: [],
    });
    await storage.runs.update({
      ...interruptedRun,
      status: "CANCELLED",
      startedAt: createTimestampMs(105),
      finishedAt: createTimestampMs(125),
    });

    const failedContinuationRun = makeRun(session.id, {
      createdAt: createTimestampMs(200),
      status: "FAILED",
      startedAt: createTimestampMs(205),
      finishedAt: createTimestampMs(220),
      goal: "Continue after the previous run was interrupted.",
      workspace: workspaceRef,
      model: interruptedRun.model,
      runtime: interruptedRun.runtime,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
    });
    await storage.runs.insert(failedContinuationRun);
    const failedRunUserDraft = createUserMessageAppend(
      composition.messages,
      failedContinuationRun,
      "GOAL",
    ).draft;
    const priorFailedRunRecords = await storage.messageRecords.append(failedContinuationRun.id, [
      { ...failedRunUserDraft, createdAt: createTimestampMs(210) },
    ]);

    const originalRecords = await storage.messageRecords.listByRun(interruptedRun.id);
    const originalReplayEnvelopes = replayIdentities.map(
      (identity) =>
        storage.messageRecords.database.client
          .prepare("SELECT envelope_json FROM private_replays WHERE message_id = ?")
          .get(identity.messageId) as { readonly envelope_json: string } | undefined,
    );
    expect(originalReplayEnvelopes.every((row) => row !== undefined)).toBe(true);

    const nextSecurityPolicyWithoutDigest = makeSecurityPolicy("FULL_ACCESS", "NEVER_ASK");
    const nextSecurityPolicyUnsigned = {
      ...nextSecurityPolicyWithoutDigest,
      createdAt: new Date(300).toISOString(),
    };
    const nextRun = makeRun(session.id, {
      createdAt: createTimestampMs(300),
      completionContract: "NATURAL_V1",
      goal: "Continue the same task after the failed continuation attempt.",
      workspace: workspaceRef,
      model: interruptedRun.model,
      runtime: interruptedRun.runtime,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      securityPolicy: {
        ...nextSecurityPolicyUnsigned,
        policyDigest: computeSecurityPolicyDigest(nextSecurityPolicyUnsigned),
      },
      limits: { maxSteps: 8, maxToolCalls: 16, timeoutMs: 60_000 },
    });
    await storage.runs.insert(nextRun);

    const initialSnapshot = await composition.messages.conversation.loadSnapshot({
      sessionId: session.id,
      currentRunId: nextRun.id,
    });
    const initialHistoricalMessages = initialSnapshot.turns
      .find((turn) => turn.runId === interruptedRun.id)
      ?.messages.map((stored) => stored.message);
    const initialAssistantBatches = initialHistoricalMessages?.filter(
      (message) => message.type === "ASSISTANT",
    );
    expect(
      initialAssistantBatches?.map(
        (message) => message.content.filter((part) => part.type === "TOOL_CALL").length,
      ),
    ).toEqual([2, 2, 4, 4]);
    expect(
      initialHistoricalMessages?.filter((message) => message.type === "TOOL_RESULT"),
    ).toHaveLength(8);
    expect(
      initialSnapshot.turns
        .find((turn) => turn.runId === failedContinuationRun.id)
        ?.messages.filter((stored) => stored.message.type === "USER"),
    ).toHaveLength(1);
    const result = await composition.controller.start(nextRun.id);
    const resultDiagnosticRecords = await storage.messageRecords.listByRun(interruptedRun.id);
    expect(
      result.run.status,
      JSON.stringify({
        error: result.error,
        providerRequests: provider.requests.length,
        oldRunToolResults: resultDiagnosticRecords.filter(
          (record) => record.messageType === "TOOL_RESULT",
        ).length,
      }),
    ).toBe("COMPLETED");
    expect(provider.requests.length).toBe(1);

    const requestMessages = provider.requests[0]?.body["messages"] as Record<string, unknown>[];
    const runtimeFacts = await composition.securityCapabilityService.getRuntimeFacts();
    const runASecurityPrompt = composition.runSecurityPromptProjector.project(
      interruptedRun.securityPolicy!,
      runtimeFacts,
    ).text;
    const runBSecurityPrompt = composition.runSecurityPromptProjector.project(
      nextRun.securityPolicy!,
      runtimeFacts,
    ).text;
    expect(nextRun.securityPolicy!.createdAt).not.toBe(interruptedRun.securityPolicy!.createdAt);
    expect(nextRun.securityPolicy!.policyDigest).not.toBe(
      interruptedRun.securityPolicy!.policyDigest,
    );
    expect(runBSecurityPrompt).toBe(runASecurityPrompt);
    const securitySystemMessage = requestMessages.find(
      (message) =>
        message.role === "system" &&
        typeof message["content"] === "string" &&
        message["content"].includes("<run_security_policy>"),
    );
    expect(securitySystemMessage?.["content"]).toContain(runBSecurityPrompt);
    expect(securitySystemMessage?.["content"]).toContain("policy_semantic_fingerprint=sha256:");
    expect(securitySystemMessage?.["content"]).not.toContain("policy_digest=");
    const providerAssistantBatches = requestMessages.filter(
      (message) => message.role === "assistant" && Array.isArray(message["tool_calls"]),
    );
    expect(
      providerAssistantBatches.map((message) => (message["tool_calls"] as unknown[]).length),
    ).toEqual([2, 2, 4, 4]);
    const providerToolCalls = providerAssistantBatches.flatMap(
      (message) =>
        message["tool_calls"] as {
          readonly id: string;
          readonly function: { readonly name: string; readonly arguments: string };
        }[],
    );
    expect(providerAssistantBatches.map((message) => message["reasoning_content"])).toEqual(
      reasoningByBatch,
    );
    expect(
      providerToolCalls.map((call) => [call.id, call.function.name, call.function.arguments]),
    ).toEqual(calls.map((call) => [call.id, call.toolName, call.rawArguments]));
    const providerToolResults = requestMessages.filter((message) => message.role === "tool");
    expect(providerToolResults.map((message) => message["tool_call_id"])).toEqual(
      calls.map((call) => call.id),
    );
    expect(providerToolResults.slice(0, 8).map((message) => message["content"])).toEqual(
      Array.from({ length: 8 }, (_, index) => `existing result ${index + 1}`),
    );
    expect(providerToolResults[8]?.["content"]).toContain("final outcome is unknown");
    expect(providerToolResults[8]?.["content"]).toContain("Inspect the current state");
    expect(providerToolResults[8]?.["content"]).toContain("Do not blindly repeat this action");
    expect(
      providerToolResults
        .slice(9)
        .every((message) =>
          String(message["content"]).includes(
            "not started because the previous run was interrupted",
          ),
        ),
    ).toBe(true);
    expect(
      requestMessages.some(
        (message) =>
          message.role === "user" &&
          message["content"] === "Continue after the previous run was interrupted.",
      ),
    ).toBe(true);
    const failedRunUserIndexes = requestMessages.flatMap((message, index) =>
      message.role === "user" &&
      message["content"] === "Continue after the previous run was interrupted."
        ? [index]
        : [],
    );
    const currentRunUserIndex = requestMessages.findIndex(
      (message) =>
        message.role === "user" &&
        message["content"] === "Continue the same task after the failed continuation attempt.",
    );
    expect(failedRunUserIndexes).toHaveLength(1);
    expect(currentRunUserIndex).toBeGreaterThan(failedRunUserIndexes[0] ?? -1);
    expect(failedRunUserIndexes[0]).toBeGreaterThan(
      requestMessages.findIndex(
        (message) => message.role === "tool" && message["tool_call_id"] === calls.at(-1)?.id,
      ),
    );

    const afterRunRecords = await storage.messageRecords.listByRun(interruptedRun.id);
    expect(afterRunRecords.slice(0, originalRecords.length)).toEqual(originalRecords);
    expect(afterRunRecords.filter((record) => record.messageType === "TOOL_RESULT")).toHaveLength(
      12,
    );
    expect((await storage.runs.get(interruptedRun.id))?.status).toBe("CANCELLED");
    expect(
      (await storage.messageRecords.listByRun(nextRun.id)).filter(
        (record) => record.messageType === "USER",
      ),
    ).toHaveLength(1);
    expect(await storage.messageRecords.listByRun(failedContinuationRun.id)).toEqual(
      priorFailedRunRecords,
    );
    expect((await storage.runs.get(failedContinuationRun.id))?.status).toBe("FAILED");
    expect(
      afterRunRecords.filter((record) => record.messageType === "TOOL_RESULT").slice(0, 8),
    ).toEqual(originalRecords.filter((record) => record.messageType === "TOOL_RESULT"));
    const afterReplayEnvelopes = replayIdentities.map(
      (identity) =>
        storage.messageRecords.database.client
          .prepare("SELECT envelope_json FROM private_replays WHERE message_id = ?")
          .get(identity.messageId) as { readonly envelope_json: string } | undefined,
    );
    expect(afterReplayEnvelopes.map((row) => row?.envelope_json)).toEqual(
      originalReplayEnvelopes.map((row) => row?.envelope_json),
    );
    const interruptedInvocations = await storage.toolInvocations.listByRun(interruptedRun.id);
    expect(interruptedInvocations).toHaveLength(1);
    expect(interruptedInvocations[0]).toMatchObject({
      status: "RUNNING",
      externalCallId: "ic-a-call-9",
      toolName: "exec_command",
    });
    expect(
      (
        await storage.toolExecution.findByExternalCall(
          interruptedRun.id,
          uncertainStep.id,
          "ic-a-call-9",
        )
      )?.observation,
    ).toBeUndefined();
    expect(
      publicEvents.some((event) =>
        reasoningByBatch.some((reasoning) => JSON.stringify(event).includes(reasoning)),
      ),
    ).toBe(false);

    const isolatedSession = makeSession({
      workspaceId: workspace.workspace.id,
      defaultWorkspace: workspaceRef,
    });
    const isolatedRun = makeRun(isolatedSession.id, {
      createdAt: createTimestampMs(400),
      completionContract: "NATURAL_V1",
      goal: "Only use this separate Session's history.",
      workspace: workspaceRef,
      model: interruptedRun.model,
      runtime: interruptedRun.runtime,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
    });
    await storage.sessions.insert(isolatedSession);
    await storage.runs.insert(isolatedRun);
    const isolatedUser = createUserMessageAppend(composition.messages, isolatedRun, "GOAL").draft;
    await storage.messageRecords.append(isolatedRun.id, [isolatedUser]);
    const isolatedSnapshot = await composition.messages.conversation.loadSnapshot({
      sessionId: isolatedSession.id,
      currentRunId: isolatedRun.id,
    });
    expect(isolatedSnapshot.turns.map((turn) => turn.runId)).toEqual([isolatedRun.id]);
    const isolatedWire = JSON.stringify(
      isolatedSnapshot.turns.flatMap((turn) => turn.messages.map((stored) => stored.message)),
    );
    expect(isolatedWire).toContain("Only use this separate Session's history.");
    expect(isolatedWire).not.toContain("ic-a-call-");
    expect(isolatedWire).not.toContain("existing result 1");
    expect(isolatedWire).not.toContain("Do not blindly repeat this action");
    expect(isolatedWire).not.toContain("Complete the interrupted Tool batch.");
  }, 60_000);

  it("captures, atomically stores, restarts, and replays two Tool-turn reasoning histories", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-c3-replay-"));
    await writeFile(join(directory, "README.md"), "before\n", "utf8");
    provider = await createControllableProviderServer(providerHandler());
    const databasePath = join(directory, "caelush.db");
    storage = await openStore(databasePath);
    const workspace = await new WorkspaceService({
      repository: storage.workspaces,
    }).registerWorkspace({
      path: directory,
    });
    const workspaceRef = {
      id: workspace.workspace.id,
      path: workspace.workspace.canonicalPath,
    };
    const session = makeSession({
      workspaceId: workspace.workspace.id,
      defaultWorkspace: workspaceRef,
    });
    const run = makeRun(session.id, {
      goal: "Update the fixture file and confirm its content.",
      workspace: workspaceRef,
      model: { provider: "deepseek", model: MODEL_ID },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 8, maxToolCalls: 4, timeoutMs: 60_000 },
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);

    const publicEvents: unknown[] = [];
    const toolResultsCommitted = { value: 0 };
    composition = await compose(storage, publicEvents, {
      enabled: true,
      counter: toolResultsCommitted,
    });
    await expect(composition.controller.start(run.id)).rejects.toThrow(
      "C3 restart failpoint after Tool Result commit",
    );
    expect(toolResultsCommitted.value).toBe(2);
    expect(provider.requests.length).toBe(2);
    expect(await readFile(join(directory, "replay-created.txt"), "utf8")).toBe("native replay\n");

    await composition.dispose();
    composition = undefined;
    await storage.close();
    storage = await openStore(databasePath);
    composition = await compose(storage, publicEvents, {
      enabled: false,
      counter: toolResultsCommitted,
    });
    const result = await composition.controller.recover(run.id);

    expect(provider.requests.length).toBe(4);
    const firstThreeBodies = provider.requests.slice(0, 3).map((request) => request.body);
    const requestTwoMessages = firstThreeBodies[1]?.["messages"] as Record<string, unknown>[];
    const requestThreeMessages = firstThreeBodies[2]?.["messages"] as Record<string, unknown>[];
    const requestTwoReasoning = requestTwoMessages
      .filter((message) => message.role === "assistant")
      .map((message) => message["reasoning_content"]);
    const requestThreeReasoning = requestThreeMessages
      .filter((message) => message.role === "assistant")
      .map((message) => message["reasoning_content"]);
    expect(requestTwoReasoning.length === 1 && requestTwoReasoning[0] === REASONING_A).toBe(true);
    expect(
      requestThreeReasoning.length === 2 &&
        requestThreeReasoning[0] === REASONING_A &&
        requestThreeReasoning[1] === REASONING_B,
    ).toBe(true);

    const roleOrder = requestThreeMessages.map((message) => message.role);
    expect(
      requestThreeMessages.some(
        (message) =>
          message.role === "user" &&
          typeof message["content"] === "string" &&
          message["content"].includes("Update the fixture file"),
      ),
    ).toBe(true);
    const patchResultIndex = requestThreeMessages.findIndex(
      (message) => message.role === "tool" && message["tool_call_id"] === "call-apply-patch",
    );
    const readResultIndex = requestThreeMessages.findIndex(
      (message) => message.role === "tool" && message["tool_call_id"] === "call-read-file",
    );
    const assistantCallIds = requestThreeMessages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => {
        const toolCalls = message["tool_calls"] as
          | readonly {
              readonly id: string;
              readonly function: { readonly name: string; readonly arguments: string };
            }[]
          | undefined;
        return toolCalls?.map((call) => call.id) ?? [];
      });
    expect(assistantCallIds).toEqual(["call-apply-patch", "call-read-file"]);
    const historicalToolCalls = requestThreeMessages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => {
        const toolCalls = message["tool_calls"] as
          | readonly {
              readonly id: string;
              readonly function: { readonly name: string; readonly arguments: string };
            }[]
          | undefined;
        return toolCalls ?? [];
      });
    expect(
      historicalToolCalls.map((call) => [call.id, call.function.name, call.function.arguments]),
    ).toEqual([
      ["call-apply-patch", "apply_patch", PATCH_RAW_ARGUMENTS],
      ["call-read-file", "read_file", READ_RAW_ARGUMENTS],
    ]);
    expect(patchResultIndex >= 0 && readResultIndex > patchResultIndex).toBe(true);
    expect(roleOrder.includes("tool")).toBe(true);
    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(await readFile(join(directory, "replay-created.txt"), "utf8")).toBe("native replay\n");

    const invocations = await storage.toolInvocations.listByRun(run.id);
    expect(invocations.length).toBe(2);
    expect(invocations.every((invocation) => invocation.status === "COMPLETED")).toBe(true);
    const snapshot = await composition.messages.conversation.loadSnapshot({
      sessionId: session.id,
      currentRunId: run.id,
    });
    const selectedStoredMessages = snapshot.turns.flatMap((turn) => turn.messages);
    const assistantMessages = selectedStoredMessages.filter(
      (stored) => stored.message.type === "ASSISTANT",
    );
    const replayCallIds = assistantMessages.flatMap((stored) => {
      const state = stored.message.providerState;
      const callId = state?.payload["callId"];
      return typeof callId === "string" ? [callId] : [];
    });
    expect(replayCallIds.length).toBe(3);
    expect(new Set(replayCallIds).size).toBe(3);
    const transcript = selectedStoredMessages.flatMap((stored) =>
      composition!.transcriptProjectors.project(stored),
    );
    const publicJson = JSON.stringify({ publicEvents, transcript, result });
    const ordinaryMessageJson = JSON.stringify(assistantMessages.map((stored) => stored.message));
    expect(publicJson.includes(REASONING_A)).toBe(false);
    expect(publicJson.includes(REASONING_B)).toBe(false);
    expect(publicJson.includes(REASONING_C)).toBe(false);
    expect(ordinaryMessageJson.includes(REASONING_A)).toBe(false);
    expect(ordinaryMessageJson.includes(REASONING_B)).toBe(false);
    expect(ordinaryMessageJson.includes(REASONING_C)).toBe(false);
    expect(
      assistantMessages.filter((stored) => stored.message.providerState !== undefined).length,
    ).toBe(3);

    // A new Run must use the Context Materializer's real same-Session selection,
    // including the prior final Assistant (which did not call a Tool).
    const nextRun = makeRun(session.id, {
      createdAt: createTimestampMs(Date.now()),
      goal: "Confirm the previous task is complete without changing any files.",
      workspace: workspaceRef,
      model: run.model,
      runtime: run.runtime,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
      limits: { maxSteps: 8, maxToolCalls: 4, timeoutMs: 60_000 },
    });
    await storage.runs.insert(nextRun);
    const nextResult = await composition.controller.start(nextRun.id);
    expect(nextResult.run.status).toBe("COMPLETED");
    expect(provider.requests.length).toBe(6);
    const nextRunMessages = provider.requests[4]?.body["messages"] as Record<string, unknown>[];
    const nextRunReasoning = nextRunMessages
      .filter((message) => message.role === "assistant")
      .map((message) => message["reasoning_content"]);
    expect(
      nextRunReasoning.length === 3 &&
        nextRunReasoning[0] === REASONING_A &&
        nextRunReasoning[1] === REASONING_B &&
        nextRunReasoning[2] === REASONING_C,
    ).toBe(true);
    const sessionPresentation = await new SessionPresentationService({
      sessions: storage.sessions,
      runs: storage.runs,
      messageRecords: storage.messageRecords,
      codecs: composition.messages.codecs,
      toolInvocations: storage.toolInvocations,
      observations: storage.observations,
      eventReader: storage.eventReader,
      toolPresentation: composition.toolPresentation,
    }).getPresentation(session.id, {});
    const sessionTranscript = await new SessionTranscriptService({
      sessions: storage.sessions,
      runs: storage.runs,
      messageRecords: storage.messageRecords,
      codecs: composition.messages.codecs,
      transcriptProjectors: composition.transcriptProjectors,
    }).getTranscript(session.id, {});
    const projectedPublicJson = JSON.stringify({ sessionPresentation, sessionTranscript });
    expect(projectedPublicJson.includes(REASONING_A)).toBe(false);
    expect(projectedPublicJson.includes(REASONING_B)).toBe(false);
    expect(projectedPublicJson.includes(REASONING_C)).toBe(false);
    expect((await storage.toolInvocations.listByRun(nextRun.id)).length).toBe(0);
    expect((await storage.toolInvocations.listByRun(run.id)).length).toBe(2);

    const historical = assistantMessages[0]?.message;
    const historicalCallId = historical?.providerState?.payload["callId"];
    if (historical === undefined || typeof historicalCallId !== "string")
      throw new Error("missing replay identity");
    const unauthorizedReader = storage.privateReplay.forExecution({
      sessionId: String(session.id),
      executionRunId: String(nextRun.id),
      providerId: "deepseek",
      model: MODEL_ID,
      api: API_ID,
      selectedMessageIds: [],
    });
    const denied = await unauthorizedReader
      .read({
        sessionId: String(session.id),
        runId: String(run.id),
        messageId: String(historical.id),
        callId: historicalCallId,
        providerId: "deepseek",
        model: MODEL_ID,
        api: API_ID,
        replayVersion: 1,
      })
      .then(
        (bytes) => {
          bytes.fill(0);
          return false;
        },
        () => true,
      );
    expect(denied).toBe(true);
    expect(JSON.stringify({ publicEvents, nextResult }).includes(REASONING_C)).toBe(false);

    await composition.dispose();
    composition = undefined;
    await storage.close();
    storage = undefined;
    expect((await readFile(databasePath)).includes(Buffer.from(REASONING_A))).toBe(false);
    expect((await readFile(databasePath)).includes(Buffer.from(REASONING_B))).toBe(false);
    expect((await readFile(databasePath)).includes(Buffer.from(REASONING_C))).toBe(false);
  }, 60_000);
});
