import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIGateway, AIModelTurnResult, ModelDescriptor } from "@caelush/ai";
import {
  createAgentConversationSnapshot,
  createContextCompactionPlanner,
  createContextHistoryIndexer,
  createContextPolicy,
  createContextContributionPipeline,
  createCompactionSourceCoverageDigest,
  createConversationTurn,
  deriveCompactionAttemptIdentity,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  type AgentMessage,
  type AgentMessageRecordDraft,
  type StoredAgentMessage,
} from "@caelush/agent";
import type { RunAgentContextEngineInput } from "@caelush/core";
import {
  AgentStepSchema,
  AgentRunSchema,
  AgentSessionSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  normalizeCreateRunResourcePolicy,
} from "@caelush/protocol";
import { LocalRuntime } from "@caelush/runtime";
import { expandPermissionPreset } from "@caelush/security";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonV2ContextEngine } from "../src/context/v2-context-composition.js";
import {
  assistantMessage,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "../../../packages/agent/test/messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "working-set" },
  api: "fixture-api",
  limits: { contextWindowTokens: 64_000, maxOutputTokens: 2_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "SUPPORTED",
    structuredOutput: "UNKNOWN",
    vision: "UNSUPPORTED",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

let directory: string | undefined;
let storage: Awaited<ReturnType<typeof openCaelushStorage>> | undefined;
let runtime: LocalRuntime | undefined;

function toMessageRecordDraft(
  message: AgentMessage,
  codecs: ReturnType<typeof createStandardAgentMessageCodecRegistry>,
): AgentMessageRecordDraft {
  const encoded = codecs.encode(message);
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    conversationTurnId: message.conversationTurnId,
    messageType: message.type,
    schemaVersion: encoded.schemaVersion,
    ...(encoded.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: encoded.modelProjectionVersion }),
    createdAt: message.createdAt,
    source: message.source,
    audience: message.audience,
    data: encoded.data,
  };
}

afterEach(async () => {
  await runtime?.dispose();
  await storage?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  runtime = undefined;
  storage = undefined;
  directory = undefined;
});

