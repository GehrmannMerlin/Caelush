import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type AgentRun,
  type AgentSession,
  type AgentStep,
  type ToolObservation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createRequestedToolInvocation,
  completeToolInvocation,
  startToolInvocation,
  createToolObservation,
  ToolExecutionConflictError,
  ToolExecutionInvariantError,
} from "@caelush/tools";
import { openCaelushStorage } from "../src/index.js";
import { makeState } from "./support/fixtures.js";

function makeSession(): AgentSession {
  return {
    id: createSessionId(),
    createdAt: createTimestampMs(100),
    updatedAt: createTimestampMs(100),
    metadata: {},
  };
}

function makeRun(sessionId: AgentSession["id"], status: AgentRun["status"] = "RUNNING"): AgentRun {
  return {
    id: createRunId(),
    sessionId,
    goal: "tool test",
    status,
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test" },
    runtime: { id: "test", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    startedAt: status === "RUNNING" ? createTimestampMs(101) : undefined,
  };
}

function makeStep(runId: AgentRun["id"], status: AgentStep["status"] = "COMPLETED"): AgentStep {
  return {
    id: createStepId(),
    runId,
    sequence: 1,
    status,
    startedAt: createTimestampMs(100),
    finishedAt: status === "COMPLETED" ? createTimestampMs(101) : undefined,
  };
}

function requested(run: AgentRun, step: AgentStep) {
  return createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: run.id,
    stepId: step.id,
    externalCallId: "call-1",
    toolName: "echo_value",
    args: { value: "hello" },
    riskLevel: "LOW",
    createdAt: createTimestampMs(110),
  });
}

function requestedEvent(run: AgentRun, step: AgentStep, invocation: ReturnType<typeof requested>) {
  return {
    eventId: createEventId(),
    schemaVersion: 1 as const,
    type: "tool.requested" as const,
    runId: run.id,
    sessionId: run.sessionId,
    stepId: step.id,
    timestamp: createTimestampMs(110),
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 as const },
    payload: {
      invocationId: invocation.id,
      toolName: invocation.toolName,
      externalCallId: invocation.externalCallId,
      riskLevel: invocation.riskLevel,
    },
  };
}

async function setup(
  status: AgentRun["status"] = "RUNNING",
  stepStatus: AgentStep["status"] = "COMPLETED",
) {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const session = makeSession();
  const run = makeRun(session.id, status);
  const step = makeStep(run.id, stepStatus);
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  await storage.steps.insert(step);
  await storage.runStates.save(makeState(run));
  return { storage, run, step };
}

