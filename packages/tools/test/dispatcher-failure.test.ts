import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;
import { describe, expect, it } from "vitest";
import {
  ToolDispatcher,
  ToolDispatcherInfrastructureError,
  ToolExecutionUncertainError,
  ToolRegistryBuilder,
  type DurableToolAgentEvent,
  type ToolCommittedEventNotifier,
  type ToolDispatchRequest,
  type ToolExecutionCommit,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "../src/index.js";

class FailingTerminalStore implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();
  failTerminalCommit = true;
  failRunningCommit = false;

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
    if (this.failRunningCommit && command.invocation.status === "RUNNING") {
      throw new Error("simulated pre-execution persistence outage");
    }
    if (this.failTerminalCommit && ["COMPLETED", "FAILED"].includes(command.invocation.status)) {
      throw new Error("simulated terminal persistence outage");
    }
    const current = this.snapshots.get(command.invocation.id);
    if ((current?.revision ?? null) !== command.expectedRevision) {
      throw new Error("unexpected revision in test store");
    }
    const snapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (current?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    const events = command.events.map((event, index) => ({
      ...event,
      durability: { ...event.durability, sequence: index + 1 },
    })) as DurableToolAgentEvent[];
    return { snapshot, events };
  }
}

const request: ToolDispatchRequest = {
  sessionId: createSessionId(),
  runId: createRunId(),
  stepId: createStepId(),
  externalCallId: "call-failure-1",
  toolName: "echo_value",
  args: { value: "hello" },
  environment,
};

function makeDispatcher(
  store: FailingTerminalStore,
  execute: (value: ToolExecutionRequest) => Promise<ToolExecutionResult>,
) {
  const definition = {
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
    riskLevel: "LOW" as const,
    requiredCapabilities: [],
    runtimeRequirements: {},
  };
  const registry = new ToolRegistryBuilder().register({ definition, handler: { execute } }).build();
  const notifier: ToolCommittedEventNotifier = { notifyCommitted() {} };
  let timestamp = 100;
  return new ToolDispatcher({
    registry,
    store,
    gate: { decide: async () => ({ kind: "ALLOW" as const }) },
    notifier,
    clock: { now: () => createTimestampMs(++timestamp) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
}

describe("ToolDispatcher persistence failures", () => {
  it("persists an uncertain side-effect marker before propagating runtime uncertainty", async () => {
    const store = new FailingTerminalStore();
    store.failTerminalCommit = false;
    const dispatcher = makeDispatcher(store, async () => {
      throw new ToolExecutionUncertainError();
    });

    const outcome = await dispatcher.dispatch(request);
    expect(outcome.kind).toBe("RESULT");
    const snapshot = [...store.snapshots.values()][0];
    expect(snapshot?.invocation.status).toBe("FAILED");
    expect(snapshot?.invocation.error?.details?.executionDisposition).toBe("UNCERTAIN_SIDE_EFFECT");
    expect(snapshot?.observation?.isError).toBe(true);
    if (outcome.kind !== "RESULT") throw new Error("expected uncertain result");
    expect(outcome.observation.content).toContain("Do not automatically repeat");
  });

  it("does not invoke the handler when the RUNNING checkpoint cannot commit", async () => {
    const store = new FailingTerminalStore();
    store.failTerminalCommit = false;
    store.failRunningCommit = true;
    let executions = 0;
    const dispatcher = makeDispatcher(store, async () => {
      executions += 1;
      return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
    });

    await expect(dispatcher.dispatch(request)).rejects.toBeInstanceOf(
      ToolDispatcherInfrastructureError,
    );
    expect(executions).toBe(0);
    expect(store.snapshots.size).toBe(1);
    expect([...store.snapshots.values()][0]?.invocation.status).toBe("REQUESTED");
  });

  it("preserves RUNNING recovery state when terminal persistence fails", async () => {
    const store = new FailingTerminalStore();
    let executions = 0;
    const dispatcher = makeDispatcher(store, async () => {
      executions += 1;
      return { content: "hello", details: { echoed: "hello" }, isError: false };
    });

    await expect(dispatcher.dispatch(request)).rejects.toBeInstanceOf(
      ToolDispatcherInfrastructureError,
    );
    const running = [...store.snapshots.values()][0];
    expect(running?.invocation.status).toBe("RUNNING");
    expect(executions).toBe(1);

    store.failTerminalCommit = false;
    const recovered = await dispatcher.recover(running!.invocation.id, environment);

    expect(recovered.kind).toBe("RESULT");
    if (recovered.kind !== "RESULT") throw new Error("expected a recovered result");
    expect(recovered.invocation.status).toBe("FAILED");
    expect(recovered.observation.content).toContain("may have partially or fully executed");
    expect(executions).toBe(1);
  });
});
