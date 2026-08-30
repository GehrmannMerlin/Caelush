import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolObservation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ToolDispatcher,
  ToolDispatcherInfrastructureError,
  ToolRegistryBuilder,
  type DurableToolAgentEvent,
  type ToolCommittedEventNotifier,
  type ToolExecutionGateDecision,
  type ToolExecutionStorePort,
  type ToolExecutionSnapshot,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolSecurityFactsProjector,
  type ToolSecurityFacts,
  type ToolResultSanitizerPort,
} from "../src/index.js";
import type { ToolExecutionCommit, ToolDispatchRequest } from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

function makeRequest(): ToolDispatchRequest {
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

function makeDefinition() {
  return {
    name: "echo_value" as const,
    description: "Echo a value.",
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
}

class MemoryStore implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();
  readonly events: DurableToolAgentEvent[] = [];

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
    const existing = this.snapshots.get(command.invocation.id);
    const actual = existing?.revision ?? null;
    if (actual !== command.expectedRevision) throw new Error("revision conflict");
    const snapshot: ToolExecutionSnapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (existing?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    const sequenced = command.events.map((event, index) => ({
      ...event,
      durability: { ...event.durability, sequence: this.events.length + index + 1 },
    })) as DurableToolAgentEvent[];
    this.events.push(...sequenced);
    return { snapshot, events: sequenced };
  }
}

function makeDispatcher(
  store: MemoryStore,
  decision: ToolExecutionGateDecision = { kind: "ALLOW" },
  execute: (request: ToolExecutionRequest) => Promise<ToolExecutionResult> = async () => ({
    content: "hello",
    details: { echoed: "hello" },
    isError: false,
  }),
  securityFactsProjector?: ToolSecurityFactsProjector,
  factsSeen?: { value?: ToolSecurityFacts },
  resultSanitizer?: ToolResultSanitizerPort,
) {
  let now = 100;
  const definition = makeDefinition();
  const builder = new ToolRegistryBuilder();
  builder.register({
    definition,
    handler: { execute },
    ...(securityFactsProjector === undefined ? {} : { securityFactsProjector }),
  });
  const registry = builder.build();
  const notifier: ToolCommittedEventNotifier = { notifyCommitted() {} };
  return new ToolDispatcher({
    registry,
    store,
    gate: {
      decide: async (input) => {
        if (factsSeen !== undefined && input.securityFacts !== undefined) {
          factsSeen.value = input.securityFacts;
        }
        return decision;
      },
    },
    notifier,
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    resultSanitizer: resultSanitizer ?? { sanitize: ({ result }) => result },
  });
}

describe("ToolDispatcher execution", () => {
  it("sanitizes a validated result before effects and durable observation", async () => {
    const dispatcher = makeDispatcher(
      new MemoryStore(),
      { kind: "ALLOW" },
      async () => ({ content: "raw-secret", details: { echoed: "raw-secret" }, isError: false }),
      undefined,
      undefined,
      {
        sanitize: ({ result }) => ({ ...result, content: "[REDACTED]", details: { echoed: "[REDACTED]" } }),
      },
    );

    const outcome = await dispatcher.dispatch(makeRequest());

    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind === "RESULT") {
      expect(outcome.observation.content).toBe("[REDACTED]");
      expect(outcome.observation.details).toEqual({ echoed: "[REDACTED]" });
    }
  });

  it("leaves an executed invocation RUNNING when sanitization fails", async () => {
    const store = new MemoryStore();
    const dispatcher = makeDispatcher(
      store,
      { kind: "ALLOW" },
      undefined,
      undefined,
      undefined,
      { sanitize: () => { throw new Error("sanitizer failure"); } },
    );

    await expect(dispatcher.dispatch(makeRequest())).rejects.toBeInstanceOf(
      ToolDispatcherInfrastructureError,
    );
    const snapshot = [...store.snapshots.values()].at(-1);
    expect(snapshot?.invocation.status).toBe("RUNNING");
    expect(snapshot?.observation).toBeUndefined();
  });

  it("projects host-only security facts after input validation and before the gate", async () => {
    const store = new MemoryStore();
    const factsSeen: { value?: ToolSecurityFacts } = {};
    const dispatcher = makeDispatcher(
      store,
      { kind: "ALLOW" },
      undefined,
      () => ({
        resourceAccesses: [{ operation: "READ", path: "src/app.ts" }],
        secretScanInputs: [],
      }),
      factsSeen,
    );

    await dispatcher.dispatch(makeRequest());

    expect(factsSeen.value).toEqual({
      resourceAccesses: [{ operation: "READ", path: "src/app.ts" }],
      secretScanInputs: [],
    });
  });

  it("turns a security facts projector failure into opaque input for the gate", async () => {
    const factsSeen: { value?: ToolSecurityFacts } = {};
    const dispatcher = makeDispatcher(
      new MemoryStore(),
      { kind: "DENY" },
      undefined,
      () => {
        throw new Error("cannot interpret input");
      },
      factsSeen,
    );

    await dispatcher.dispatch(makeRequest());

    expect(factsSeen.value).toEqual({
      resourceAccesses: [],
      secretScanInputs: [],
      opaqueInput: true,
    });
  });

  it("durably checkpoints RUNNING before invoking the handler and settles success", async () => {
    const store = new MemoryStore();
    let handlerCount = 0;
    let firstObservation: ToolObservation | undefined;
    const dispatcher = makeDispatcher(store, { kind: "ALLOW" }, async (request) => {
      handlerCount += 1;
      const snapshot = await store.load(request.invocationId);
      firstObservation = snapshot?.observation;
      expect(snapshot?.invocation.status).toBe("RUNNING");
      expect(store.events.map((event) => event.type)).toEqual(["tool.requested", "tool.started"]);
      return { content: "hello", details: { echoed: "hello" }, isError: false };
    });

    const request = makeRequest();
    const outcome = await dispatcher.dispatch(request);

    expect(outcome.kind).toBe("RESULT");
    expect(handlerCount).toBe(1);
    expect(firstObservation).toBeUndefined();
    if (outcome.kind !== "RESULT") throw new Error("expected result");
    expect(outcome.invocation.status).toBe("COMPLETED");
    expect(outcome.observation).toMatchObject({
      content: "hello",
      details: { echoed: "hello" },
      isError: false,
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.started",
      "tool.completed",
    ]);
  });

  it("freezes handler args and clones result details before persistence", async () => {
    const store = new MemoryStore();
    let returnedDetails: { echoed: string } | undefined;
    const dispatcher = makeDispatcher(store, { kind: "ALLOW" }, async (request) => {
      expect(Object.isFrozen(request.args)).toBe(true);
      expect(Reflect.set(request.args, "value", "mutated")).toBe(false);
      expect(request.args.value).toBe("hello");
      returnedDetails = { echoed: "hello" };
      return { content: "hello", details: returnedDetails, isError: false };
    });

    const outcome = await dispatcher.dispatch(makeRequest());

    returnedDetails!.echoed = "mutated-after-return";
    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind !== "RESULT") throw new Error("expected result");
    expect(outcome.invocation.args).toEqual({ value: "hello" });
    expect(outcome.observation.details).toEqual({ echoed: "hello" });
  });

  it("returns an unavailable-tool result without creating an invocation", async () => {
    const store = new MemoryStore();
    const dispatcher = makeDispatcher(store);
    const request = { ...makeRequest(), toolName: "missing_tool" as const };

    const outcome = await dispatcher.dispatch(request);

    expect(outcome.kind).toBe("UNAVAILABLE_TOOL");
    expect(store.snapshots.size).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it("denies before RUNNING and persists a model-recoverable permission result", async () => {
    const store = new MemoryStore();
    let handlerCount = 0;
    const dispatcher = makeDispatcher(store, { kind: "DENY" }, async () => {
      handlerCount += 1;
      return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
    });

    const outcome = await dispatcher.dispatch(makeRequest());

    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind !== "RESULT") throw new Error("expected result");
    expect(handlerCount).toBe(0);
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.code).toBe("PERMISSION_DENIED");
    expect(outcome.observation.isError).toBe(true);
    expect(store.events.map((event) => event.type)).toEqual(["tool.requested", "tool.failed"]);
  });

  it("durably waits for approval without creating an observation or invoking the handler", async () => {
    const store = new MemoryStore();
    let handlerCount = 0;
    const dispatcher = makeDispatcher(store, { kind: "REQUIRE_APPROVAL" }, async () => {
      handlerCount += 1;
      return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
    });

    const outcome = await dispatcher.dispatch(makeRequest());

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind !== "WAITING_APPROVAL") throw new Error("expected waiting approval");
    expect(outcome.invocation.status).toBe("WAITING_APPROVAL");
    expect(handlerCount).toBe(0);
    expect(store.events.map((event) => event.type)).toEqual(["tool.requested"]);
  });

  it("returns an ordinary handler error as a failed model result", async () => {
    const store = new MemoryStore();
    const dispatcher = makeDispatcher(store, { kind: "ALLOW" }, async () => ({
      content: "Requested value was not found.",
      details: { echoed: "not-found" },
      isError: true,
    }));

    const outcome = await dispatcher.dispatch(makeRequest());

    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind !== "RESULT") throw new Error("expected result");
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.code).toBe("TOOL_EXECUTION_ERROR");
    expect(outcome.observation.isError).toBe(true);
    expect(outcome.observation.content).toBe("Requested value was not found.");
  });

  it("persists invalid input as a failed invocation without calling the handler", async () => {
    const store = new MemoryStore();
    let handlerCount = 0;
    const dispatcher = makeDispatcher(store, { kind: "ALLOW" }, async () => {
      handlerCount += 1;
      return { content: "unexpected", details: { echoed: "unexpected" }, isError: false };
    });

    const outcome = await dispatcher.dispatch({ ...makeRequest(), args: { value: 42 } });

    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind !== "RESULT") throw new Error("expected result");
    expect(handlerCount).toBe(0);
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.code).toBe("TOOL_ARGUMENT_ERROR");
    expect(store.events.map((event) => event.type)).toEqual(["tool.requested", "tool.failed"]);
  });

  it("sanitizes an unexpected handler throw, settles it, and throws infrastructure failure", async () => {
    const store = new MemoryStore();
    const dispatcher = makeDispatcher(store, { kind: "ALLOW" }, async () => {
      throw new Error("CAELUSH_TOOL_THROW_SECRET_126");
    });

    await expect(dispatcher.dispatch(makeRequest())).rejects.toBeInstanceOf(
      ToolDispatcherInfrastructureError,
    );
    const [snapshot] = [...store.snapshots.values()];
    expect(snapshot?.invocation.status).toBe("FAILED");
    expect(snapshot?.invocation.error?.code).toBe("RUNTIME_ERROR");
    expect(snapshot?.observation?.content).not.toContain("CAELUSH_TOOL_THROW_SECRET_126");
    expect(JSON.stringify(store.events)).not.toContain("CAELUSH_TOOL_THROW_SECRET_126");
  });

  it("fails closed when handler output violates the registered output schema", async () => {
    const store = new MemoryStore();
    const dispatcher = makeDispatcher(store, { kind: "ALLOW" }, async () => ({
      content: "CAELUSH_TOOL_RESULT_SECRET_84",
      details: { echoed: 42 },
      isError: false,
    }));

    await expect(dispatcher.dispatch(makeRequest())).rejects.toBeInstanceOf(
      ToolDispatcherInfrastructureError,
    );
    const [snapshot] = [...store.snapshots.values()];
    expect(snapshot?.invocation.status).toBe("FAILED");
    expect(snapshot?.invocation.error?.code).toBe("TOOL_OUTPUT_ERROR");
    expect(snapshot?.observation?.details).toEqual({});
    expect(JSON.stringify(store.events)).not.toContain("CAELUSH_TOOL_RESULT_SECRET_84");
  });
});
