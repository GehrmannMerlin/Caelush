import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
  agentAssistantTextPart,
  agentAssistantToolCallPart,
  agentTextPart,
  modelMessageSource,
  projectPromptSurface,
  toolFeedbackPolicySnapshot,
  toolMessageSource,
  toolResultObservation,
  userMessageSource,
  type StoredAgentMessage,
} from "@caelush/agent";
import type { RunAgentContextEngineInput } from "@caelush/core";
import {
  AgentRunSchema,
  AgentSessionSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  ToolInvocationSchema,
  ToolObservationSchema,
} from "@caelush/protocol";
import { LocalRuntime } from "@caelush/runtime";
import { expandPermissionPreset } from "@caelush/security";
import { openCaelushStorage } from "@caelush/storage";
import type { CaelushStorage } from "@caelush/storage";
import type { ToolInvocation, ToolObservation } from "@caelush/protocol";
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

  it("keeps a 10-step local coding trajectory semantic and recoverable", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-cache-c2-trajectory-"));
    const initialHtmlHeader = "<!doctype html>\n<main>login-v1-cache-fixture</main>\n";
    const initialHtml = `${initialHtmlHeader}${"x".repeat(10_240 - Buffer.byteLength(initialHtmlHeader, "utf8"))}`;
    await writeFile(join(directory, "login.html"), initialHtml, "utf8");
    await writeFile(join(directory, "AGENTS.md"), "Preserve project boundaries.\n", "utf8");
    await writeFile(join(directory, "README.md"), "Tracked fixture.\n", "utf8");
    execFileSync("git", ["-C", directory, "init", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", directory, "config", "user.name", "Caelush C2 Fixture"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", directory, "config", "user.email", "c2-fixture@example.invalid"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", directory, "add", "AGENTS.md", "README.md", "login.html"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", directory, "commit", "-m", "fixture baseline"], {
      stdio: "ignore",
    });

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
      goal: "Inspect and update login.html safely.",
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
      limits: { maxSteps: 12, maxToolCalls: 12, timeoutMs: 10_000 },
      createdAt: createTimestampMs(1),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.resourceGovernance.createOrGet(run.id, {
      policyVersion: "adaptive-resource-governance.v1",
      mode: "ADAPTIVE",
      now: createTimestampMs(1),
    });

    runtime = new LocalRuntime({
      discovery: {
        async find() {
          return { files: [], truncated: false };
        },
      },
    });
    const fixtureInvocations = new Map<string, ToolInvocation>();
    const fixtureObservations = new Map<string, ToolObservation>();
    let fixtureStorage: CaelushStorage;
    const createFixtureStorage = (): CaelushStorage => ({
      ...storage!,
      toolInvocations: {
        async get(id) {
          return fixtureInvocations.get(id) ?? storage!.toolInvocations.get(id);
        },
        async findByExternalCall(...args) {
          return storage!.toolInvocations.findByExternalCall(...args);
        },
        async listByRun(runId) {
          const stored = await storage!.toolInvocations.listByRun(runId);
          return [
            ...stored,
            ...[...fixtureInvocations.values()].filter((item) => item.runId === runId),
          ];
        },
      },
      observations: {
        async get(id) {
          return fixtureObservations.get(id) ?? storage!.observations.get(id);
        },
        async findByToolInvocation(id) {
          const fixture = [...fixtureObservations.values()].find(
            (observation) => observation.toolInvocationId === id,
          );
          return fixture ?? storage!.observations.findByToolInvocation(id);
        },
        async listByRun(runId) {
          const stored = await storage!.observations.listByRun(runId);
          return [
            ...stored,
            ...[...fixtureObservations.values()].filter((item) => item.runId === runId),
          ];
        },
      },
    });
    fixtureStorage = createFixtureStorage();

    const turns = createDeterministicConversationTurnIdFactory();
    const conversationTurnId = turns.forRun(run.id);
    const factory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(6_000),
      turns,
    });
    const messages: StoredAgentMessage[] = [];
    const initialUser = factory.createUser({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId,
      source: userMessageSource("GOAL"),
      content: [agentTextPart(run.goal)],
    });
    messages.push({
      sequence: 1,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message: initialUser,
    });
    const priorCommentary = factory.createAssistant({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId,
      sourceStepId: createStepId(),
      source: modelMessageSource("c2-fixture-commentary"),
      phase: "COMMENTARY",
      content: [
        agentAssistantTextPart("I have started inspecting the project context.", {
          assistantItemId: "c2-fixture-commentary-item",
          phase: "COMMENTARY",
        }),
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "c2-fixture-commentary",
        model: MODEL.ref,
        finishReason: "STOP",
      },
    });
    messages.push({
      sequence: 2,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message: priorCommentary,
    });

    let nowMs = Date.parse("2026-10-08T12:29:30.123Z");
    let engine = createTrajectoryEngine();
    async function prepareStep(sequence: number) {
      const stepId = createStepId();
      const message = factory.createUser({
        runId: run.id,
        sessionId: run.sessionId,
        conversationTurnId,
        sourceStepId: stepId,
        source: userMessageSource("FOLLOW_UP"),
        content: [agentTextPart(`Continue deterministic context step ${String(sequence)}.`)],
      });
      messages.push({
        sequence: messages.length + 1,
        schemaVersion: 1,
        modelProjectionVersion: 1,
        message,
      });
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
      const prepared = await engine.prepare({
        identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
        turn: { stepId, sequence },
        conversation,
        input: { kind: "CONTINUATION", reason: "TOOL_RESULT" },
        model: MODEL,
        tools: [],
        mode: "NORMAL",
        signal: new AbortController().signal,
      });
      return { prepared, stepId };
    }

    const first = await prepareStep(1);
    const second = await prepareStep(2);

    const resourceState = await storage.resourceGovernance.get(run.id);
    if (resourceState === null) throw new Error("Resource governance fixture was not created.");
    await storage.resourceGovernance.compareAndSwap(run.id, resourceState.revision, {
      ...resourceState,
      agentTurnsConsumed: 7,
      toolOperationsConsumed: 10,
      revision: resourceState.revision + 1,
      updatedAt: createTimestampMs(7_000),
    });
    const third = await prepareStep(3);
    nowMs = Date.parse("2026-10-08T12:29:59.999Z");
    const fourth = await prepareStep(4);

    const toolInvocation = ToolInvocationSchema.parse({
      id: createToolInvocationId(),
      runId: run.id,
      stepId: fourth.stepId,
      externalCallId: "c2-fixture-call",
      toolName: "read_file",
      args: { path: "login.html", secret: "never-model-visible-from-commentary" },
      riskLevel: "LOW",
      status: "COMPLETED",
      createdAt: createTimestampMs(8_000),
      finishedAt: createTimestampMs(8_001),
    });
    const toolObservation = ToolObservationSchema.parse({
      id: "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
      kind: "TOOL",
      runId: run.id,
      stepId: fourth.stepId,
      toolInvocationId: toolInvocation.id,
      content: "large observation body stays in the Tool Result message",
      details: { path: "login.html" },
      isError: false,
      createdAt: createTimestampMs(8_001),
    });
    fixtureInvocations.set(toolInvocation.id, toolInvocation);
    fixtureObservations.set(toolObservation.id, toolObservation);
    const callId = "c2-fixture-call";
    const toolCall = factory.createAssistant({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId,
      sourceStepId: fourth.stepId,
      source: modelMessageSource("c2-fixture-tool-call"),
      phase: "COMMENTARY",
      content: [
        agentAssistantToolCallPart({
          toolCallId: callId,
          toolName: "read_file",
          input: { path: "login.html" },
        }),
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "c2-fixture-tool-call",
        model: MODEL.ref,
        finishReason: "TOOL_CALLS",
      },
    });
    messages.push({
      sequence: messages.length + 1,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message: toolCall,
    });
    const toolResult = factory.createToolResult({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId,
      sourceStepId: fourth.stepId,
      source: toolMessageSource(),
      toolCallId: callId,
      toolName: "read_file",
      observation: toolResultObservation(toolObservation.id),
      isError: false,
      projectedContent: "Read login.html; see the bounded observation above.",
      projection: {
        policy: toolFeedbackPolicySnapshot({
          maxSingleObservationTokens: 4_096,
          maxObservationBatchTokens: 8_192,
        }),
        fingerprint: "sha256:" + "0".repeat(64),
        version: 1,
      },
    });
    messages.push({
      sequence: messages.length + 1,
      schemaVersion: 1,
      modelProjectionVersion: 1,
      message: toolResult,
    });

    const fifth = await prepareStep(5);
    await writeFile(join(directory, "README.md"), "Tracked fixture changed at step 6.\n", "utf8");
    const sixth = await prepareStep(6);
    await writeFile(
      join(directory, "AGENTS.md"),
      "Preserve project boundaries and verify edits.\n",
      "utf8",
    );
    const seventh = await prepareStep(7);
    const updatedHtml = initialHtml.replace("login-v1-cache-fixture", "login-v2-cache-fixture");
    await writeFile(join(directory, "login.html"), updatedHtml, "utf8");
    const eighth = await prepareStep(8);

    await runtime.dispose();
    runtime = new LocalRuntime({
      discovery: {
        async find() {
          return { files: [], truncated: false };
        },
      },
    });
    await storage.close();
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    fixtureStorage = createFixtureStorage();
    engine = createTrajectoryEngine();
    const ninth = await prepareStep(9);
    const tenth = await prepareStep(10);

    const current = await storage.promptSurface.getCurrent(run.id);
    if (current === undefined) throw new Error("Prompt Surface epoch was not persisted.");
    const surface = await storage.promptSurface.readEpoch(run.id, current.epochId);
    if (surface === undefined || surface.formatVersion !== 3) {
      throw new Error("Prompt Surface V3 durable state could not be restored.");
    }
    const records = surface.records ?? [];
    const projected = projectPromptSurface(surface);
    const loginSets = records.flatMap((record) =>
      record.updates.filter(
        (update) => update.op === "SET" && update.content.includes('label="login.html"'),
      ),
    );
    const loginVersionHashes = new Set(loginSets.map((update) => update.contentHash));
    const workProgressSets = records.flatMap((record) =>
      record.updates.filter(
        (update) => update.op === "SET" && update.content.includes('label="work progress"'),
      ),
    );
    const workProgressVersions = new Set(workProgressSets.map((update) => update.contentHash));
    const previousHashes = new Map<string, string>();
    let unchangedSectionReemissions = 0;
    for (const record of records) {
      for (const update of record.updates) {
        if (update.op === "CLEAR") {
          previousHashes.delete(update.stateKey);
          continue;
        }
        if (previousHashes.get(update.stateKey) === update.contentHash) {
          unchangedSectionReemissions += 1;
        }
        previousHashes.set(update.stateKey, update.contentHash);
      }
    }
    const metrics = {
      totalRecords: records.length,
      baseline: records.filter((record) => record.kind === "BASELINE").length,
      delta: records.filter((record) => record.kind === "DELTA").length,
      noop: records.filter((record) => record.kind === "NOOP").length,
      set: records.reduce(
        (total, record) => total + record.updates.filter((update) => update.op === "SET").length,
        0,
      ),
      clear: records.reduce(
        (total, record) => total + record.updates.filter((update) => update.op === "CLEAR").length,
        0,
      ),
      newModelVisibleContextBytes: projected.reduce(
        (total, message) => total + Buffer.byteLength(message.content, "utf8"),
        0,
      ),
      projectedRuntimeMessages: projected.length,
      unchangedSectionReemissions,
      loginSetVersions: loginSets.length,
      unchangedLoginReemissions: loginSets.length - loginVersionHashes.size,
      workProgressSetVersions: workProgressSets.length,
      unchangedWorkProgressReemissions: workProgressSets.length - workProgressVersions.size,
    };
    const loginState = surface.sectionStates?.find((state) =>
      state.content.includes('label="login.html"'),
    );

    expect(metrics).toEqual({
      totalRecords: 10,
      baseline: 1,
      delta: 4,
      noop: 5,
      set: 31,
      clear: 0,
      newModelVisibleContextBytes: 19_120,
      projectedRuntimeMessages: 5,
      unchangedSectionReemissions: 0,
      loginSetVersions: 2,
      unchangedLoginReemissions: 0,
      workProgressSetVersions: 2,
      unchangedWorkProgressReemissions: 0,
    });
    expect(loginState?.content).toContain("login-v2-cache-fixture");
    expect(loginState?.content).not.toContain("login-v1-cache-fixture");
    expect(
      fifth.prepared.messages.some((message) => message.content.includes("read_file: completed")),
    ).toBe(true);
    expect(
      fifth.prepared.messages.some((message) => message.content.includes("Read login.html")),
    ).toBe(true);
    expect(
      records
        .flatMap((record) => record.updates)
        .filter((update) => update.op === "SET")
        .some((update) => update.content.includes("never-model-visible-from-commentary")),
    ).toBe(false);
    expect(records.at(-2)?.kind).toBe("NOOP");
    expect(records.at(-1)?.kind).toBe("NOOP");
    expect(
      ninth.prepared.messages.every((message) =>
        ["system", "user", "assistant", "tool"].includes(message.role),
      ),
    ).toBe(true);
    expect(
      tenth.prepared.messages.some((message) => message.content.includes("login-v2-cache-fixture")),
    ).toBe(true);
    function createTrajectoryEngine() {
      return createDaemonV2ContextEngine({
        input: {
          run,
          identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
          cwd: directory,
          explicitPaths: ["login.html"],
          baseSystemPrompt: "Use repository evidence and preserve file contents.",
          runMode: "EXECUTE",
        } as RunAgentContextEngineInput,
        storage: fixtureStorage,
        promptSurfaceStore: fixtureStorage.promptSurface,
        runtime: runtime!,
        gateway: {} as AIGateway,
        messageProjectors: createStandardAgentMessageProjectorRegistry(),
        notifier: { notifyCommitted: () => undefined },
        contributionPipeline: createContextContributionPipeline(),
        clock: { now: () => createTimestampMs(nowMs) },
        activeToolNames: ["read_file"],
      });
    }
  }, 20_000);
});
