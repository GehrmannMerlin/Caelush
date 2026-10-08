import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIGateway, ModelDescriptor } from "@caelush/ai";
import {
  createAgentConversationSnapshot,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createContextContributionPipeline,
  createConversationTurn,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageProjectorRegistry,
  agentTextPart,
  userMessageSource,
} from "@caelush/agent";
import type { RunAgentContextEngineInput } from "@caelush/core";
import {
  AgentRunSchema,
  AgentSessionSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { LocalRuntime } from "@caelush/runtime";
import { expandPermissionPreset } from "@caelush/security";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonV2ContextEngine } from "../src/context/v2-context-composition.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "deepseek", model: "deepseek-chat" },
  api: "deepseek-chat",
  limits: { contextWindowTokens: 100_000, maxOutputTokens: 1_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "SUPPORTED",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "SUPPORTED",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

let directory: string | undefined;
let storage: Awaited<ReturnType<typeof openCaelushStorage>> | undefined;
let runtime: LocalRuntime | undefined;

afterEach(async () => {
  await runtime?.dispose();
  await storage?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  runtime = undefined;
});

describe("Prompt Surface V3 production composition", () => {
  it("prepares, durably stores and materializes one BASELINE followed by a NOOP", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-prompt-surface-v3-production-"));
    const htmlHeader = "<!doctype html>\n<main>cache-sentinel-login</main>\n";
    const html = `${htmlHeader}${"x".repeat(10_000 - Buffer.byteLength(htmlHeader, "utf8"))}`;
    await writeFile(join(directory, "login.html"), html, "utf8");
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });

    const session = AgentSessionSchema.parse({
      id: createSessionId(),
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
      metadata: {},
    });
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: session.id,
      goal: "Inspect login.html without changing it.",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: directory },
      model: MODEL.ref,
      runtime: { id: "local", kind: "local" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ON_BOUNDARY",
      securityPolicy: expandPermissionPreset({
        presetId: "VIEW_ONLY",
        expectedVersion: 1,
        createdAt: new Date(1).toISOString(),
      }),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 10_000 },
      createdAt: createTimestampMs(1),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);

    runtime = new LocalRuntime({
      discovery: {
        async find() {
          return { files: [], truncated: false };
        },
      },
    });
    const engine = createDaemonV2ContextEngine({
      input: {
        run,
        identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
        cwd: directory,
        explicitPaths: ["login.html"],
        baseSystemPrompt: "Use repository evidence and preserve file contents.",
        runMode: "EXECUTE",
      } as RunAgentContextEngineInput,
      storage,
      promptSurfaceStore: storage.promptSurface,
      runtime,
      gateway: {} as AIGateway,
      messageProjectors: createStandardAgentMessageProjectorRegistry(),
      notifier: { notifyCommitted: () => undefined },
      contributionPipeline: createContextContributionPipeline(),
      clock: { now: () => createTimestampMs(5_000) },
      activeToolNames: [],
    });

    const turns = createDeterministicConversationTurnIdFactory();
    const conversationTurnId = turns.forRun(run.id);
    const factory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(6_000),
      turns,
    });
    const messages: Array<{
      readonly sequence: number;
      readonly schemaVersion: number;
      readonly modelProjectionVersion: number;
      readonly message: ReturnType<typeof factory.createUser>;
    }> = [];
    const prepareStep = async (sequence: number) => {
      const stepId = createStepId();
      const message = factory.createUser({
        runId: run.id,
        sessionId: run.sessionId,
        conversationTurnId,
        sourceStepId: stepId,
        source: userMessageSource(sequence === 1 ? "GOAL" : "FOLLOW_UP"),
        content: [
          agentTextPart(sequence === 1 ? "Inspect login.html." : "Continue the same inspection."),
        ],
      });
      messages.push({ sequence, schemaVersion: 1, modelProjectionVersion: 1, message });
      const turn = createConversationTurn({
        id: conversationTurnId,
        sessionId: run.sessionId,
        runId: run.id,
        status: "OPEN",
        openedAt: run.createdAt,
        messages,
      });
      const conversation = createAgentConversationSnapshot({
        sessionId: run.sessionId,
        currentRunId: run.id,
        currentTurnId: conversationTurnId,
        turns: [turn],
      });
      return engine.prepare({
        identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
        turn: { stepId, sequence },
        conversation,
        input: { kind: "USER_INPUT", userMessageId: message.id },
        model: MODEL,
        tools: [],
        mode: "NORMAL",
        signal: new AbortController().signal,
      });
    };

    const first = await prepareStep(1);
    const currentEpoch = await storage.promptSurface.getCurrent(run.id);
    expect(currentEpoch?.formatVersion).toBe(3);
    const firstSurface = await storage.promptSurface.readEpoch(run.id, currentEpoch!.epochId);
    expect(firstSurface?.records?.map((record) => record.kind)).toEqual(["BASELINE"]);
    expect(first.messages.some((message) => message.content.includes("cache-sentinel-login"))).toBe(
      true,
    );

    const second = await prepareStep(2);
    const recovered = await storage.promptSurface.readEpoch(run.id, currentEpoch!.epochId);
    expect(recovered?.records?.map((record) => record.kind)).toEqual(["BASELINE", "NOOP"]);
    expect(
      second.messages.filter((message) => message.content.includes("cache-sentinel-login")),
    ).toHaveLength(1);
    expect(
      second.messages.every((message) => message.role === "system" || message.role === "user"),
    ).toBe(true);
  });
});
