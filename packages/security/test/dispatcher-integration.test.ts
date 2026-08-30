import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type Capability,
  type RiskLevel,
} from "@caelush/protocol";
import {
  ToolDispatcher,
  ToolBatchCoordinator,
  ToolRegistryBuilder,
  createRequestedToolInvocation,
  type ToolCommittedEventNotifier,
  type ToolDispatchRequest,
  type ToolBatchRequest,
  type ToolExecutionCommit,
  type ToolExecutionResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "@caelush/tools";
import { describe, expect, it } from "vitest";
import { CaelushToolExecutionGate } from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "fixture" },
} as const;

class MemoryStore implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();

  async load(invocationId: string): Promise<ToolExecutionSnapshot | null> {
    return this.snapshots.get(invocationId) ?? null;
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
    if ((current?.revision ?? null) !== command.expectedRevision) throw new Error("conflict");
    const snapshot: ToolExecutionSnapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (current?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    return { snapshot, events: [] };
  }
}

function definition(
  name: "mutate_value" | "read_value" | "suffix_value",
  requiredCapabilities: readonly Capability[],
  riskLevel: RiskLevel = "HIGH",
) {
  return {
    name,
    description: "Mutate a value.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    riskLevel,
    requiredCapabilities: [...requiredCapabilities],
    runtimeRequirements: {},
  };
}

function request(securityContext: ToolDispatchRequest["securityContext"]): ToolDispatchRequest {
  return {
    sessionId: createSessionId(),
    runId: createRunId(),
    stepId: createStepId(),
    externalCallId: "call-1",
    toolName: "mutate_value",
    args: {},
    environment,
    securityContext,
  };
}

function batchRequest(securityContext: ToolBatchRequest["securityContext"]): ToolBatchRequest {
  return {
    sessionId: createSessionId(),
    runId: createRunId(),
    stepId: createStepId(),
    environment,
    securityContext,
    items: [
      { externalCallId: "read-call", toolName: "read_value", args: {} },
      { externalCallId: "patch-call", toolName: "mutate_value", args: {} },
      { externalCallId: "suffix-call", toolName: "suffix_value", args: {} },
    ],
  };
}

