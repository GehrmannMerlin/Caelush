import { describe, expect, it } from "vitest";
import { AgentRunSchema, createEventId, createStepId, createTimestampMs } from "@caelush/protocol";
import type { RunId, SessionId, StepId } from "@caelush/protocol";
import { RunExecutionConflictError } from "@caelush/core";
import type { DurableEventDraft, RunContinuationCheckpoint } from "@caelush/core";
import {
  agentAssistantToolCallPart,
  agentTextPart,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  modelMessageSource,
  userMessageSource,
} from "@caelush/agent";
import type { AgentMessage } from "@caelush/agent";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

function checkpoint(runId: RunId, stepId: StepId): RunContinuationCheckpoint {
  return {
    type: "WAITING_TOOL_RESULTS" as const,
    runId,
    sourceStepId: stepId,
    pendingDecision: {
      type: "TOOL_CALLS_REQUESTED" as const,
      modelTurn: {
        callId: "llm_01a04963-5904-73ad-909e-2134fe57547e" as never,
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call_a",
              toolName: "read_file" as const,
              input: { path: "a" },
            },
          ],
        },
      },
      toolRequests: [
        { externalCallId: "call_a", toolName: "read_file" as const, args: { path: "a" } },
      ],
    },
  };
}

function event(
  runId: RunId,
  sessionId: SessionId,
  eventId: ReturnType<typeof createEventId>,
): DurableEventDraft {
  return {
    eventId,
    schemaVersion: 1 as const,
    runId,
    sessionId,
    timestamp: createTimestampMs(120),
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 as const },
    type: "run.started" as const,
    payload: { goal: "test goal" },
  };
}

describe("SqliteRunExecutionStore", () => {
  it("commits all execution rows atomically and rolls back on duplicate events", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const pendingRun = makeRun(session.id);
    const run = AgentRunSchema.parse({
      ...pendingRun,
      status: "RUNNING" as const,
      startedAt: createTimestampMs(110),
    });
    const state = makeState(pendingRun, {
      status: "RUNNING",
      startedAt: createTimestampMs(110),
    });
    const step = makeStep(run.id, {
      id: createStepId(),
      status: "COMPLETED",
      finishedAt: createTimestampMs(120),
    });
    await storage.sessions.insert(session);
    await storage.runs.insert(pendingRun);

    const projectors = createStandardAgentMessageProjectorRegistry();
    const codecs = createStandardAgentMessageCodecRegistry((type) =>
      projectors.currentVersion(type),
    );
    const turns = createDeterministicConversationTurnIdFactory();
    const factory = createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(105),
      turns,
    });
    const scope = {
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
    };
    const user = factory.createUser({
      ...scope,
      source: userMessageSource("GOAL"),
      content: [agentTextPart(run.goal)],
    });
    const assistant = factory.createAssistant({
      ...scope,
      sourceStepId: step.id,
      source: modelMessageSource("llm_fixture"),
      content: [
        agentAssistantToolCallPart({
          toolCallId: "call_a",
          toolName: "read_file",
          input: { path: "a" },
        }),
      ],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_fixture",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
      },
    });
    const assistantAfterFailedEvent = factory.createAssistant({
      ...scope,
      sourceStepId: step.id,
      source: modelMessageSource("llm_fixture_2"),
      content: [agentTextPart("this must roll back")],
      model: {
        kind: "MODEL_TURN",
        callId: "llm_fixture_2",
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP",
      },
    });
    const append = (message: AgentMessage) => {
      const encoded = codecs.encode(message);
      return {
        draft: {
          messageId: message.id,
          sessionId: message.sessionId,
          conversationTurnId: message.conversationTurnId,
          messageType: message.type,
          schemaVersion: encoded.schemaVersion,
          ...(encoded.modelProjectionVersion === undefined
            ? {}
            : { modelProjectionVersion: encoded.modelProjectionVersion }),
          ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
          createdAt: message.createdAt,
          source: message.source,
          audience: message.audience,
          data: encoded.data,
        },
      } as const;
    };

    const result = await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [append(user), append(assistant)],
      continuation: {
        operation: "SET",
        checkpoint: checkpoint(run.id, step.id),
        updatedAt: createTimestampMs(120),
      },
      events: [event(run.id, session.id, createEventId())],
    });
    expect(result.snapshot.run.status).toBe("RUNNING");
    expect(result.snapshot.stateRevision).toBe(1);
    expect(result.snapshot.continuationRevision).toBe(1);
    expect(result.snapshot.conversationRecords).toHaveLength(2);
    expect(
      (await storage.messageRecords.listByRun(run.id)).map((record) => record.messageType),
    ).toEqual(["USER", "ASSISTANT"]);

    await expect(
      storage.execution.commit({
        run,
        state,
        expectedStateRevision: null,
        expectedContinuationRevision: null,
        stepWrites: [],
        messagesToAppend: [],
        events: [],
      }),
    ).rejects.toBeInstanceOf(RunExecutionConflictError);
    expect((await storage.execution.load(run.id))?.stateRevision).toBe(1);

    const duplicateEventId = result.events[0]!.eventId;
    await expect(
      storage.execution.commit({
        run,
        state,
        expectedStateRevision: 1,
        expectedContinuationRevision: 1,
        stepWrites: [],
        messagesToAppend: [append(assistantAfterFailedEvent)],
        events: [event(run.id, session.id, duplicateEventId)],
      }),
    ).rejects.toThrow();
    const afterRollback = await storage.execution.load(run.id);
    expect(afterRollback?.stateRevision).toBe(1);
    expect(afterRollback?.conversationRecords).toHaveLength(2);
    expect(await storage.eventReader.latestSequence(run.id)).toBe(1);
    await storage.close();
  });
});
