import { describe, expect, it } from "vitest";
import {
  AgentRunSchema,
  createEventId,
  createTimestampMs,
  type RunId,
  type SessionId,
} from "@caelush/protocol";
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
import type { DurableEventDraft } from "@caelush/core";
import { RunInputPendingError } from "@caelush/core";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

const NOW = createTimestampMs(500);

function acceptedEvent(runId: RunId, sessionId: SessionId, sequence: number): DurableEventDraft {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: NOW,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "run.input.accepted",
    payload: { inputId: `input-${sequence}`, acceptedSequence: sequence },
  };
}

/** A started, RUNNING Run with its AgentState — the state intake is allowed to accept against. */
async function runningRun(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  overrides: { readonly completionContract?: "NATURAL_V1" } = {},
) {
  const session = makeSession();
  const pending = makeRun(session.id, {
    ...(overrides.completionContract === "NATURAL_V1"
      ? { completionContract: "NATURAL_V1" as const }
      : {}),
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(pending);
  const running = AgentRunSchema.parse({
    ...pending,
    status: "RUNNING",
    startedAt: createTimestampMs(200),
  });
  await storage.execution.commit({
    run: running,
    state: makeState(running),
    expectedStateRevision: null,
    expectedContinuationRevision: null,
    stepWrites: [],
    messagesToAppend: [],
    events: [],
  });
  return { session, run: running };
}

function acceptInput(
  storage: Awaited<ReturnType<typeof openCaelushStorage>>,
  runId: RunId,
  sessionId: SessionId,
  inputId: string,
  text: string,
) {
  return storage.runInputs.accept({
    runId,
    inputId,
    text,
    now: NOW,
    buildEvent: (sequence) => acceptedEvent(runId, sessionId, sequence),
  });
}

describe("SqliteRunInputStore intake", () => {
  it("accepts a text input durably, in sequence, with one metadata event", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });

    const first = await acceptInput(storage, run.id, session.id, uuid(1), " 先改前端  ");
    const second = await acceptInput(storage, run.id, session.id, uuid(2), "后端暂缓");

    expect(first).toMatchObject({ kind: "ACCEPTED" });
    expect(second).toMatchObject({ kind: "ACCEPTED" });
    if (first.kind !== "ACCEPTED" || second.kind !== "ACCEPTED") throw new Error("not accepted");
    expect(first.record).toMatchObject({ stage: "PENDING", acceptedSequence: 1 });
    expect(second.record.acceptedSequence).toBe(2);

    const events = await storage.eventReader.replay(run.id, {
      afterSequence: 0,
      throughSequence: (await storage.eventReader.latestSequence(run.id)) || 1,
      limit: 50,
    });
    expect(events.filter((event) => event.type === "run.input.accepted")).toHaveLength(2);
    // The event is metadata only: neither the text nor any derived content is on it.
    expect(JSON.stringify(events)).not.toContain("先改前端");
  });

  it("is idempotent for the same identity and refuses a different payload", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });

    const first = await acceptInput(storage, run.id, session.id, uuid(3), "keep the API stable");
    const replay = await acceptInput(storage, run.id, session.id, uuid(3), "keep the API stable");
    expect(first.kind).toBe("ACCEPTED");
    expect(replay.kind).toBe("EXISTING");
    if (first.kind !== "ACCEPTED" || replay.kind !== "EXISTING") throw new Error("unexpected");
    expect(replay.record.acceptedSequence).toBe(first.record.acceptedSequence);

    const conflicting = await acceptInput(storage, run.id, session.id, uuid(3), "something else");
    expect(conflicting).toEqual({ kind: "REJECTED", reason: "IDEMPOTENCY_CONFLICT" });

    const listed = await storage.runInputs.list(run.id, { limit: 10 });
    expect(listed.items).toHaveLength(1);
  });

  it("returns the original receipt for a known identity after the Run ends, and refuses a new one", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });
    const accepted = await acceptInput(
      storage,
      run.id,
      session.id,
      uuid(4),
      "use the existing SDK",
    );
    expect(accepted.kind).toBe("ACCEPTED");

    await storage.runs.update(
      AgentRunSchema.parse({ ...run, status: "COMPLETED", finishedAt: createTimestampMs(600) }),
    );

    const replay = await acceptInput(storage, run.id, session.id, uuid(4), "use the existing SDK");
    expect(replay.kind).toBe("EXISTING");
    const late = await acceptInput(storage, run.id, session.id, uuid(5), "one more thing");
    expect(late).toEqual({ kind: "REJECTED", reason: "RUN_TERMINAL" });
  });

  it("bounds the unapplied backlog by count, and a recorded input still occupies capacity", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });
    for (let index = 0; index < 32; index += 1) {
      const result = await acceptInput(
        storage,
        run.id,
        session.id,
        uuid(100 + index),
        `note ${index}`,
      );
      expect(result.kind).toBe("ACCEPTED");
    }
    const overflow = await acceptInput(storage, run.id, session.id, uuid(900), "one too many");
    expect(overflow).toEqual({ kind: "REJECTED", reason: "QUEUE_FULL" });

    const snapshot = storage.runInputs.snapshotFacts(run.id);
    expect(snapshot.pendingCount).toBe(32);
    // The snapshot's text prefix is capped at one boundary's batch, while the count stays complete.
    expect(snapshot.pending).toHaveLength(8);
    expect(snapshot.unassignedCount).toBe(32);
  });

  it("refuses a Run without the persisted natural contract and one that has not started", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage);
    expect(await acceptInput(storage, run.id, session.id, uuid(6), "text")).toEqual({
      kind: "REJECTED",
      reason: "NOT_SUPPORTED",
    });

    const pendingSession = makeSession();
    const pendingRun = makeRun(pendingSession.id, { completionContract: "NATURAL_V1" });
    await storage.sessions.insert(pendingSession);
    await storage.runs.insert(pendingRun);
    expect(await acceptInput(storage, pendingRun.id, pendingSession.id, uuid(7), "text")).toEqual({
      kind: "REJECTED",
      reason: "RUN_NOT_READY",
    });
  });

  it("refuses text over the byte limit and text that is empty after trimming", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });
    expect(await acceptInput(storage, run.id, session.id, uuid(8), "   ")).toEqual({
      kind: "REJECTED",
      reason: "TEXT_TOO_LARGE",
    });
    expect(
      await acceptInput(storage, run.id, session.id, uuid(9), "x".repeat(32 * 1024 + 1)),
    ).toEqual({ kind: "REJECTED", reason: "TEXT_TOO_LARGE" });
  });
});