describe("SqliteToolExecutionStore", () => {
  it("persists a requested invocation with revision one", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      const result = await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [requestedEvent(run, step, invocation)],
      });

      expect(result.snapshot.revision).toBe(1);
      expect((await storage.toolExecution.load(invocation.id))?.invocation.status).toBe(
        "REQUESTED",
      );
    } finally {
      await storage.close();
    }
  });

  it("rejects a first commit unless Run is running and source Step is completed", async () => {
    const { storage, run, step } = await setup("COMPLETED");
    try {
      const invocation = requested(run, step);
      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation,
          expectedRevision: null,
          events: [requestedEvent(run, step, invocation)],
        }),
      ).rejects.toBeInstanceOf(ToolExecutionInvariantError);
    } finally {
      await storage.close();
    }
  });

  it.each([
    ["wrong sessionId", "wrong-session"],
    ["missing source Step", "missing-step"],
    ["source Step belongs to another Run", "wrong-run-step"],
    ["source Step is still RUNNING", "running-step"],
    ["source Step is FAILED", "failed-step"],
  ])("rejects tool execution for %s", async (_label, violation) => {
    const { storage, run, step } = await setup(
      "RUNNING",
      violation === "running-step"
        ? "RUNNING"
        : violation === "failed-step"
          ? "FAILED"
          : "COMPLETED",
    );
    try {
      let sessionId = run.sessionId;
      let sourceStep = step;
      if (violation === "wrong-session") sessionId = createSessionId();
      if (violation === "missing-step") sourceStep = makeStep(run.id);
      if (violation === "wrong-run-step") {
        const otherSession = makeSession();
        const otherRun = makeRun(otherSession.id);
        sourceStep = makeStep(otherRun.id);
        await storage.sessions.insert(otherSession);
        await storage.runs.insert(otherRun);
        await storage.steps.insert(sourceStep);
      }
      const invocation = requested(run, sourceStep);

      await expect(
        storage.toolExecution.commit({
          sessionId,
          invocation,
          expectedRevision: null,
          events: [requestedEvent(run, sourceStep, invocation)],
        }),
      ).rejects.toBeInstanceOf(ToolExecutionInvariantError);
      expect(await storage.toolInvocations.listByRun(run.id)).toHaveLength(0);
    } finally {
      await storage.close();
    }
  });

  it("rejects a stale revision without overwriting the current invocation", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [requestedEvent(run, step, invocation)],
      });
      const running = startToolInvocation(invocation, createTimestampMs(120));
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: running,
        expectedRevision: 1,
        events: [],
      });

      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation,
          expectedRevision: 1,
          events: [],
        }),
      ).rejects.toBeInstanceOf(ToolExecutionConflictError);
      expect((await storage.toolExecution.load(invocation.id))?.invocation.status).toBe("RUNNING");
    } finally {
      await storage.close();
    }
  });

  it("rolls back invocation and observation when a later event conflicts", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      const initialEvent = requestedEvent(run, step, invocation);
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [initialEvent],
      });
      const running = startToolInvocation(invocation, createTimestampMs(120));
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: running,
        expectedRevision: 1,
        events: [],
      });
      const completed = completeToolInvocation(running, createTimestampMs(130));
      const observation: ToolObservation = createToolObservation({
        id: createObservationId(),
        runId: run.id,
        stepId: step.id,
        toolInvocationId: invocation.id,
        content: "hello",
        details: { echoed: "hello" },
        isError: false,
        createdAt: createTimestampMs(130),
      });
      const duplicateEvent = {
        ...initialEvent,
        payload: { ...initialEvent.payload },
      };
      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation: completed,
          expectedRevision: 2,
          observation,
          effects: [
            { type: "FILE_CHANGE", summary: { path: "rollback.ts", changeType: "CREATED" } },
          ],
          effectTimestamp: createTimestampMs(130),
          events: [duplicateEvent, duplicateEvent],
        }),
      ).rejects.toBeInstanceOf(ToolExecutionConflictError);

      const loaded = await storage.toolExecution.load(invocation.id);
      expect(loaded?.invocation.status).toBe("RUNNING");
      expect(loaded?.observation).toBeUndefined();
      expect((await storage.runStates.get(run.id))?.changedFiles).toEqual([]);
      expect(await storage.events.replay(run.id)).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("settles effects, AgentState and domain events atomically before notification", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [requestedEvent(run, step, invocation)],
      });
      const running = startToolInvocation(invocation, createTimestampMs(120));
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: running,
        expectedRevision: 1,
        events: [],
      });
      const completed = completeToolInvocation(running, createTimestampMs(130));
      const observation = createToolObservation({
        id: createObservationId(),
        runId: run.id,
        stepId: step.id,
        toolInvocationId: invocation.id,
        content: "changed",
        details: {},
        isError: false,
        createdAt: createTimestampMs(130),
      });
      const event = {
        eventId: createEventId(),
        schemaVersion: 1 as const,
        type: "file.modified" as const,
        runId: run.id,
        sessionId: run.sessionId,
        stepId: step.id,
        timestamp: createTimestampMs(130),
        visibility: "USER_VISIBLE" as const,
        durability: { kind: "DURABLE" as const, version: 1 as const },
        payload: { summary: { path: "src/a.ts", changeType: "MODIFIED" as const, additions: 1 } },
      };
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: completed,
        expectedRevision: 2,
        observation,
        effects: [{ type: "FILE_CHANGE", summary: event.payload.summary }],
        effectTimestamp: createTimestampMs(130),
        events: [event],
      });
      expect((await storage.runStates.get(run.id))?.changedFiles).toEqual([
        { path: "src/a.ts", changeType: "MODIFIED", additions: 1 },
      ]);
      expect((await storage.events.replay(run.id)).map((item) => item.type)).toEqual([
        "tool.requested",
        "file.modified",
      ]);
      expect((await storage.toolExecution.load(invocation.id))?.invocation.status).toBe(
        "COMPLETED",
      );
    } finally {
      await storage.close();
    }
  });
});
