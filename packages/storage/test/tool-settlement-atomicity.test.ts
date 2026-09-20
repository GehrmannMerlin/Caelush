import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type AgentRun,
  type AgentSession,
  type AgentStep,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  completeToolInvocation,
  createRequestedToolInvocation,
  createToolObservation,
  startToolInvocation,
  ToolExecutionConflictError,
  type ToolEffect,
} from "@caelush/tools";
import { openCaelushStorage, type ToolSettlementExtensionDecoder } from "../src/index.js";
import { makeState, makeStep } from "./support/fixtures.js";
import {
  codingEffectsExtension,
  toolSettlementExtensionDecoder,
} from "./support/tool-settlement-decoder.js";

/**
 * Phase 4C atomic settlement.
 *
 * ```text
 * terminal invocation
 * + observation
 * + effects extension → AgentState projection
 * + durable events
 * + budget terminal transition
 *         ↓
 *   one SQLite transaction, or nothing
 * ```
 *
 * Every test below asserts the **database's final state** after a failure, not merely that a promise
 * rejected: a rollback that left a partial row behind would still satisfy "it threw".
 */

function makeSession(): AgentSession {
  return {
    id: createSessionId(),
    createdAt: createTimestampMs(100),
    updatedAt: createTimestampMs(100),
    metadata: {},
  };
}

function makeRun(sessionId: AgentSession["id"]): AgentRun {
  return {
    id: createRunId(),
    sessionId,
    goal: "atomic settlement",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test" },
    runtime: { id: "test", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "NEVER_ASK",
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    startedAt: createTimestampMs(101),
  };
}

function completedStep(runId: AgentRun["id"]): AgentStep {
  return makeStep(runId, {
    status: "COMPLETED",
    startedAt: createTimestampMs(100),
    finishedAt: createTimestampMs(101),
  });
}

async function setup(options: { readonly decoder?: ToolSettlementExtensionDecoder } = {}) {
  const storage = await openCaelushStorage({
    path: ":memory:",
    toolSettlementExtension: options.decoder ?? toolSettlementExtensionDecoder(),
  });
  const session = makeSession();
  const run = makeRun(session.id);
  const step = completedStep(run.id);
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  await storage.steps.insert(step);
  await storage.runStates.save(makeState(run));
  return { storage, run, step };
}

function requested(run: AgentRun, step: AgentStep) {
  return createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: run.id,
    stepId: step.id,
    toolName: "read_file",
    externalCallId: `call-${createToolInvocationId()}`,
    args: { path: "src/a.ts" },
    riskLevel: "LOW",
    createdAt: createTimestampMs(110),
  });
}

function requestedEvent(run: AgentRun, step: AgentStep, invocation: { readonly id: string }) {
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
      invocationId: invocation.id as never,
      toolName: "read_file" as never,
      riskLevel: "LOW" as const,
    },
  };
}

async function running(
  storage: Awaited<ReturnType<typeof setup>>["storage"],
  run: AgentRun,
  step: AgentStep,
) {
  const invocation = requested(run, step);
  await storage.toolExecution.commit({
    sessionId: run.sessionId,
    invocation,
    expectedRevision: null,
    events: [requestedEvent(run, step, invocation) as never],
  });
  const started = startToolInvocation(invocation, createTimestampMs(120));
  await storage.toolExecution.commit({
    sessionId: run.sessionId,
    invocation: started,
    expectedRevision: 1,
    events: [],
  });
  return started;
}

const EFFECTS: readonly ToolEffect[] = [
  {
    type: "FILE_CHANGE",
    summary: { path: "src/a.ts", changeType: "MODIFIED", additions: 2, deletions: 1 },
  },
];