describe("SqliteRunInputStore handoff and completion arbitration", () => {
  it("records the input and its canonical USER message in one commit, then assigns it on step open", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });
    const accepted = await acceptInput(
      storage,
      run.id,
      session.id,
      uuid(10),
      "prefer the existing API",
    );
    if (accepted.kind !== "ACCEPTED") throw new Error("not accepted");

    const step = makeStep(run.id, { sequence: 1 });
    const activeRun = AgentRunSchema.parse({ ...run, currentStepId: step.id });
    const message = steeringMessage(run.id, session.id, "prefer the existing API");
    await storage.execution.commit({
      run: activeRun,
      state: makeState(activeRun, { currentStepId: step.id }),
      // `runningRun()` already committed the RUNNING state, so this is the second state write.
      expectedStateRevision: 1,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [{ draft: message }],
      runInputs: {
        now: 500,
        handoff: {
          entries: [
            {
              inputId: accepted.record.inputId,
              acceptedSequence: accepted.record.acceptedSequence,
              messageId: message.messageId,
            },
          ],
        },
        assignment: { stepId: step.id, messageIds: [message.messageId] },
      },
      events: [],
    });

    const record = await storage.runInputs.get(run.id, accepted.record.inputId);
    expect(record).toMatchObject({
      stage: "ASSIGNED",
      messageId: message.messageId,
      firstStepId: step.id,
    });
    const snapshot = storage.runInputs.snapshotFacts(run.id);
    expect(snapshot.unassignedCount).toBe(0);
  });

  it("refuses a completion transaction that still owes an unapplied input", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });
    const step = makeStep(run.id, { sequence: 1, startedAt: createTimestampMs(300) });
    const activeRun = AgentRunSchema.parse({ ...run, currentStepId: step.id });
    await storage.execution.commit({
      run: activeRun,
      state: makeState(activeRun, { currentStepId: step.id }),
      // `runningRun()` already committed the RUNNING state, so this is the second state write.
      expectedStateRevision: 1,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [],
      events: [],
    });

    const accepted = await acceptInput(
      storage,
      run.id,
      session.id,
      uuid(11),
      "wait, use the old parser",
    );
    expect(accepted.kind).toBe("ACCEPTED");

    const text = "All checks passed.";
    const finalResult = { type: "NORMAL_COMPLETION" as const, text, sourceStepId: step.id };
    const completedRun = AgentRunSchema.parse({
      ...activeRun,
      status: "COMPLETED",
      currentStepId: undefined,
      finishedAt: createTimestampMs(600),
      finalResult,
    });
    const completedState = makeState(completedRun, {
      status: "COMPLETED",
      currentStepId: undefined,
      usage: { steps: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1 },
      updatedAt: createTimestampMs(600),
    });
    const assistant = assistantMessage(run.id, session.id, step.id, text);
    const event = (type: "message" | "status" | "completed", eventId = createEventId()) =>
      ({
        eventId,
        schemaVersion: 1,
        runId: run.id,
        sessionId: session.id,
        timestamp: createTimestampMs(600),
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1 },
        ...(type === "message"
          ? {
              type: "conversation.message.committed" as const,
              payload: {
                messageId: assistant.messageId,
                conversationTurnId: assistant.conversationTurnId,
                messageType: "ASSISTANT",
              },
            }
          : type === "status"
            ? {
                type: "status.changed" as const,
                payload: { from: "RUNNING" as const, to: "COMPLETED" as const },
              }
            : { type: "run.completed" as const, payload: { result: finalResult } }),
      }) as DurableEventDraft;

    await expect(
      storage.execution.commit({
        run: completedRun,
        state: completedState,
        // The step-open commit above wrote the state once more.
        expectedStateRevision: 2,
        expectedContinuationRevision: null,
        stepWrites: [
          {
            operation: "UPDATE",
            step: { ...step, status: "COMPLETED", finishedAt: createTimestampMs(600) },
          },
        ],
        messagesToAppend: [{ draft: assistant }],
        events: [event("message"), event("status"), event("completed")],
      }),
    ).rejects.toBeInstanceOf(RunInputPendingError);

    const after = await storage.execution.load(run.id);
    expect(after?.run.status).toBe("RUNNING");
    expect(after?.conversationRecords).toHaveLength(0);
  });

  it("serializes concurrent acceptance so no two inputs share a sequence", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const { session, run } = await runningRun(storage, { completionContract: "NATURAL_V1" });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        acceptInput(storage, run.id, session.id, uuid(200 + index), `correction ${index}`),
      ),
    );
    const sequences = results.flatMap((result) =>
      result.kind === "ACCEPTED" ? [result.record.acceptedSequence] : [],
    );
    expect(sequences).toHaveLength(6);
    expect(new Set(sequences).size).toBe(6);
    expect([...sequences].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function steeringMessage(runId: RunId, sessionId: SessionId, text: string) {
  const turns = createDeterministicConversationTurnIdFactory();
  const factory = createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => createTimestampMs(500),
    turns,
  });
  const projectors = createStandardAgentMessageProjectorRegistry();
  const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));
  const message = factory.createUser({
    runId,
    sessionId,
    conversationTurnId: turns.forRun(runId),
    source: { kind: "USER", origin: "STEERING" },
    content: [{ type: "TEXT", text }],
  });
  const encoded = codecs.encode(message);
  return {
    messageId: message.id,
    sessionId,
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

function assistantMessage(runId: RunId, sessionId: SessionId, stepId: string, text: string) {
  const turns = createDeterministicConversationTurnIdFactory();
  const factory = createAgentMessageFactory({
    ids: createAgentMessageIdFactory(),
    now: () => createTimestampMs(600),
    turns,
  });
  const projectors = createStandardAgentMessageProjectorRegistry();
  const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));
  const message = factory.createAssistant({
    runId,
    sessionId,
    conversationTurnId: turns.forRun(runId),
    sourceStepId: stepId as never,
    source: modelMessageSource("llm_final"),
    phase: "FINAL_ANSWER",
    content: [agentAssistantTextPart(text)],
    model: {
      kind: "MODEL_TURN",
      callId: "llm_final",
      model: { provider: "test", model: "test-model" },
      finishReason: "STOP",
    },
  });
  const encoded = codecs.encode(message);
  return {
    messageId: message.id,
    sessionId,
    conversationTurnId: message.conversationTurnId,
    messageType: message.type,
    schemaVersion: encoded.schemaVersion,
    ...(encoded.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: encoded.modelProjectionVersion }),
    sourceStepId: stepId,
    createdAt: message.createdAt,
    source: message.source,
    audience: message.audience,
    data: encoded.data,
  };
}

// The factory is imported for its side-effect-free construction in the two helpers above; keeping
// the reference here documents that the fixtures and production build messages the same way.
void createRunEventFactory;
