import {
  PublicRunEventSchema,
  createEventId,
  createApprovalRequestId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  createInitialLiveActivityState,
  pruneProjectedLiveActivities,
  reduceLiveActivityEvent,
} from "../src/live-activity.js";
import { describe, expect, it } from "vitest";

const runId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();
const invocationId = createToolInvocationId();

function transient(
  type: string,
  payload: Record<string, unknown>,
  streamKey: string,
  streamSequence: number,
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: type.includes("output") ? 2 : 1,
    runId,
    sessionId,
    stepId,
    timestamp: 1_700_000_000_000 + streamSequence,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "ORDERED",
      streamKey,
      streamSequence,
    },
    type,
    payload,
  });
}

describe("LiveActivity projection", () => {
  it("reconciles durable Tool lifecycle events into one invocation-scoped activity", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent(
        "tool.requested",
        { invocationId, toolName: "apply_patch", riskLevel: "HIGH" },
        1,
        100,
      ),
    );
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      id: `tool-activity:${invocationId}`,
      kind: "TOOL_ACTIVITY",
      toolInvocationId: invocationId,
      toolName: "apply_patch",
      category: "EDIT",
      toolPhase: "REQUESTED",
      status: "ACTIVE",
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent("tool.started", { invocationId, toolName: "apply_patch" }, 2, 101),
    );
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({ toolPhase: "RUNNING", status: "ACTIVE" });

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "tool.completed",
        { invocationId, observationId: "obs_0195f3a0-0000-7000-8000-000000000000" },
        3,
        102,
      ),
    );
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      toolPhase: "COMPLETED",
      status: "COMPLETED",
      settledAtSequence: 3,
    });
    expect(pruneProjectedLiveActivities(state, 3).activities).toEqual([]);
  });

  it("attaches safe file events only to the matching live Tool invocation", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent(
        "tool.requested",
        { invocationId, toolName: "apply_patch", riskLevel: "HIGH" },
        1,
      ),
    );
    state = reduceLiveActivityEvent(
      state,
      durableEvent("tool.started", { invocationId, toolName: "apply_patch" }, 2),
    );
    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "file.created",
        {
          summary: {
            path: "login.html",
            changeType: "CREATED",
            additions: 214,
            deletions: 0,
          },
        },
        3,
      ),
    );
    expect(state.activities[0]?.effects).toBeUndefined();

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "file.created",
        {
          invocationId,
          summary: {
            path: "login.html",
            changeType: "CREATED",
            additions: 214,
            deletions: 0,
          },
        },
        4,
      ),
    );
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      toolPhase: "RUNNING",
      effects: [
        {
          type: "FILE_CHANGE",
          path: "login.html",
          changeType: "CREATED",
          additions: 214,
          deletions: 0,
        },
      ],
    });
  });

  it("shows approval waiting and preserves uncertain Tool failure guidance", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent(
        "tool.requested",
        { invocationId, toolName: "apply_patch", riskLevel: "HIGH" },
        1,
      ),
    );
    const approvalId = createApprovalRequestId();
    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "approval.requested",
        {
          approval: {
            id: approvalId,
            runId,
            toolInvocationId: invocationId,
            riskLevel: "HIGH",
            title: "Approve patch",
            reason: "Patch changes workspace files",
            action: {},
            status: "PENDING",
            scope: "ONCE",
            createdAt: 101,
          },
        },
        2,
      ),
    );
    expect(state.activities[0]).toMatchObject({
      toolPhase: "WAITING_APPROVAL",
      status: "ACTIVE",
      approvalId,
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "approval.resolved",
        { approvalId, status: "APPROVED", grantedScope: "ONCE" },
        3,
      ),
    );
    expect(state.activities[0]).toMatchObject({ toolPhase: "REQUESTED", status: "ACTIVE" });
    expect(state.activities[0]).not.toHaveProperty("approvalId");

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "tool.failed",
        {
          invocationId,
          error: {
            code: "TOOL_OUTCOME_UNKNOWN",
            message: "safe error",
            retryable: false,
          },
        },
        4,
      ),
    );
    expect(state.activities[0]).toMatchObject({
      toolPhase: "FAILED",
      status: "FAILED",
      text: "工具结果未知，请勿自动重试",
      settledAtSequence: 4,
    });
  });

  it("settles an active Tool activity as cancelled when its Run is cancelled", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent("tool.requested", { invocationId, toolName: "read_file", riskLevel: "LOW" }, 1),
    );
    state = reduceLiveActivityEvent(
      state,
      durableEvent("tool.started", { invocationId, toolName: "read_file" }, 2),
    );
    state = reduceLiveActivityEvent(state, durableEvent("run.cancelled", { reason: "user" }, 3));

    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      toolPhase: "CANCELLED",
      status: "CANCELLED",
      settledAtSequence: 3,
    });
    expect(state.terminal).toBe(true);
  });

  it("tracks Provider wait status and activity time without inferring connection health", () => {
    const stepStarted = durableEvent(
      "llm.started",
      { model: { provider: "fixture", model: "fixture-model" } },
      1,
      1_700_000_000_000,
    );
    let state = reduceLiveActivityEvent(createInitialLiveActivityState(runId), stepStarted);
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "NO_RECENT_ACTIVITY", 30_000, 300_000),
    );
    expect(state.modelWait).toMatchObject({
      stepId,
      phase: "NO_RECENT_ACTIVITY",
      lastActivityAt: 1_699_999_900_000,
      providerEventReceived: false,
    });
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "RECEIVING_PROVIDER_DATA", 0, 300_000),
    );

    const delta = transient("model.text.delta", { text: "thinking" }, "model:text", 1);
    state = reduceLiveActivityEvent(state, delta);

    expect(state.modelWait).toMatchObject({
      runId,
      stepId,
      phase: "RECEIVING_PROVIDER_DATA",
      lastActivityAt: delta.timestamp,
      idleForMs: 0,
      idleTimeoutMs: 300_000,
      providerEventReceived: true,
    });
    expect(state.modelWait).not.toHaveProperty("connectionHealth");

    const otherStep = createStepId();
    const afterWrongStep = reduceLiveActivityEvent(
      state,
      modelStatus(otherStep, "NO_RECENT_ACTIVITY", 30_000, 300_000),
    );
    expect(afterWrongStep.modelWait).toEqual(state.modelWait);
  });

  it("projects bounded retry, fallback and exhaustion progress using retry ordinals", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent(
        "retry.scheduled",
        {
          attempt: 2,
          maxAttempts: 6,
          delayMs: 2_000,
          nextAttemptAt: 1_700_000_002_000,
          errorCode: "LLM_NETWORK",
        },
        1,
      ),
    );
    expect(state.modelWait).toMatchObject({
      phase: "RETRY_SCHEDULED",
      retryOrdinal: 1,
      maxRetries: 5,
      attempt: 2,
      maxAttempts: 6,
      delayMs: 2_000,
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent("retry.started", { attempt: 2, maxAttempts: 6 }, 2),
    );
    state = reduceLiveActivityEvent(
      state,
      durableEvent("llm.started", { model: { provider: "fixture", model: "fixture-model" } }, 3),
    );
    expect(state.modelWait).toMatchObject({ phase: "RETRYING", retryOrdinal: 1, maxRetries: 5 });
    state = reduceLiveActivityEvent(state, modelStatus(stepId, "NO_RECENT_ACTIVITY", 1_000, 5_000));
    expect(state.modelWait).toMatchObject({
      phase: "NO_RECENT_ACTIVITY",
      retryOrdinal: 1,
      maxRetries: 5,
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "transport.fallback.selected",
        {
          attempt: 2,
          maxAttempts: 6,
          fromTransportId: "default",
          toTransportId: "secondary",
        },
        4,
      ),
    );
    expect(state.modelWait).toMatchObject({
      phase: "FALLBACK_SELECTED",
      fromTransportId: "default",
      toTransportId: "secondary",
    });

    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "retry.exhausted",
        {
          attempt: 6,
          maxAttempts: 6,
          retriesUsed: 5,
          maxRetries: 5,
          errorCode: "LLM_TIMEOUT",
          reason: "ATTEMPTS_EXHAUSTED",
        },
        5,
      ),
    );
    expect(state.modelWait).toMatchObject({
      phase: "RETRY_EXHAUSTED",
      retryOrdinal: 5,
      maxRetries: 5,
      errorCode: "LLM_TIMEOUT",
    });
  });

  it("does not resurrect a settled model wait when late status arrives or the Run ends", () => {
    let state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      durableEvent("llm.started", { model: { provider: "fixture", model: "fixture-model" } }, 1),
    );
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "NO_RECENT_ACTIVITY", 30_000, 300_000),
    );
    expect(state.modelWait).toMatchObject({ phase: "NO_RECENT_ACTIVITY", stepId });
    state = reduceLiveActivityEvent(
      state,
      durableEvent(
        "llm.completed",
        {
          model: { provider: "fixture", model: "fixture-model" },
          usage: { steps: 1, toolCalls: 0, inputTokens: 10, outputTokens: 2 },
        },
        2,
      ),
    );
    expect(state.modelWait).toBeUndefined();
    state = reduceLiveActivityEvent(
      state,
      modelStatus(stepId, "NO_RECENT_ACTIVITY", 60_000, 300_000),
    );
    expect(state.modelWait).toBeUndefined();

    state = reduceLiveActivityEvent(
      state,
      durableEvent("run.completed", { result: { status: "COMPLETED" } }, 3),
    );
    expect(state.terminal).toBe(true);
    expect(state.modelWait).toBeUndefined();
  });

  it("accumulates ordered live deltas, ignores duplicates/late events, and settles durably", () => {
    const textA = transient("model.text.delta", { text: "Hel" }, "model:text", 1);
    const textB = transient("model.text.delta", { text: "lo" }, "model:text", 2);
    let state = createInitialLiveActivityState(runId);
    state = reduceLiveActivityEvent(state, textA);
    state = reduceLiveActivityEvent(state, textB);
    const beforeDuplicate = state;
    state = reduceLiveActivityEvent(state, textA);

    expect(state).toBe(beforeDuplicate);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      kind: "MODEL_TEXT",
      text: "Hello",
      status: "ACTIVE",
    });

    const toolOutput = transient(
      "tool.output",
      { invocationId, stream: "stdout", chunk: "working" },
      `tool:${invocationId}`,
      1,
    );
    state = reduceLiveActivityEvent(state, toolOutput);
    expect(state.activities.some((item) => item.kind === "TOOL_OUTPUT")).toBe(true);

    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        stepId,
        timestamp: 1_700_000_000_010,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "tool.completed",
        payload: { invocationId, observationId: "obs_0195f3a0-0000-7000-8000-000000000000" },
      }),
    );
    expect(state.activities.find((item) => item.kind === "TOOL_OUTPUT")?.status).toBe("COMPLETED");

    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        timestamp: 1_700_000_000_011,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 2 },
        type: "run.completed",
        payload: { result: { status: "COMPLETED" } },
      }),
    );
    expect(state.terminal).toBe(true);
    expect(state.activities.every((item) => item.status === "COMPLETED")).toBe(true);
  });

  it("bounds the first streamed text chunk and records its UTF-8 accounting", () => {
    const maxTextBytes = 16 * 1024;
    const text = "a".repeat(maxTextBytes + 10);
    const state = reduceLiveActivityEvent(
      createInitialLiveActivityState(runId),
      transient("model.tool_call.delta", { toolCallId: "call-s0", delta: text }, "tool-call:s0", 1),
    );

    expect(state.activities[0]).toMatchObject({
      kind: "MODEL_TOOL_CALL",
      text: "a".repeat(maxTextBytes),
      retainedBytes: maxTextBytes,
      truncated: true,
      omittedBytes: 10,
    });
  });

  it("uses bounded text accounting for every streaming activity kind", () => {
    const maxTextBytes = 16 * 1024;
    const chunk = "x".repeat(maxTextBytes + 5);
    const cases = [
      {
        type: "model.text.delta",
        payload: { text: chunk },
        streamKey: "model:text:s0",
        kind: "MODEL_TEXT",
      },
      {
        type: "model.reasoning_summary.delta",
        payload: { text: chunk },
        streamKey: "model:reasoning:s0",
        kind: "MODEL_REASONING",
      },
      {
        type: "model.tool_call.delta",
        payload: { toolCallId: "call-s0", delta: chunk },
        streamKey: "model:tool-call:s0",
        kind: "MODEL_TOOL_CALL",
      },
      {
        type: "tool.output",
        payload: { invocationId, stream: "stdout", chunk },
        streamKey: `tool:${invocationId}`,
        kind: "TOOL_OUTPUT",
      },
      {
        type: "shell.output",
        payload: { invocationId, stream: "stdout", chunk },
        streamKey: `shell:${invocationId}`,
        kind: "SHELL_OUTPUT",
      },
      {
        type: "process.output",
        payload: { processId: "process-s0", stream: "stdout", chunk },
        streamKey: "process:process-s0",
        kind: "PROCESS_OUTPUT",
      },
    ];

    for (const [index, item] of cases.entries()) {
      const state = reduceLiveActivityEvent(
        createInitialLiveActivityState(runId),
        transient(item.type, item.payload, item.streamKey, index + 1),
      );

      expect(state.activities[0]).toMatchObject({
        kind: item.kind,
        text: "x".repeat(maxTextBytes),
        retainedBytes: maxTextBytes,
        truncated: true,
        omittedBytes: 5,
      });
    }
  });

  it("preserves failed and cancelled terminal outcomes for live rows", () => {
    const toolOutput = transient(
      "tool.output",
      { invocationId, stream: "stderr", chunk: "failed safely" },
      `tool:${invocationId}`,
      1,
    );
    let state = reduceLiveActivityEvent(createInitialLiveActivityState(runId), toolOutput);

    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        stepId,
        timestamp: 1_700_000_000_010,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 1 },
        type: "tool.failed",
        payload: {
          invocationId,
          error: {
            code: "TOOL_EXECUTION_ERROR",
            message: "Tool execution failed.",
            retryable: false,
          },
        },
      }),
    );
    expect(state.activities[0]?.status).toBe("FAILED");

    const reasoning = transient(
      "model.reasoning_summary.delta",
      { text: "still working" },
      "model:reasoning",
      1,
    );
    state = reduceLiveActivityEvent(state, reasoning);
    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        timestamp: 1_700_000_000_011,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 2 },
        type: "run.cancelled",
        payload: { reason: "USER_REQUEST" },
      }),
    );

    expect(state.terminal).toBe(true);
    expect(state.activities.find((item) => item.kind === "MODEL_REASONING")?.status).toBe(
      "CANCELLED",
    );
    expect(state.activities.find((item) => item.kind === "TOOL_OUTPUT")?.status).toBe("FAILED");
  });

  it("prunes only terminal live rows covered by the durable presentation watermark", () => {
    const toolOutput = transient(
      "tool.output",
      { invocationId, stream: "stdout", chunk: "done" },
      `tool:${invocationId}`,
      1,
    );
    const reasoning = transient(
      "model.reasoning_summary.delta",
      { text: "still active" },
      "model:reasoning",
      1,
    );
    let state = reduceLiveActivityEvent(createInitialLiveActivityState(runId), toolOutput);
    state = reduceLiveActivityEvent(state, reasoning);
    state = reduceLiveActivityEvent(
      state,
      PublicRunEventSchema.parse({
        eventId: createEventId(),
        schemaVersion: 1,
        runId,
        sessionId,
        stepId,
        timestamp: 1_700_000_000_010,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence: 4 },
        type: "tool.completed",
        payload: { invocationId, observationId: "obs_0195f3a0-0000-7000-8000-000000000000" },
      }),
    );

    expect(pruneProjectedLiveActivities(state, 3).activities).toHaveLength(2);
    expect(pruneProjectedLiveActivities(state, 4).activities).toEqual([
      expect.objectContaining({ kind: "MODEL_REASONING", status: "ACTIVE" }),
    ]);
  });
});

function durableEvent(
  type: string,
  payload: Record<string, unknown>,
  sequence: number,
  timestamp = 100,
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    ...(type.startsWith("llm.") ||
    type.startsWith("model.") ||
    type.startsWith("retry.") ||
    type.startsWith("transport.")
      ? { stepId }
      : {}),
    timestamp,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    type,
    payload,
  });
}

function modelStatus(
  targetStepId: ReturnType<typeof createStepId>,
  phase:
    | "WAITING_PROVIDER"
    | "RECEIVING_PROVIDER_DATA"
    | "NO_RECENT_ACTIVITY"
    | "CANCELLING_IDLE_STREAM",
  idleForMs: number,
  idleTimeoutMs: number,
) {
  return PublicRunEventSchema.parse({
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    stepId: targetStepId,
    timestamp: 1_699_999_900_000 + idleForMs,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "COALESCIBLE",
      streamKey: `model:status:${runId}:${targetStepId}`,
    },
    type: "model.status",
    payload: {
      phase,
      lastActivityAt: 1_699_999_900_000,
      idleForMs,
      idleTimeoutMs,
    },
  });
}