describe("Phase 4C atomic Tool settlement", () => {
  it("settles the invocation, the observation, the state projection, the events and the budget together", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      await storage.budget.admit({ runId: run.id, requested: 1, invocationId: invocation.id });
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [requestedEvent(run, step, invocation) as never],
      });
      const started = startToolInvocation(invocation, createTimestampMs(120));
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: started,
        expectedRevision: 1,
        budgetStart: { ownerId: invocation.id, startedAt: createTimestampMs(120) },
        events: [],
      });
      expect(
        await storage.budgetLedger.get(run.id, "TOOL_INVOCATION", invocation.id),
      ).toMatchObject({
        state: "IN_FLIGHT",
      });

      const completed = completeToolInvocation(started, createTimestampMs(130));
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
      const fileEvent = {
        eventId: createEventId(),
        schemaVersion: 1 as const,
        type: "file.modified" as const,
        runId: run.id,
        sessionId: run.sessionId,
        stepId: step.id,
        timestamp: createTimestampMs(130),
        visibility: "USER_VISIBLE" as const,
        durability: { kind: "DURABLE" as const, version: 1 as const },
        payload: { summary: EFFECTS[0]!.type === "FILE_CHANGE" ? EFFECTS[0]!.summary : undefined },
      };
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: completed,
        expectedRevision: 2,
        observation,
        extension: codingEffectsExtension(EFFECTS),
        events: [fileEvent as never],
      });

      // Every part of the settlement is durable, and the budget entry followed it in the same commit.
      expect((await storage.toolExecution.load(invocation.id))?.invocation.status).toBe(
        "COMPLETED",
      );
      expect(await storage.observations.listByRun(run.id)).toHaveLength(1);
      expect((await storage.runStates.get(run.id))?.changedFiles).toEqual([
        { path: "src/a.ts", changeType: "MODIFIED", additions: 2, deletions: 1 },
      ]);
      expect((await storage.events.replay(run.id)).map(({ type }) => type)).toEqual([
        "tool.requested",
        "file.modified",
      ]);
      expect(
        await storage.budgetLedger.get(run.id, "TOOL_INVOCATION", invocation.id),
      ).toMatchObject({
        state: "SETTLED",
      });
    } finally {
      await storage.close();
    }
  });

  it("moves an uncertain execution's budget entry to CONSERVATIVE, not SETTLED", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      await storage.budget.admit({ runId: run.id, requested: 1, invocationId: invocation.id });
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [requestedEvent(run, step, invocation) as never],
      });
      const started = startToolInvocation(invocation, createTimestampMs(120));
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: started,
        expectedRevision: 1,
        budgetStart: { ownerId: invocation.id, startedAt: createTimestampMs(120) },
        events: [],
      });
      const failed = {
        ...started,
        status: "FAILED" as const,
        finishedAt: createTimestampMs(130),
        error: {
          code: "TOOL_EXECUTION_ERROR" as const,
          message: "Tool execution returned an error result.",
          retryable: false,
          phase: "TOOL" as const,
          details: { executionDisposition: "UNCERTAIN_SIDE_EFFECT" },
        },
      };
      const observation = createToolObservation({
        id: createObservationId(),
        runId: run.id,
        stepId: step.id,
        toolInvocationId: invocation.id,
        content: "uncertain",
        details: {},
        isError: true,
        createdAt: createTimestampMs(130),
      });
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: failed,
        expectedRevision: 2,
        observation,
        events: [],
      });

      expect(
        await storage.budgetLedger.get(run.id, "TOOL_INVOCATION", invocation.id),
      ).toMatchObject({
        state: "CONSERVATIVE",
      });
    } finally {
      await storage.close();
    }
  });

  it("releases a reservation whose handler provably never started", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = requested(run, step);
      await storage.budget.admit({ runId: run.id, requested: 1, invocationId: invocation.id });
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation,
        expectedRevision: null,
        events: [requestedEvent(run, step, invocation) as never],
      });
      const failed = {
        ...invocation,
        status: "FAILED" as const,
        finishedAt: createTimestampMs(130),
        error: {
          code: "PERMISSION_DENIED" as const,
          message: "denied",
          retryable: false,
          phase: "SECURITY" as const,
        },
      };
      const observation = createToolObservation({
        id: createObservationId(),
        runId: run.id,
        stepId: step.id,
        toolInvocationId: invocation.id,
        content: "denied",
        details: {},
        isError: true,
        createdAt: createTimestampMs(130),
      });
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: failed,
        expectedRevision: 1,
        observation,
        events: [],
      });

      expect(
        await storage.budgetLedger.get(run.id, "TOOL_INVOCATION", invocation.id),
      ).toMatchObject({
        state: "RELEASED",
      });
    } finally {
      await storage.close();
    }
  });

  it("rolls the whole transaction back when the effects extension is unknown", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = await running(storage, run, step);
      const completed = completeToolInvocation(invocation, createTimestampMs(130));
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

      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation: completed,
          expectedRevision: 2,
          observation,
          extension: { kind: "unknown.extension.v9", payload: {} } as never,
          events: [],
        }),
      ).rejects.toBeTruthy();

      // The database's final state: nothing terminal, no observation, no state change, no budget move.
      const loaded = await storage.toolExecution.load(invocation.id);
      expect(loaded?.invocation.status).toBe("RUNNING");
      expect(loaded?.observation).toBeUndefined();
      expect(await storage.observations.listByRun(run.id)).toHaveLength(0);
      expect((await storage.runStates.get(run.id))?.changedFiles).toEqual([]);
    } finally {
      await storage.close();
    }
  });

  /**
   * A note on the AgentState revision guard.
   *
   * `writeStateSnapshot` reads the row's revision inside the same transaction and asserts it against
   * the value it just read, so that check is a self-consistency guard rather than a cross-writer one:
   * on a single SQLite connection two writers cannot interleave there, and the branch is not reachable
   * from outside. The **Tool invocation** revision — `ToolExecutionCommit.expectedRevision` — is the
   * optimistic-concurrency guard for a Tool settlement, and it is asserted by the last test below.
   * The AgentState projection is covered by the first test in this file: it either commits with the
   * invocation or rolls back with it.
   */
  it("rolls back when a durable event cannot be appended", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = await running(storage, run, step);
      const completed = completeToolInvocation(invocation, createTimestampMs(130));
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
      // The same event id twice: the durable event store refuses the second one, and the whole
      // settlement must go with it.
      const duplicate = {
        eventId: createEventId(),
        schemaVersion: 1 as const,
        type: "file.read" as const,
        runId: run.id,
        sessionId: run.sessionId,
        stepId: step.id,
        timestamp: createTimestampMs(130),
        visibility: "USER_VISIBLE" as const,
        durability: { kind: "DURABLE" as const, version: 1 as const },
        payload: { path: "src/a.ts" },
      };
      const before = (await storage.events.replay(run.id)).length;

      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation: completed,
          expectedRevision: 2,
          observation,
          events: [duplicate as never, { ...duplicate } as never],
        }),
      ).rejects.toBeTruthy();

      expect((await storage.events.replay(run.id)).length).toBe(before);
      const loaded = await storage.toolExecution.load(invocation.id);
      expect(loaded?.invocation.status).toBe("RUNNING");
      expect(loaded?.observation).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("rolls back when the effect projection itself fails", async () => {
    const failing: ToolSettlementExtensionDecoder = {
      decode() {
        throw new Error("the host cannot project these effects");
      },
    };
    const { storage, run, step } = await setup({ decoder: failing });
    try {
      const invocation = await running(storage, run, step);
      const completed = completeToolInvocation(invocation, createTimestampMs(130));
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

      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation: completed,
          expectedRevision: 2,
          observation,
          extension: codingEffectsExtension(EFFECTS),
          events: [],
        }),
      ).rejects.toBeTruthy();

      const loaded = await storage.toolExecution.load(invocation.id);
      expect(loaded?.invocation.status).toBe("RUNNING");
      expect(loaded?.observation).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("refuses a settlement extension when the host has no decoder at all", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id);
    const step = completedStep(run.id);
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.steps.insert(step);
    await storage.runStates.save(makeState(run));
    try {
      const invocation = await running(storage, run, step);
      const completed = completeToolInvocation(invocation, createTimestampMs(130));
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

      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation: completed,
          expectedRevision: 2,
          observation,
          extension: codingEffectsExtension(EFFECTS),
          events: [],
        }),
      ).rejects.toBeTruthy();
      expect((await storage.toolExecution.load(invocation.id))?.invocation.status).toBe("RUNNING");
    } finally {
      await storage.close();
    }
  });

  it("keeps the revision guard, so a second writer cannot overwrite a settlement", async () => {
    const { storage, run, step } = await setup();
    try {
      const invocation = await running(storage, run, step);
      const completed = completeToolInvocation(invocation, createTimestampMs(130));
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
      await storage.toolExecution.commit({
        sessionId: run.sessionId,
        invocation: completed,
        expectedRevision: 2,
        observation,
        events: [],
      });

      await expect(
        storage.toolExecution.commit({
          sessionId: run.sessionId,
          invocation: completed,
          expectedRevision: 2,
          observation,
          events: [],
        }),
      ).rejects.toBeInstanceOf(ToolExecutionConflictError);
    } finally {
      await storage.close();
    }
  });
});
