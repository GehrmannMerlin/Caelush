import { RunExecutionConflictError, RunExecutionInvariantError } from "@caelush/agent";
import type { AIMessage } from "@caelush/ai";
import type { RunContinuationCheckpoint } from "@caelush/agent";
import type { AgentStep } from "@caelush/protocol";
import {
  AgentRunSchema,
  createEventId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationPlanId,
  type RunId,
  type SessionId,
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createAssistantMessageAppend,
  createExternalToolResultMessageAppend,
  createUserMessageAppend,
  type DurableEventDraft,
} from "@caelush/core";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";
import { projectedRunMessages } from "./support/projected-run-messages.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";

/**
 * The storage compatibility cutover, asserted against the real database.
 *
 * The unit-level codec parity lives in `@caelush/core`; what is proved here is that the *store*
 * actually routes through it — on the write path, on the load path, and for every continuation
 * discriminant — while the bytes on disk stay the encoding the database has always stored.
 */

const CALL_ID = "llm_01a04963-5904-73ad-909e-2134fe57547e";

function toolCallDecision(sourceStepId: StepId, runId: RunId): RunContinuationCheckpoint {
  return {
    type: "WAITING_TOOL_RESULTS",
    runId,
    sourceStepId,
    pendingDecision: {
      type: "TOOL_CALLS_REQUESTED",
      modelTurn: {
        callId: CALL_ID as never,
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS",
        assistantMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            {
              type: "tool-call",
              toolCallId: "call_a",
              toolName: "read_file",
              input: { path: "a" },
            },
          ],
        },
      },
      toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a" } }],
    },
  };
}

function event(runId: RunId, sessionId: SessionId, timestamp: number): DurableEventDraft {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: createTimestampMs(timestamp),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "run.started",
    payload: { goal: "test goal" },
  };
}

