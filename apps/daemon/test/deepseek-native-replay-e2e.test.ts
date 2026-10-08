import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { createTimestampMs } from "@caelush/protocol";
import { makeRun, makeSession } from "../../../packages/storage/test/support/fixtures.js";
import type { CaelushStorage } from "@caelush/storage";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import { createReplayProtection, createInjectedReplayKeyProvider } from "@caelush/security";
import type { RunEventNotifierPort } from "@caelush/agent";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  effectsChangeAgentState,
} from "@caelush/coding-agent";
import { composeDaemon } from "../src/daemon-composition.js";
import type { DaemonComposition } from "../src/daemon-composition.js";
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
