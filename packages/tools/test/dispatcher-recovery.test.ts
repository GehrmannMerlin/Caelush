import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
  createTimestampMs,
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ToolDispatcher,
  ToolDispatcherInvariantError,
  ToolRegistryBuilder,
  createRequestedToolInvocation,
  isUncertainToolExecution,
  markToolInvocationWaitingApproval,
  startToolInvocation,
  type ToolCommittedEventNotifier,
  type ToolDispatchRequest,
  type ToolExecutionCommit,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "../src/index.js";
import { ToolExecutionConflictError } from "../src/index.js";

class RecoveryStore implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();
  async load(id: string) {
    return this.snapshots.get(id) ?? null;
  }
  async findByExternalCall(runId: string, stepId: string, externalCallId: string) {
    return (
      [...this.snapshots.values()].find(
        ({ invocation }) =>
          invocation.runId === runId &&
          invocation.stepId === stepId &&
          invocation.externalCallId === externalCallId,
      ) ?? null
    );
  }
  async commit(command: ToolExecutionCommit) {
    const current = this.snapshots.get(command.invocation.id);
    if ((current?.revision ?? null) !== command.expectedRevision)
      throw new ToolExecutionConflictError("conflict");
    const snapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (current?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    return {
      snapshot,
      events: command.events.map((event) => ({
        ...event,
        durability: { ...event.durability, sequence: 1 },
      })) as never[],
    };
  }
}

const request: ToolDispatchRequest = {
  sessionId: createSessionId(),
  runId: createRunId(),
  stepId: createStepId(),
  externalCallId: "call-1",
  toolName: "echo_value",
  args: { value: "hello" },
};

function makeDispatcher(
  store: RecoveryStore,
  execute: (value: ToolExecutionRequest) => Promise<ToolExecutionResult>,
) {
  const builder = new ToolRegistryBuilder();
  builder.register({
    definition: {
      name: "echo_value",
      description: "Echo.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { echoed: { type: "string" } },
        required: ["echoed"],
        additionalProperties: false,
      },
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: {},
    },
    handler: { execute },
  });
  return new ToolDispatcher({
    registry: builder.build(),
    store,
    gate: { decide: async () => ({ kind: "ALLOW" as const }) },
    notifier: { notifyCommitted() {} } satisfies ToolCommittedEventNotifier,
    clock: {
      now: (() => {
        let value = 120;
        return () => createTimestampMs(++value);
      })(),
    },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
}

function requestedInvocation(status: ToolInvocation["status"] = "REQUESTED") {
  const invocation = createRequestedToolInvocation({
    id: createToolInvocationId(),
    runId: request.runId,
    stepId: request.stepId,
    externalCallId: request.externalCallId,
    toolName: request.toolName,
    args: request.args,
    riskLevel: "LOW",
    createdAt: createTimestampMs(100),
  });
  return status === "RUNNING"
    ? startToolInvocation(invocation, createTimestampMs(110))
    : invocation;
}

describe("ToolDispatcher recovery", () => {
  it("safely resumes a durable REQUESTED invocation", async () => {
    const store = new RecoveryStore();
    const invocation = requestedInvocation();
    store.snapshots.set(invocation.id, { sessionId: request.sessionId, invocation, revision: 1 });
    let count = 0;
    const dispatcher = makeDispatcher(store, async () => {
      count += 1;
      return { content: "hello", details: { echoed: "hello" }, isError: false };
    });

    const outcome = await dispatcher.recover(invocation.id);

    expect(outcome.kind).toBe("RESULT");
    expect(count).toBe(1);
  });

  it("fails a durable RUNNING invocation closed without retrying the handler", async () => {
    const store = new RecoveryStore();
    const invocation = requestedInvocation("RUNNING");
    store.snapshots.set(invocation.id, { sessionId: request.sessionId, invocation, revision: 2 });
    let count = 0;
    const dispatcher = makeDispatcher(store, async () => {
      count += 1;
      return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
    });

    const outcome = await dispatcher.recover(invocation.id);

    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind !== "RESULT") throw new Error("expected result");
    expect(count).toBe(0);
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.observation.content).toContain("may have partially or fully executed");
    expect(outcome.invocation.error?.details).toEqual({
      executionDisposition: "UNCERTAIN_SIDE_EFFECT",
    });
    expect(isUncertainToolExecution(outcome.invocation)).toBe(true);
  });

  it("uses recoverOrDispatch as an explicit restart path", async () => {
    const store = new RecoveryStore();
    let count = 0;
    const dispatcher = makeDispatcher(store, async () => {
      count += 1;
      return { content: "hello", details: { echoed: "hello" }, isError: false };
    });

    const first = await dispatcher.recoverOrDispatch(request);
    const recovered = await dispatcher.recoverOrDispatch(request);

    expect(recovered).toEqual(first);
    expect(count).toBe(1);
  });

  it("keeps a durable WAITING_APPROVAL invocation paused without invoking the handler", async () => {
    const store = new RecoveryStore();
    const invocation = markToolInvocationWaitingApproval(requestedInvocation());
    store.snapshots.set(invocation.id, { sessionId: request.sessionId, invocation, revision: 2 });
    let count = 0;
    const dispatcher = makeDispatcher(store, async () => {
      count += 1;
      return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
    });

    const outcome = await dispatcher.recover(invocation.id);

    expect(outcome).toEqual({ kind: "WAITING_APPROVAL", invocation });
    expect(count).toBe(0);
  });

  it("fails closed when a durable invocation's Tool disappears from the registry", async () => {
    const store = new RecoveryStore();
    const invocation = requestedInvocation();
    store.snapshots.set(invocation.id, { sessionId: request.sessionId, invocation, revision: 1 });
    const dispatcher = new ToolDispatcher({
      registry: new ToolRegistryBuilder().build(),
      store,
      gate: { decide: async () => ({ kind: "ALLOW" as const }) },
      notifier: { notifyCommitted() {} },
      clock: { now: () => createTimestampMs(100) },
      invocationIdFactory: { create: createToolInvocationId },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
    });

    await expect(dispatcher.recover(invocation.id)).rejects.toBeInstanceOf(
      ToolDispatcherInvariantError,
    );
  });
});
