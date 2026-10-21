import { describe, expect, it } from "vitest";
import { AgentRunSchema, createEventId, createTimestampMs } from "@caelush/protocol";
import type { ResourceGovernanceState } from "@caelush/core";
import {
  agentAssistantTextPart,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createRunEventFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  modelMessageSource,
} from "@caelush/agent";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

describe("Run execution and progress atomicity", () => {
  it("rolls back accepted message and state when the progress revision is stale", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const pendingRun = makeRun(session.id);
    const run = AgentRunSchema.parse({
      ...pendingRun,
      status: "RUNNING",
      startedAt: createTimestampMs(110),
    });
    const step = makeStep(run.id, {
      status: "COMPLETED",
      finishedAt: createTimestampMs(120),
    });
    const state = makeState(run, { status: "RUNNING" });
    await storage.sessions.insert(session);
    await storage.runs.insert(pendingRun);
    await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [],
      events: [],
    });

    const projectors = createStandardAgentMessageProjectorRegistry();
    const codecs = createStandardAgentMessageCodecRegistry((type) =>
      projectors.currentVersion(type),
    );
    const turns = createDeterministicConversationTurnIdFactory();
    const factory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(125),
      turns,
    });
    const assistant = factory.createAssistant({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: step.id,
      source: modelMessageSource("llm_progress"),
      phase: "COMMENTARY",
      content: [agentAssistantTextPart("Accepted after progress.")],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_progress",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
      },
    });
    const encoded = codecs.encode(assistant);
    const draft = {
      messageId: assistant.id,
      sessionId: assistant.sessionId,
      conversationTurnId: assistant.conversationTurnId,
      messageType: assistant.type,
      schemaVersion: encoded.schemaVersion,
      ...(encoded.modelProjectionVersion === undefined
        ? {}
        : { modelProjectionVersion: encoded.modelProjectionVersion }),
      ...(assistant.sourceStepId === undefined ? {} : { sourceStepId: assistant.sourceStepId }),
      createdAt: assistant.createdAt,
      source: assistant.source,
      audience: assistant.audience,
      data: encoded.data,
    };
    const execution = {
      run,
      expectedStateRevision: 1,
      expectedContinuationRevision: null,
      stepWrites: [],
      messagesToAppend: [{ draft }],
      events: [
        createRunEventFactory().messageCommitted(
          run,
          draft,
          createEventId(),
          createTimestampMs(125),
        ),
      ],
    } as const;
    const progress = (revision: number): ResourceGovernanceState => ({
      runId: run.id,
      policyVersion: "adaptive-resource-governance.v2",
      mode: "ADAPTIVE",
      leaseEpoch: 1,
      leaseStartAgentTurns: 0,
      leaseStartToolCalls: 0,
      agentTurnsConsumed: 1,
      toolOperationsConsumed: 0,
      consecutiveNoProgressTurns: 0,
      replanCount: 0,
      resourceGuardState: "NONE",
      recentFingerprints: [],
      lastAcceptedBoundary: {
        kind: "MODEL_TURN",
        sourceStepId: String(step.id),
        messageIds: [String(assistant.id)],
      },
      revision,
      createdAt: createTimestampMs(110),
      updatedAt: createTimestampMs(125),
    });

    await expect(
      storage.execution.commitExecutionWithProgress({
        execution,
        expectedProgressRevision: 0,
        nextProgress: progress(1),
      }),
    ).rejects.toThrow();
    expect(await storage.messageRecords.listByRun(run.id)).toEqual([]);
    expect((await storage.execution.load(run.id))?.stateRevision).toBe(1);
    expect(await storage.resourceGovernance.get(run.id)).toBeNull();
    expect(await storage.eventReader.latestSequence(run.id)).toBe(0);

    const accepted = await storage.execution.commitExecutionWithProgress({
      execution,
      expectedProgressRevision: null,
      nextProgress: progress(0),
    });
    expect(accepted.snapshot.conversationRecords).toHaveLength(1);
    expect(accepted.events).toHaveLength(1);
    expect(await storage.resourceGovernance.get(run.id)).toMatchObject({
      revision: 0,
      lastAcceptedBoundary: {
        kind: "MODEL_TURN",
        sourceStepId: step.id,
        messageIds: [assistant.id],
      },
    });
    expect(await storage.eventReader.latestSequence(run.id)).toBe(1);
    await storage.close();
  });
});