function createDispatcher(store: MemoryStore, onExecute: () => void): ToolDispatcher {
  const builder = new ToolRegistryBuilder();
  builder.register({
    definition: definition("mutate_value", ["FS_WRITE", "FS_DELETE"]),
    handler: {
      async execute(): Promise<ToolExecutionResult> {
        onExecute();
        return { content: "mutated", details: {}, isError: false };
      },
    },
  });
  const notifier: ToolCommittedEventNotifier = { notifyCommitted() {} };
  let now = 100;
  return new ToolDispatcher({
    registry: builder.build(),
    store,
    gate: new CaelushToolExecutionGate(),
    notifier,
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
}

function createBatchDispatcher(store: MemoryStore, executions: string[]): ToolBatchCoordinator {
  const builder = new ToolRegistryBuilder();
  for (const [name, capabilities, riskLevel] of [
    ["read_value", ["FS_READ"], "LOW"],
    ["mutate_value", ["FS_WRITE", "FS_DELETE"], "HIGH"],
    ["suffix_value", ["FS_READ"], "LOW"],
  ] as const) {
    builder.register({
      definition: definition(name, capabilities, riskLevel),
      handler: {
        async execute(): Promise<ToolExecutionResult> {
          executions.push(name);
          return { content: name, details: {}, isError: false };
        },
      },
    });
  }
  const notifier: ToolCommittedEventNotifier = { notifyCommitted() {} };
  let now = 100;
  const dispatcher = new ToolDispatcher({
    registry: builder.build(),
    store,
    gate: new CaelushToolExecutionGate(),
    notifier,
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
  });
  return new ToolBatchCoordinator(dispatcher);
}

describe("Security Gate and Dispatcher integration", () => {
  it("allows the prefix, pauses at approval, and does not execute the suffix", async () => {
    const executions: string[] = [];
    const coordinator = createBatchDispatcher(new MemoryStore(), executions);
    const outcome = await coordinator.execute(
      batchRequest({ permissionProfile: "PROJECT_ACCESS", approvalPolicy: "DANGEROUS_ONLY" }),
    );

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind === "WAITING_APPROVAL") {
      expect(outcome.waiting.index).toBe(1);
      expect(outcome.completedResults).toHaveLength(1);
    }
    expect(executions).toEqual(["read_value"]);
  });

  it("allows an authorized structured mutation and executes once", async () => {
    let executions = 0;
    const dispatcher = createDispatcher(new MemoryStore(), () => {
      executions += 1;
    });
    const outcome = await dispatcher.dispatch(
      request({
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "NEVER_ASK",
      }),
    );

    expect(outcome.kind).toBe("RESULT");
    expect(executions).toBe(1);
    if (outcome.kind === "RESULT") expect(outcome.invocation.status).toBe("COMPLETED");
  });

  it("denies a missing capability without invoking the handler", async () => {
    let executions = 0;
    const dispatcher = createDispatcher(new MemoryStore(), () => {
      executions += 1;
    });
    const outcome = await dispatcher.dispatch(
      request({
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ALWAYS_ASK",
      }),
    );

    expect(outcome.kind).toBe("RESULT");
    expect(executions).toBe(0);
    if (outcome.kind === "RESULT") {
      expect(outcome.invocation.status).toBe("FAILED");
      expect(outcome.observation).toMatchObject({ isError: true });
      expect(outcome.invocation.error).toMatchObject({
        code: "PERMISSION_DENIED",
        phase: "SECURITY",
        retryable: false,
      });
    }
  });

  it("stops at the approval boundary without invoking the handler", async () => {
    let executions = 0;
    const dispatcher = createDispatcher(new MemoryStore(), () => {
      executions += 1;
    });
    const outcome = await dispatcher.dispatch(
      request({
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
      }),
    );

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    expect(executions).toBe(0);
    if (outcome.kind === "WAITING_APPROVAL") {
      expect(outcome.invocation.status).toBe("WAITING_APPROVAL");
    }
  });

  it("keeps a durable WAITING_APPROVAL invocation paused during recovery", async () => {
    let executions = 0;
    const store = new MemoryStore();
    const dispatcher = createDispatcher(store, () => {
      executions += 1;
    });
    const waiting = await dispatcher.dispatch(
      request({
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
      }),
    );
    expect(waiting.kind).toBe("WAITING_APPROVAL");
    if (waiting.kind !== "WAITING_APPROVAL") throw new Error("expected approval boundary");

    const recovered = await dispatcher.recover(waiting.invocation.id, environment, {
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "NEVER_ASK",
    });

    expect(recovered).toEqual(waiting);
    expect(executions).toBe(0);
  });

  it("re-evaluates a durable REQUESTED invocation with the supplied Run context", async () => {
    let executions = 0;
    const store = new MemoryStore();
    const dispatcher = createDispatcher(store, () => {
      executions += 1;
    });
    const original = request({ permissionProfile: "READ_ONLY", approvalPolicy: "NEVER_ASK" });
    const invocation = createRequestedToolInvocation({
      id: createToolInvocationId(),
      runId: original.runId,
      stepId: original.stepId,
      toolName: original.toolName,
      externalCallId: original.externalCallId,
      args: original.args,
      riskLevel: "HIGH",
      createdAt: createTimestampMs(1),
    });
    await store.commit({
      sessionId: original.sessionId,
      invocation,
      expectedRevision: null,
      events: [],
    });

    const recovered = await dispatcher.recover(
      invocation.id,
      environment,
      original.securityContext,
    );

    expect(recovered.kind).toBe("RESULT");
    expect(executions).toBe(0);
    if (recovered.kind === "RESULT") {
      expect(recovered.invocation.status).toBe("FAILED");
      expect(recovered.invocation.error?.code).toBe("PERMISSION_DENIED");
    }
  });
});
