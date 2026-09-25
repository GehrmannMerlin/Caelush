import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentConversationSnapshot,
  createAgentMessageBase,
  createAgentTurnRef,
  createAgentUserMessage,
  createConversationTurn,
  createStandardAgentMessageProjectorRegistry,
  agentMessageId,
  agentTextPart,
  conversationTurnId,
  createControlHookId,
  createControlHookRegistryBuilder,
  createControlHookRunner,
  createContextContributionPipeline,
  type ContextContributionHook,
  type ContextContributionRegistration,
} from "@caelush/agent";
import {
  ContextBuilder,
  type Artifact,
  type ContextArtifactCreateInput,
  type ContextArtifactRepository,
} from "@caelush/context";
import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createLegacyContextRuntimeAdapter } from "../src/legacy-context-runtime-adapter.js";
import type { SelectedAgentConversation } from "@caelush/agent";

class FileContextArtifacts implements ContextArtifactRepository {
  constructor(private readonly filePath: string) {}

  private async readRecords(): Promise<Record<string, Artifact>> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, Artifact>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async createOrGet(input: ContextArtifactCreateInput): Promise<Artifact> {
    const artifactId = input.artifactId ?? `artifact:${input.content}`;
    const records = await this.readRecords();
    const existing = records[artifactId];
    if (existing !== undefined) return existing;
    const artifact: Artifact = Object.freeze({
      artifactId,
      runId: input.runId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      contentHash: createHash("sha256").update(input.content, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(input.content, "utf8"),
      mimeType: input.mimeType,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
      sensitivity: input.sensitivity,
      content: input.content,
    });
    records[artifactId] = artifact;
    await writeFile(this.filePath, JSON.stringify(records), "utf8");
    return artifact;
  }

  async getMetadata(artifactId: string) {
    const artifact = (await this.readRecords())[artifactId];
    if (artifact === undefined) return undefined;
    return {
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      kind: artifact.kind,
      sourceRef: artifact.sourceRef,
      contentHash: artifact.contentHash,
      byteLength: artifact.byteLength,
      mimeType: artifact.mimeType,
      createdSequence: artifact.createdSequence,
      createdAt: artifact.createdAt,
      sensitivity: artifact.sensitivity,
    };
  }

  async readInternal(artifactId: string) {
    return (await this.readRecords())[artifactId];
  }

  async readSafeProjection(artifactId: string, maxBytes: number) {
    void maxBytes;
    return (await this.readRecords())[artifactId]?.content;
  }
}

function fixture() {
  const runId = createRunId();
  const sessionId = createSessionId();
  const stepId = createStepId();
  const turnId = conversationTurnId("cturn_phase_6f");
  const user = createAgentUserMessage(
    createAgentMessageBase({
      id: agentMessageId("amsg_phase_6f_user"),
      runId,
      sessionId,
      conversationTurnId: turnId,
      createdAt: createTimestampMs(1),
      source: { kind: "USER", origin: "GOAL" },
      audience: { model: true, transcript: true, debug: true },
    }),
    [agentTextPart("hello")],
  );
  const turn = createConversationTurn({
    id: turnId,
    sessionId,
    runId,
    status: "OPEN",
    openedAt: createTimestampMs(1),
    messages: [{ sequence: 1, schemaVersion: 1, modelProjectionVersion: 1, message: user }],
  });
  const conversation = createAgentConversationSnapshot({
    sessionId,
    currentRunId: runId,
    currentTurnId: turnId,
    turns: [turn],
  });
  const selected: SelectedAgentConversation = {
    turns: [turn],
    selectedMessageIds: [user.id],
    droppedMessageIds: [],
    estimatedTokens: 1,
    requiresCompaction: false,
  };
  const registry = createControlHookRegistryBuilder<ContextContributionHook>();
  let invocations = 0;
  let lastMode: string | undefined;
  const registration: ContextContributionRegistration = {
    id: createControlHookId("phase-6f-test"),
    priority: 1,
    criticality: "REQUIRED",
    timeoutMs: 100,
    hook: {
      contribute: async (_input, context) => {
        invocations += 1;
        lastMode = context.mode;
        return [
          {
            id: "facts",
            source: "phase-6f-test",
            replay: "SNAPSHOT" as const,
            items: [
              {
                id: "fact",
                priorityClass: "NORMAL" as const,
                tokenEstimate: 0,
                content: "phase-6f contribution",
              },
            ],
          },
        ];
      },
    },
  };
  registry.register(registration);
  const pipeline = createContextContributionPipeline({
    registry: registry.build(),
    runner: createControlHookRunner({
      pipelineId: "context-contribution",
      clock: { now: () => createTimestampMs(2) },
    }),
    pipelineId: "context-contribution",
    clock: { now: () => createTimestampMs(2) },
  });
  const model = {
    ref: { provider: "fixture", model: "fixture-model" },
    api: "fixture-api",
    limits: { contextWindowTokens: 2_000, maxOutputTokens: 100 },
    capabilities: {
      streaming: "SUPPORTED" as const,
      toolCalling: "SUPPORTED" as const,
      parallelToolCalls: "UNKNOWN" as const,
      structuredOutput: "UNKNOWN" as const,
      vision: "UNKNOWN" as const,
      reasoning: "UNKNOWN" as const,
      reasoningSummary: "UNKNOWN" as const,
      promptCaching: "UNKNOWN" as const,
      usageReporting: "UNKNOWN" as const,
    },
    source: "CONFIGURATION" as const,
  };
  const input = {
    identity: { runId, sessionId, goal: "hello" },
    turn: createAgentTurnRef(stepId, 1),
    conversation,
    input: { kind: "USER_INPUT" as const, userMessageId: user.id },
    model,
    tools: [],
    mode: "NORMAL" as const,
    signal: new AbortController().signal,
  };
  const makeAdapter = (
    artifacts: ContextArtifactRepository | undefined,
    runMode: "EXECUTE" | "RECOVER" = "EXECUTE",
  ) =>
    createLegacyContextRuntimeAdapter({
      contextBuilder: new ContextBuilder(),
      contextRuntime: {
        prepareModelContext: (request) => ({
          messages: [
            {
              role: "system",
              content: `<context_contributions>${JSON.stringify(request.context.contextContributionItems ?? [])}</context_contributions>`,
            },
          ],
          report: {
            limits: {
              maxInputTokens: 2_000,
              safetyMarginTokens: 0,
              maxConversationTokens: 2_000,
              maxRelevantFileTokens: 2_000,
              minRelevantFileTokens: 0,
            },
            estimatedInputTokens: 0,
            remainingTokens: 2_000,
            systemTokens: 0,
            currentUserTokens: 0,
            currentTurn: { type: "USER_TURN", messageCount: 0, estimatedTokens: 0 },
            mandatoryTokens: 0,
            snapshotDiagnosticCount: 0,
            conversation: {
              providedMessages: 0,
              selectedMessages: 0,
              droppedMessages: 0,
              providedTurns: 0,
              selectedTurns: 0,
              droppedTurns: 0,
              estimatedTokensUsed: 0,
              requiresCompaction: false,
              latestTurnTooLarge: false,
            },
            relevantFiles: {
              providedFiles: 0,
              selectedFiles: 0,
              droppedFiles: 0,
              estimatedTokensUsed: 0,
              furtherTruncatedFiles: 0,
            },
            system: {
              instructionCount: 0,
              instructionBytes: 0,
              snapshotDiagnosticCount: 0,
              projectRoot: "/repo",
            },
          },
        }),
      },
      conversationProjectors: createStandardAgentMessageProjectorRegistry(),
      conversationSelector: { select: () => selected },
      baseSystemPrompt: "base",
      contextLimits: { maxInputTokens: 2_000, safetyMarginTokens: 0 },
      workspace: { id: createWorkspaceId(), path: "/repo" },
      contextContributionPipeline: pipeline,
      ...(artifacts === undefined ? {} : { contextArtifacts: artifacts }),
      runMode,
      now: () => createTimestampMs(2),
    });
  return {
    input,
    pipeline,
    makeAdapter,
    get invocations() {
      return invocations;
    },
    get lastMode() {
      return lastMode;
    },
  };
}

describe("Phase 6F Context Contribution recovery", () => {
  it("persists before materialization and reloads the same snapshot without re-invoking the Hook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-phase-6f-recovery-"));
    const state = fixture();
    const artifactPath = join(directory, "context-artifacts.json");
    try {
      const first = await state
        .makeAdapter(new FileContextArtifacts(artifactPath))
        .prepare(state.input);
      expect(first.messages[0]?.content).toContain("<context_contributions>");
      expect(first.messages[0]?.content).toContain("phase-6f contribution");
      expect(state.invocations).toBe(1);

      // Destroy the first adapter and repository instance. The second adapter reads the
      // persisted envelope through a newly constructed repository, not a process-local cache.
      const recovered = await state
        .makeAdapter(new FileContextArtifacts(artifactPath), "RECOVER")
        .prepare(state.input);
      expect(recovered.messages[0]?.content).toContain("phase-6f contribution");
      expect(state.invocations).toBe(1);
      expect(state.lastMode).toBe("EXECUTE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails before Context/Provider materialization when a required snapshot repository is absent", async () => {
    const state = fixture();
    const adapter = createLegacyContextRuntimeAdapter({
      contextBuilder: new ContextBuilder(),
      conversationProjectors: createStandardAgentMessageProjectorRegistry(),
      conversationSelector: {
        select: () =>
          state.input.conversation.turns.length > 0
            ? {
                turns: state.input.conversation.turns,
                selectedMessageIds: [],
                droppedMessageIds: [],
                estimatedTokens: 1,
                requiresCompaction: false,
              }
            : {
                turns: [],
                selectedMessageIds: [],
                droppedMessageIds: [],
                estimatedTokens: 0,
                requiresCompaction: false,
              },
      },
      baseSystemPrompt: "base",
      contextLimits: { maxInputTokens: 2_000, safetyMarginTokens: 0 },
      workspace: { id: createWorkspaceId(), path: "/repo" },
      contextContributionPipeline: state.pipeline,
    });
    await expect(adapter.prepare(state.input)).rejects.toThrow("artifact repository");
    expect(state.invocations).toBe(1);
  });

  it("fails closed for a corrupt persisted snapshot instead of recollecting the Hook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-phase-6f-corrupt-"));
    const state = fixture();
    const artifactPath = join(directory, "context-artifacts.json");
    try {
      await state.makeAdapter(new FileContextArtifacts(artifactPath)).prepare(state.input);
      const records = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, Artifact>;
      const [artifactId, artifact] = Object.entries(records)[0] ?? [];
      expect(artifactId).toBeDefined();
      expect(artifact).toBeDefined();
      if (artifactId === undefined || artifact === undefined)
        throw new Error("artifact was not persisted");
      records[artifactId] = { ...artifact, content: "corrupt" };
      await writeFile(artifactPath, JSON.stringify(records), "utf8");

      await expect(
        state.makeAdapter(new FileContextArtifacts(artifactPath), "RECOVER").prepare(state.input),
      ).rejects.toThrow("metadata is incompatible");
      expect(state.invocations).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
