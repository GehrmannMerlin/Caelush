import { describe, expect, it } from "vitest";
import {
  ToolDispatcherBusyError,
  ToolExecutionConflictError,
  type ToolDispatchRequest,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from "../src/index.js";
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
import { ToolDispatcher, ToolRegistryBuilder } from "../src/index.js";
import type {
  DurableToolAgentEvent,
  ToolCommittedEventNotifier,
  ToolExecutionCommit,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

class Store implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();
  readonly events: DurableToolAgentEvent[] = [];
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
    const events = command.events.map((event, index) => ({
      ...event,
      durability: { ...event.durability, sequence: this.events.length + index + 1 },
    })) as DurableToolAgentEvent[];
    this.events.push(...events);
    return { snapshot, events };
  }
}

function request(): ToolDispatchRequest {
  return {
    sessionId: createSessionId(),
    runId: createRunId(),
    stepId: createStepId(),
    externalCallId: "call-1",
    toolName: "echo_value",
    args: { value: "hello" },
    environment,
    securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
  };
}

function dispatcher(
  store: Store,
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
  const registry = builder.build();
  const notifier: ToolCommittedEventNotifier = { notifyCommitted() {} };
  return new ToolDispatcher({
    registry,
    store,
    gate: { decide: async () => ({ kind: "ALLOW" as const }) },
    notifier,
    clock: {
      now: (() => {
        let value = 100;
        return () => createTimestampMs(++value);
      })(),
    },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    resultSanitizer: { sanitize: ({ result }) => result },
  });
}

describe("ToolDispatcher idempotency", () => {
  it("returns the durable result for an exact duplicate without executing twice", async () => {
    const store = new Store();
    let count = 0;
    const run = dispatcher(store, async () => {
      count += 1;
      return { content: "hello", details: { echoed: "hello" }, isError: false };
    });
    const call = request();
    const first = await run.dispatch(call);
    const second = await run.dispatch(call);

    expect(first).toEqual(second);
    expect(count).toBe(1);
  });

  it("rejects the same call identity when tool arguments differ", async () => {
    const store = new Store();
    const run = dispatcher(store, async () => ({
      content: "hello",
      details: { echoed: "hello" },
      isError: false,
    }));
    const call = request();
    await run.dispatch(call);

    await expect(run.dispatch({ ...call, args: { value: "other" } })).rejects.toBeInstanceOf(
      ToolExecutionConflictError,
    );
  });

  it("blocks concurrent duplicate execution in the same process", async () => {
    const store = new Store();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = dispatcher(store, async () => {
      await blocked;
      return { content: "hello", details: { echoed: "hello" }, isError: false };
    });
    const call = request();
    const first = run.dispatch(call);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(run.dispatch(call)).rejects.toBeInstanceOf(ToolDispatcherBusyError);
    release();
    await first;
  });
});