describe("daemon WORKING_SET_V2 current-turn integration", () => {
  it("atomically compacts a single active turn and restores the same selected work after restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-current-turn-working-set-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    runtime = new LocalRuntime({
      discovery: {
        async find() {
          return { files: [], truncated: false };
        },
      },
    });
    const session = AgentSessionSchema.parse({
      id: createSessionId(),
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
      metadata: {},
    });
    const resourcePolicy = normalizeCreateRunResourcePolicy({
      limits: { maxSteps: 20, maxToolCalls: 20, timeoutMs: 60_000 },
    });
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: session.id,
      goal: "Preserve the current plan, unresolved question, and next action while shrinking old work.",
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: directory },
      model: MODEL.ref,
      runtime: { id: "local", kind: "local" },
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      securityPolicy: expandPermissionPreset({
        presetId: "FULL_ACCESS",
        expectedVersion: 1,
        createdAt: new Date(1).toISOString(),
      }),
      resourcePolicy,
      contextBudgetPolicy: {
        version: "WORKING_SET_V2",
        requestBudget: { version: "LEGACY_FULL_OUTPUT_V1" },
        workingSet: {
          targetTokens: 10_000,
          triggerRatio: 0.75,
          postCompactionRatio: 0.5,
          allowCurrentTurnPrefix: true,
          cooldownTurns: 5,
        },
      },
      limits: { maxSteps: 20, maxToolCalls: 20, timeoutMs: 60_000 },
      createdAt: createTimestampMs(1),
    });
    const contextStepId = createStepId();
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(
      AgentStepSchema.parse({
        id: contextStepId,
        runId: run.id,
        sequence: 1,
        status: "RUNNING",
        startedAt: createTimestampMs(2),
      }),
    );
    await storage.resourceGovernance.createOrGet(run.id, {
      policyVersion: "adaptive-resource-governance.v1",
      mode: resourcePolicy.mode,
      now: createTimestampMs(1),
    });

    const turnId = turnIdFor(String(run.id));
    const messages: StoredAgentMessage[] = [
      userMessage({
        runId: String(run.id),
        sessionId: String(session.id),
        turnId,
        sequence: 1,
        text: "Current goal: finish the page. Plan: keep the layout, repair the form, then check it. Unresolved: validation timing. Next action: inspect the latest output.",
      }),
    ];
    for (let index = 0; index < 6; index += 1) {
      const callId = `old_working_set_call_${String(index)}`;
      messages.push(
        assistantMessage({
          runId: String(run.id),
          sessionId: String(session.id),
          turnId,
          sequence: index * 2 + 2,
          toolCalls: [callId],
        }),
        toolResultMessage({
          runId: String(run.id),
          sessionId: String(session.id),
          turnId,
          sequence: index * 2 + 3,
          toolCallId: callId,
          observationBacked: false,
          projectedContent: `OLD_BATCH_${String(index)} ${"historical evidence ".repeat(1_200)}`,
        }),
      );
    }
    const openCalls = ["open_working_set_a", "open_working_set_b"];
    messages.push(
      assistantMessage({
        runId: String(run.id),
        sessionId: String(session.id),
        turnId,
        sequence: 14,
        toolCalls: openCalls,
      }),
      toolResultMessage({
        runId: String(run.id),
        sessionId: String(session.id),
        turnId,
        sequence: 15,
        toolCallId: openCalls[0],
        observationBacked: false,
        projectedContent:
          "The first call in the open batch has returned; the second remains pending.",
      }),
    );
    const originalMessages = structuredClone(messages);
    const messageProjectors = createStandardAgentMessageProjectorRegistry();
    const messageCodecs = createStandardAgentMessageCodecRegistry((type) =>
      messageProjectors.currentVersion(type),
    );
    await storage.messageRecords.append(
      run.id,
      messages.map((stored) => toMessageRecordDraft(stored.message, messageCodecs)),
    );
    const turn = createConversationTurn({
      id: turnId,
      sessionId: session.id,
      runId: run.id,
      status: "OPEN",
      openedAt: run.createdAt,
      messages,
    });
    const conversation = createAgentConversationSnapshot({
      sessionId: session.id,
      currentRunId: run.id,
      currentTurnId: turn.id,
      turns: [turn],
    });
    const debugHistory = createContextHistoryIndexer().index({ conversation, model: MODEL });
    const debugPolicy = createContextPolicy({
      model: MODEL,
      tools: [],
      options: {
        workingSet: {
          targetTokens: 10_000,
          triggerRatio: 0.75,
          postCompactionRatio: 0.5,
          allowCurrentTurnPrefix: true,
          cooldownTurns: 5,
        },
      },
    });
    const debugPlan = createContextCompactionPlanner().plan({
      history: debugHistory,
      policy: debugPolicy,
      reason: "PROACTIVE_PRESSURE",
    });
    expect(debugPlan?.sourceRange).toMatchObject({ firstSequence: 2 });
    expect(debugPlan?.sourceRange.lastSequence).toBeLessThan(12);
    let summaryCalls = 0;
    const gateway = {
      async complete() {
        summaryCalls += 1;
        return {
          callId: "llm_current_turn_compaction" as never,
          providerId: "fixture" as never,
          model: MODEL.ref,
          text: JSON.stringify({
            constraints: ["Preserve the user's current plan and next action."],
            completedWork: ["Earlier Tool batches were compacted."],
            inProgress: ["Continue from the newest retained batch."],
            blocked: [],
            importantDiscoveries: ["The current tool batch is still open."],
            keyDecisions: [],
            criticalReferences: [],
            nextIntent: "Continue the open batch, then inspect the latest output.",
          }),
          toolCalls: [],
          finishReason: "STOP",
          resolution: {},
        } as unknown as AIModelTurnResult;
      },
    } as unknown as AIGateway;

    const prepare = async () => {
      const engine = createDaemonV2ContextEngine({
        input: {
          run,
          identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
          cwd: directory!,
          baseSystemPrompt: "Preserve user intent and compact only complete old Tool batches.",
          runMode: "EXECUTE",
        } as RunAgentContextEngineInput,
        storage: storage!,
        promptSurfaceStore: storage!.promptSurface,
        runtime: runtime!,
        gateway,
        messageProjectors: createStandardAgentMessageProjectorRegistry(),
        notifier: { notifyCommitted: () => undefined },
        contributionPipeline: createContextContributionPipeline(),
        clock: { now: () => createTimestampMs(10_000) },
        activeToolNames: [],
      });
      return engine.prepare({
        identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
        turn: { stepId: contextStepId, sequence: 1 },
        conversation,
        input: { kind: "CONTINUATION", reason: "TOOL_RESULT" },
        model: MODEL,
        tools: [],
        mode: "NORMAL",
        signal: new AbortController().signal,
      });
    };

    const first = await prepare();
    expect(summaryCalls).toBe(1);
    expect(first.report.compactionCount).toBe(1);
    const candidates = await storage.contextCheckpointsV3.listCandidatesBySession({
      sessionId: run.sessionId,
      throughRunId: run.id,
    });
    expect(candidates.records).toHaveLength(1);
    const latestEventSequence = await storage.eventReader.latestSequence(run.id);
    const committedEvents = await storage.eventReader.replay(run.id, {
      afterSequence: 0,
      throughSequence: latestEventSequence,
      limit: 10,
    });
    const compactionEvents = committedEvents.filter(
      (event) => event.type === "context.compaction.completed",
    );
    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0]?.schemaVersion).toBe(2);
    expect(compactionEvents[0]?.stepId).toBeUndefined();
    const checkpoint = candidates.records[0];
    if (checkpoint === undefined || checkpoint.schemaVersion !== 3) {
      throw new Error("A V3 current-turn checkpoint was not committed.");
    }
    const attemptSourceRefs = new Map<
      string,
      { runId: string; conversationTurnId: string; messageId: string; sequence: number }
    >();
    for (const unit of debugHistory.units) {
      if (unit.status !== "CLOSED" || !unit.compactionEligible) continue;
      for (const ref of unit.messages) {
        const messageId = String(ref.messageId);
        attemptSourceRefs.set(messageId, {
          runId: String(ref.runId),
          conversationTurnId: String(ref.conversationTurnId),
          messageId,
          sequence: ref.sequence,
        });
      }
    }
    const attemptSourceDigest = createCompactionSourceCoverageDigest({
      messageRefs: [...attemptSourceRefs.values()].sort(
        (left, right) => left.sequence - right.sequence,
      ),
    });
    const attemptId = deriveCompactionAttemptIdentity({
      sessionId: run.sessionId,
      sourceKey: attemptSourceDigest,
      retryGeneration: 0,
      failureFamily: "AUTOMATIC_ATTEMPT",
    }).attemptId;
    const attemptArtifacts = await storage.contextArtifactsV2.listBySourceRef({
      kind: "context-compaction-attempt",
      sourceRef: attemptId,
      limit: 10,
    });
    const attemptRecords = await Promise.all(
      attemptArtifacts.records.map(async (artifact) => {
        const persisted = await storage!.contextArtifactsV2.readInternal(artifact.artifactId);
        if (persisted === undefined) throw new Error("A compaction attempt artifact disappeared.");
        return JSON.parse(persisted.content) as { recordType: string; state?: string };
      }),
    );
    const subcallArtifacts = await storage.contextArtifactsV2.listBySourceRef({
      kind: "context-compaction-subcall",
      sourceRef: `${attemptId}:subcall:00`,
      limit: 10,
    });
    const subcallRecords = await Promise.all(
      subcallArtifacts.records.map(async (artifact) => {
        const persisted = await storage!.contextArtifactsV2.readInternal(artifact.artifactId);
        if (persisted === undefined) throw new Error("A compaction subcall artifact disappeared.");
        return JSON.parse(persisted.content) as { recordType: string; state?: string };
      }),
    );
    expect(attemptRecords.map(({ state }) => state).sort()).toEqual(["RESULT", "START"]);
    expect(subcallRecords).toHaveLength(2);
    expect(subcallRecords.map(({ state }) => state).sort()).toEqual(["RESULT", "START"]);
    expect(subcallRecords.every(({ recordType }) => recordType === "SUBCALL")).toBe(true);
    expect(checkpoint.coverage.segments[0]).toMatchObject({
      runId: run.id,
      conversationTurnId: turn.id,
      firstSequence: 2,
    });
    expect(checkpoint.coverage.segments[0]?.lastSequence).toBeLessThan(12);
    expect(first.selectedMessageIds).not.toContain(messages[2]?.message.id);
    expect(first.selectedMessageIds).toContain(messages[11]?.message.id);
    expect(first.selectedMessageIds).toContain(messages[13]?.message.id);
    expect(first.selectedMessageIds).toContain(messages[14]?.message.id);
    expect(
      first.messages.some((message) => message.content.includes("Current goal: finish the page")),
    ).toBe(true);
    expect(first.messages.some((message) => message.content.includes("OLD_BATCH_0"))).toBe(false);
    expect(originalMessages).toEqual(messages);
    const surface = await storage.promptSurface.getCurrent(run.id);
    expect(surface?.formatVersion).toBe(3);

    await storage.close();
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const recovered = await prepare();
    expect(recovered.selectedMessageIds).toEqual(first.selectedMessageIds);
    const recoveredCandidates = await storage.contextCheckpointsV3.listCandidatesBySession({
      sessionId: run.sessionId,
      throughRunId: run.id,
    });
    expect(recoveredCandidates.records).toHaveLength(1);
    expect(
      recovered.messages.some((message) =>
        message.content.includes("Current goal: finish the page"),
      ),
    ).toBe(true);
    expect(recovered.messages.some((message) => message.content.includes("OLD_BATCH_0"))).toBe(
      false,
    );
  }, 30_000);
});
