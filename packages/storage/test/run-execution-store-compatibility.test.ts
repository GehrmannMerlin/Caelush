import { RunExecutionConflictError, RunExecutionInvariantError } from "@caelush/agent";
import type { AIMessage } from "@caelush/ai";
import { LLMMessageSchema } from "@caelush/llm/messages";
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
import type { DurableEventDraft } from "@caelush/core";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

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
  { role: "user", content: "inspect the project" },
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
  it("preserves a historical Tool artifact pointer across a canonical commit", async () => {
    const { storage, session, run, state, step } = await runningFixture();

    // The Step the historical Tool result belongs to, committed the way it always was.
    await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: [],
      events: [event(run.id, session.id, 110)],
    });

    // A row written before Phase 3C: the durable encoding still carries the artifact pointer, and
    // the canonical Tool-result contract has no field for it.
    await storage.messages.append(run.id, [
      {
        createdAt: createTimestampMs(111),
        message: { role: "user", content: run.goal },
      },
      {
        createdAt: createTimestampMs(112),
        sourceStepId: step.id,
        message: {
          role: "tool",
          toolCallId: "call_legacy",
          toolName: "read_file",
          content: "bounded placeholder",
          isError: false,
          rawArtifactRef: "artifact:call_legacy",
        },
      },
    ] as never);

    // A canonical commit settles the Step and appends; it never rewrites an existing conversation
    // row, which is what makes the historical pointer survive without a migration.
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
        {
          createdAt: createTimestampMs(120),
          sourceStepId: step.id,
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      ],
      events: [event(run.id, session.id, 120)],
    });

    // Read back through the durable repository: the historical pointer is byte-for-byte intact,
    // and the canonical load still projects the row rather than rejecting it.
    const durable = await storage.messages.listByRun(run.id);
    expect(durable).toHaveLength(3);
    expect(durable[1]?.message).toMatchObject({ rawArtifactRef: "artifact:call_legacy" });

    const canonical = await storage.execution.load(run.id);
    expect(canonical?.conversation).toHaveLength(3);
    // The canonical projection has no field for it, so it is dropped in memory and never invented.
    expect(canonical?.conversation[1]?.message).not.toHaveProperty("rawArtifactRef");
    expect(canonical?.conversation[1]?.message).toMatchObject({
      role: "tool",
      toolCallId: "call_legacy",
      content: "bounded placeholder",
    });
    await storage.close();
  });

  it("persists the legacy encoding and loads the canonical conversation unchanged", async () => {
    const { storage, session, run, state, step } = await runningFixture();

    const committed = await storage.execution.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [{ operation: "INSERT", step }],
      messagesToAppend: CANONICAL_CONVERSATION.map((message, index) => ({
        createdAt: createTimestampMs(105 + index),
        ...(message.role === "assistant" ? { sourceStepId: step.id } : {}),
        message,
      })),
      events: [event(run.id, session.id, 120)],
    });

    // The bytes on disk are the encoding the database has always stored: a durable row decodes
    // as an `LLMMessage` and carries no canonical-only member.
    const durable = await storage.messages.listByRun(run.id);
    expect(durable).toHaveLength(CANONICAL_CONVERSATION.length);
    for (const entry of durable) {
      expect(() => LLMMessageSchema.parse(entry.message)).not.toThrow();
    }
    expect(durable.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);

    // ...and the snapshot the Run Layer reads is the canonical conversation, in order.
    const canonical = committed.snapshot.conversation.map((entry) => entry.message);
    expect(canonical).toEqual([...CANONICAL_CONVERSATION]);

    const reloaded = await storage.execution.load(run.id);
    expect(reloaded?.conversation.map((entry) => entry.message)).toEqual([
      ...CANONICAL_CONVERSATION,
    ]);
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
