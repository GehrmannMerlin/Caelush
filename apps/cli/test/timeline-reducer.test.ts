import {
  createEventId,
  createApprovalRequestId,
  createPlanItemId,
  createRunId,
  createSessionId,
  createStepId,
  createVerificationCheckId,
  createVerificationPlanId,
  type AgentEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createInitialTimelineState,
  reduceTimelineEvent as reduceSharedTimelineEvent,
} from "@caelush/client";
import { createInitialCliTimelineState as createInitialCliTimelineStateFromModel } from "../src/application/timeline-model.js";
import {
  createInitialCliTimelineState,
  flushTimelineForTerminal,
  reduceTimelineEvent,
} from "../src/application/timeline-reducer.js";

const runId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();
const invocationId = "tinv_00000000-0000-7000-8000-000000000000" as const;
const processId = "process-1";

describe("CLI timeline reducer", () => {
  it("resolves CLI Timeline through the shared implementation", () => {
    expect(createInitialCliTimelineStateFromModel(runId)).toEqual(
      createInitialTimelineState(runId),
    );
    expect(reduceTimelineEvent).toBe(reduceSharedTimelineEvent);
  });

  it("aggregates a Tool lifecycle into one settled entry by invocationId", () => {
    let state = createInitialCliTimelineState(runId);
    state = reduceTimelineEvent(
      state,
      eventOf("tool.requested", 1, {
        invocationId,
        toolName: "read_file",
        riskLevel: "LOW",
        title: "Read file",
        summary: "Read file src/index.ts",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("tool.started", 2, { invocationId }, { title: "Read file" }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("tool.output", 3, { invocationId, stream: "stdout", chunk: "2 lines" }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("tool.completed", 4, {
        invocationId,
        observationId: "tobs_00000000-0000-7000-8000-000000000000",
      }),
    );

    expect(state.activeTools).toEqual([]);
    expect(state.settled).toHaveLength(1);
    expect(state.settled[0]).toMatchObject({
      kind: "TOOL",
      invocationId,
      status: "COMPLETED",
      title: "Read file",
    });
    expect(state.settled[0]!.text).toContain("2 lines");
  });

  it("fails closed on conflicting durable sequence and ignores exact replay", () => {
    const first = eventOf("reasoning.summary", 1, { summary: "Inspecting workspace" });
    const state = reduceTimelineEvent(createInitialCliTimelineState(runId), first);
    const replay = reduceTimelineEvent(state, first);
    expect(replay).toBe(state);

    const conflict = reduceTimelineEvent(
      state,
      eventOf("reasoning.summary", 1, { summary: "Different event" }),
    );
    expect(conflict.error).toBe("Timeline event order could not be verified.");
    expect(conflict.lastDurableSequence).toBe(1);
  });

  it("ignores non-user events and does not advance the cursor for ephemeral events", () => {
    const state = createInitialCliTimelineState(runId);
    const debug = eventOf("reasoning.summary", 1, { summary: "hidden" }, { visibility: "DEBUG" });
    const ephemeral = eventOf(
      "reasoning.summary",
      undefined,
      { summary: "visible ephemeral" },
      { durability: { kind: "EPHEMERAL" } },
    );

    const afterDebug = reduceTimelineEvent(state, debug);
    const afterEphemeral = reduceTimelineEvent(afterDebug, ephemeral);

    expect(afterDebug).toBe(state);
    expect(afterEphemeral.lastDurableSequence).toBe(0);
    expect(afterEphemeral.settled[0]!.text).toBe("visible ephemeral");
  });

  it("deduplicates consecutive reasoning summaries and keeps bounded output", () => {
    let state = createInitialCliTimelineState(runId, { maxTextBytes: 40 });
    state = reduceTimelineEvent(
      state,
      eventOf("reasoning.summary", 1, { summary: "same summary" }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("reasoning.summary", 2, { summary: "same summary" }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("reasoning.summary", 3, { summary: "😀😀😀😀😀😀😀😀😀😀😀😀" }),
    );

    expect(state.settled).toHaveLength(2);
    expect(Buffer.byteLength(state.settled[1]!.text, "utf8")).toBeLessThanOrEqual(40);
    expect(state.settled[1]!.text).toContain("… output truncated …");
  });

  it("keeps file events standalone when more than one active Tool shares the step", () => {
    let state = createInitialCliTimelineState(runId);
    for (const [sequence, id] of [
      [1, invocationId],
      [2, "tinv_00000000-0000-7000-8000-000000000001"],
    ] as const) {
      state = reduceTimelineEvent(
        state,
        eventOf("tool.requested", sequence, {
          invocationId: id,
          toolName: "read_file",
          riskLevel: "LOW",
        }),
      );
    }

    state = reduceTimelineEvent(state, eventOf("file.read", 3, { path: "src/index.ts" }));

    expect(state.activeTools).toHaveLength(2);
    expect(state.settled).toHaveLength(1);
    expect(state.settled[0]).toMatchObject({ kind: "FILE", text: "Read file src/index.ts" });
  });

  it("flushes active work on terminal without claiming a process stopped", () => {
    let state = createInitialCliTimelineState(runId);
    state = reduceTimelineEvent(
      state,
      eventOf("tool.requested", 1, {
        invocationId,
        toolName: "exec_command",
        riskLevel: "CRITICAL",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("process.started", 2, {
        process: { id: processId, command: "Run command", status: "RUNNING" },
      }),
    );

    const flushed = flushTimelineForTerminal(state, "FAILED");

    expect(flushed.activeTools).toEqual([]);
    expect(flushed.activeProcesses).toEqual([]);
    expect(flushed.settled.map((entry) => entry.text)).toEqual([
      "Run command · Interrupted by Run termination",
      "Process remains active in daemon.",
    ]);
  });

  it("projects plans and verification checks without retaining provider payloads", () => {
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    let state = createInitialCliTimelineState(runId);
    state = reduceTimelineEvent(
      state,
      eventOf("plan.updated", 1, {
        plan: [{ id: createPlanItemId(), title: "Inspect workspace", status: "IN_PROGRESS" }],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 2, {
        planId,
        sourceStepId: stepId,
        checkCount: 1,
        plannerVersion: "test",
        counts: { required: 1, ifAvailable: 0, advisory: 0 },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.started", 3, {
        planId,
        checkId,
        ordinal: 0,
        kind: "TASK",
        purpose: "ACCEPTANCE",
        stage: "ACCEPTANCE",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 4, {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: [],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.finalized", 5, {
        planId,
        outcome: "PASSED",
        failedCheckIds: [],
        errorCheckIds: [],
      }),
    );

    expect(state.currentPlan?.[0]?.title).toBe("Inspect workspace");
    expect(state.verification).toEqual([]);
    expect(state.settled.at(-1)).toMatchObject({
      kind: "VERIFICATION",
      status: "FINALIZED",
      planId,
    });
  });

  it("keeps approval and retry activity bounded and marks unresolved work on terminal flush", () => {
    const approvalId = createApprovalRequestId();
    let state = createInitialCliTimelineState(runId, { maxSettledEntries: 4 });
    state = reduceTimelineEvent(
      state,
      eventOf("approval.requested", 1, {
        approval: {
          id: approvalId,
          runId,
          toolInvocationId: invocationId,
          riskLevel: "CRITICAL",
          title: "Approval required",
          reason: "Run command",
          action: { toolName: "exec_command" },
          status: "PENDING",
          scope: "ONCE",
          createdAt: 1,
        },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("retry.scheduled", 2, {
        attempt: 1,
        maxAttempts: 2,
        delayMs: 100,
        errorCode: "MODEL_NETWORK_ERROR",
      }),
    );

    const flushed = flushTimelineForTerminal(state, "TIMEOUT");
    expect(flushed.activeApprovals).toEqual([]);
    expect(flushed.retries).toEqual([]);
    expect(flushed.settled.map((entry) => entry.status)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
  });
});

function eventOf(
  type: AgentEvent["type"],
  sequence: number | undefined,
  payload: unknown,
  overrides: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    type,
    runId,
    sessionId,
    stepId,
    timestamp: sequence ?? 1,
    visibility: "USER_VISIBLE",
    durability:
      sequence === undefined ? { kind: "EPHEMERAL" } : { kind: "DURABLE", version: 1, sequence },
    payload,
    ...overrides,
  } as AgentEvent;
}