async function runningFixture(): Promise<{
  storage: Awaited<ReturnType<typeof openCaelushStorage>>;
  session: ReturnType<typeof makeSession>;
  run: ReturnType<typeof AgentRunSchema.parse>;
  state: ReturnType<typeof makeState>;
  step: AgentStep;
}> {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const session = makeSession();
  const pendingRun = makeRun(session.id);
  const run = AgentRunSchema.parse({
    ...pendingRun,
    status: "RUNNING" as const,
    startedAt: createTimestampMs(110),
  });
  const state = makeState(pendingRun, { status: "RUNNING", startedAt: createTimestampMs(110) });
  const step = makeStep(run.id, {
    id: createStepId(),
    status: "COMPLETED",
    finishedAt: createTimestampMs(120),
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(pendingRun);
  return { storage, session, run, state, step };
}

const CANONICAL_CONVERSATION: readonly AIMessage[] = [
  { role: "user", content: "test goal" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      {
        type: "tool-call",
        toolCallId: "call_a",
        toolName: "read_file",
        input: { path: "a.ts", scalar: null, n: 1 },
      },
      { type: "tool-call", toolCallId: "call_b", toolName: "list_directory", input: { path: "." } },
    ],
  },
  {
    role: "tool",
    toolCallId: "call_a",
    toolName: "read_file",
    content: "a.ts:1: hello",
    isError: false,
  },
  {
    role: "tool",
    toolCallId: "call_b",
    toolName: "list_directory",
    content: "Tool operation failed: NOT_FOUND.",
    isError: true,
  },
];

describe("SqliteRunExecutionStore canonical/durable compatibility", () => {
  it("writes new conversation messages only through the V2 record path", async () => {
    const { storage, session, run, state, step } = await runningFixture();
    const messages = testRunMessageAuthority();

    await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [createUserMessageAppend(messages, run, "GOAL")],
      events: [event(run.id, session.id, 110)],
    });

    await storage.execution.commit({
      run,
      state: { ...state, currentStepId: undefined },
      expectedStateRevision: 1,
      expectedContinuationRevision: null,
      stepWrites: [
        {
          operation: "UPDATE",
          step: { ...step, status: "COMPLETED", finishedAt: createTimestampMs(120) },
        },
      ],
      messagesToAppend: [
        createAssistantMessageAppend(messages, run, step.id, {
          callId: CALL_ID as never,
          model: run.model,
          finishReason: "STOP",
          assistantMessage: { role: "assistant", content: [{ type: "text", text: "done" }] },
        }),
      ],
      events: [event(run.id, session.id, 120)],
    });

    const durable = await storage.messageRecords.listByRun(run.id);
    expect(durable.map((record) => record.messageType)).toEqual(["USER", "ASSISTANT"]);
    expect((await storage.execution.load(run.id))?.conversationRecords).toHaveLength(2);
    await storage.close();
  });

  it("persists the legacy encoding and loads the canonical conversation unchanged", async () => {
    const { storage, session, run, state, step } = await runningFixture();
    const messages = testRunMessageAuthority();
    const assistant = CANONICAL_CONVERSATION[1]! as Extract<AIMessage, { role: "assistant" }>;
    const policy = { maxSingleObservationTokens: 11, maxObservationBatchTokens: 22 };

    await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [
        createUserMessageAppend(messages, run, "GOAL"),
        createAssistantMessageAppend(messages, run, step.id, {
          callId: CALL_ID as never,
          model: run.model,
          finishReason: "TOOL_CALLS",
          assistantMessage: assistant,
        }),
        createExternalToolResultMessageAppend(
          messages,
          run,
          step.id,
          CANONICAL_CONVERSATION[2]! as Extract<AIMessage, { role: "tool" }>,
          policy,
        ),
        createExternalToolResultMessageAppend(
          messages,
          run,
          step.id,
          CANONICAL_CONVERSATION[3]! as Extract<AIMessage, { role: "tool" }>,
          policy,
        ),
      ],
      events: [event(run.id, session.id, 120)],
    });

    const durable = await storage.messageRecords.listByRun(run.id);
    expect(durable).toHaveLength(CANONICAL_CONVERSATION.length);
    expect(durable.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);

    const canonical = await projectedRunMessages(storage, run.id);
    expect(canonical).toEqual([...CANONICAL_CONVERSATION]);

    const reloaded = await storage.execution.load(run.id);
    expect(reloaded?.conversationRecords).toHaveLength(CANONICAL_CONVERSATION.length);
    await storage.close();
  });

  it("round-trips every continuation discriminant a Run may legally hold", async () => {
    const observationPolicy = { maxSingleObservationTokens: 11, maxObservationBatchTokens: 22 };
    const testPlanId = createVerificationPlanId();
    const testCheckId = createVerificationCheckId();
    const pendingDecision = (
      toolCallDecision("step" as never, "run" as never) as Extract<
        RunContinuationCheckpoint,
        { type: "WAITING_TOOL_RESULTS" }
      >
    ).pendingDecision;
    const receivedResults = [
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "a.ts:1: hello",
        isError: false,
      },
    ] as const;

    // Each pairing is the one the general Run execution invariant admits: a continuation is only
    // legal for the status that holds it, so testing them together would test the invariant.
    const cases: readonly {
      readonly status: "RUNNING" | "WAITING_RESOURCE";
      readonly stepStatus: "COMPLETED" | "FAILED";
      readonly checkpoint: (runId: RunId, stepId: StepId) => RunContinuationCheckpoint;
    }[] = [
      {
        status: "RUNNING",
        stepStatus: "COMPLETED",
        checkpoint: (runId, stepId) => ({
          type: "WAITING_TOOL_RESULTS",
          runId,
          sourceStepId: stepId,
          pendingDecision,
          receivedResults: [...receivedResults],
          observationPolicy,
        }),
      },
      {
        status: "RUNNING",
        stepStatus: "COMPLETED",
        checkpoint: (runId, stepId) => ({
          type: "WAITING_VERIFICATION_REPAIR",
          runId,
          failedPlanId: testPlanId,
          sourceStepId: stepId,
          failedCheckIds: [testCheckId],
          evidenceIds: [],
          repairCycle: 1,
        }),
      },
      {
        status: "RUNNING",
        // A retry may only name the FAILED Step of the attempt that failed.
        stepStatus: "FAILED",
        checkpoint: (runId, stepId) => ({
          type: "WAITING_RETRY",
          mode: "TOOL_RESULTS",
          runId,
          failedStepId: stepId,
          attempt: 1,
          maxAttempts: 3,
          nextAttemptAt: createTimestampMs(500),
          errorCode: "LLM_NETWORK",
          pendingDecision,
          receivedResults: [...receivedResults],
          sourceStepId: stepId,
          observationPolicy,
        }),
      },
      {
        status: "WAITING_RESOURCE",
        stepStatus: "COMPLETED",
        checkpoint: (runId, stepId) => ({
          type: "WAITING_RESOURCE",
          runId,
          sourceStepId: stepId,
          pendingDecision,
          reason: "NO_PROGRESS",
          replanCount: 2,
        }),
      },
    ];

    for (const testCase of cases) {
      const storage = await openCaelushStorage({ path: ":memory:" });
      const session = makeSession();
      const pendingRun = makeRun(session.id);
      const run = AgentRunSchema.parse({
        ...pendingRun,
        status: testCase.status,
        startedAt: createTimestampMs(110),
      });
      const state = makeState(pendingRun, {
        status: testCase.status,
        startedAt: createTimestampMs(110),
      });
      await storage.sessions.insert(session);
      await storage.runs.insert(pendingRun);

      const step = makeStep(run.id, {
        id: createStepId(),
        status: testCase.stepStatus,
        finishedAt: createTimestampMs(120),
      });
      const checkpoint = testCase.checkpoint(run.id, step.id);
      await storage.execution.commit({
        run,
        state,
        expectedStateRevision: null,
        expectedContinuationRevision: null,
        stepWrites: [{ operation: "INSERT", step }],
        messagesToAppend: [],
        continuation: { operation: "SET", checkpoint, updatedAt: createTimestampMs(130) },
        events: [event(run.id, session.id, 120)],
      });

      const loaded = await storage.execution.load(run.id);
      expect(loaded?.continuation, checkpoint.type).toEqual(checkpoint);
      if (loaded?.continuation?.type === "WAITING_TOOL_RESULTS") {
        // The policy is durable, not re-defaulted on load, and the results stay canonical.
        expect(loaded.continuation.observationPolicy).toEqual(observationPolicy);
        expect(loaded.continuation.receivedResults).toEqual([...receivedResults]);
      }
      if (loaded?.continuation?.type === "WAITING_RETRY") {
        expect(loaded.continuation.mode).toBe("TOOL_RESULTS");
        if (loaded.continuation.mode === "TOOL_RESULTS") {
          expect(loaded.continuation.observationPolicy).toEqual(observationPolicy);
          expect(loaded.continuation.sourceStepId).toBe(step.id);
        }
      }
      await storage.close();
    }
  });

  it("throws the kernel error identity, not a second class with the same name", async () => {
    const { storage, session, run, state, step } = await runningFixture();
    await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [],
      events: [event(run.id, session.id, 120)],
    });

    // A stale revision is the kernel's conflict, so `instanceof` agrees with the throw.
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

    // A Step from another Run is the kernel's invariant violation.
    await expect(
      storage.execution.commit({
        run,
        expectedStateRevision: 1,
        expectedContinuationRevision: null,
        stepWrites: [{ operation: "INSERT", step: { ...step, runId: "other-run" as never } }],
        messagesToAppend: [],
        events: [],
      }),
    ).rejects.toBeInstanceOf(RunExecutionInvariantError);

    await storage.close();
  });

  it("fails closed when a VERIFYING Run has no durable plan to bind", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const pendingRun = makeRun(session.id);
    const run = AgentRunSchema.parse({
      ...pendingRun,
      status: "VERIFYING" as const,
      startedAt: createTimestampMs(110),
    });
    const state = makeState(pendingRun, { status: "VERIFYING", startedAt: createTimestampMs(110) });
    await storage.sessions.insert(session);
    await storage.runs.insert(pendingRun);

    // A VERIFYING Run without its verification continuation is not a Run this store will write,
    // let alone one it will report as VERIFYING.
    await expect(
      storage.execution.commit({
        run,
        state,
        expectedStateRevision: null,
        expectedContinuationRevision: null,
        stepWrites: [],
        messagesToAppend: [],
        events: [event(run.id, session.id, 120)],
      }),
    ).rejects.toBeInstanceOf(RunExecutionInvariantError);

    await storage.close();
  });
});
