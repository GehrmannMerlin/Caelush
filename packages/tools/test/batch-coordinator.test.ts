import {
  createEventId,
  createApprovalRequestId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ToolBatchCoordinator,
  ToolBatchInputError,
  ToolDispatcher,
  ToolExecutionConflictError,
  ToolExecutionUncertainError,
  ToolRegistryBuilder,
  createRequestedToolInvocation,
  startToolInvocation,
  type ToolBatchRequest,
  type ToolExecutionCommit,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

class Store implements ToolExecutionStorePort {
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
    if ((current?.revision ?? null) !== command.expectedRevision) {
      throw new ToolExecutionConflictError("conflict");
    }
    const snapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (current?.revision ?? 0) + 1,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
      ...(command.approval === undefined ? {} : { approval: command.approval }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    return { snapshot, events: [] };
  }
}

const sessionId = createSessionId();
const runId = createRunId();
const stepId = createStepId();

function item(externalCallId: string, toolName: "slow_a" | "fast_b" | "approval_tool", args = {}) {
  return { externalCallId, toolName, args } as const;
}

function request(items: ToolBatchRequest["items"]): ToolBatchRequest {
  return {
    sessionId,
    runId,
    stepId,
    environment,
    securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
    items,
  };
}

function makeCoordinator(options: {
  gate?: (toolName: string) => "ALLOW" | "REQUIRE_APPROVAL";
  execute: (request: ToolExecutionRequest) => Promise<ToolExecutionResult>;
}) {
  const store = new Store();
  const builder = new ToolRegistryBuilder();
  for (const name of ["slow_a", "fast_b", "approval_tool"] as const) {
    builder.register({
      definition: {
        name,
        description: name,
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
        riskLevel: "LOW",
        requiredCapabilities: [],
        runtimeRequirements: {},
      },
      handler: { execute: options.execute },
    });
  }
  const dispatcher = new ToolDispatcher({
    registry: builder.build(),
    store,
    gate: { decide: async ({ toolName }) => ({ kind: options.gate?.(toolName) ?? "ALLOW" }) },
    notifier: { notifyCommitted() {} },
    clock: {
      now: (() => {
        let now = 300;
        return () => createTimestampMs(++now);
      })(),
    },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    approvalStore: {
      getByInvocation: async (invocationId) => store.snapshots.get(invocationId)?.approval ?? null,
      findApplicableRunGrant: async () => null,
    },
    approvalIdFactory: { create: createApprovalRequestId },
    resultSanitizer: { sanitize: ({ result }) => result },
  });
  return { coordinator: new ToolBatchCoordinator(dispatcher), dispatcher, store };
}

describe("ToolBatchCoordinator", () => {
  it("returns the uncertain result and skips trailing tool calls", async () => {
    const calls: string[] = [];
    const { coordinator } = makeCoordinator({
      execute: async ({ externalCallId }) => {
        calls.push(externalCallId);
        if (externalCallId === "B") throw new ToolExecutionUncertainError();
        return { content: externalCallId, details: {}, isError: false };
      },
    });

    const outcome = await coordinator.execute(
      request([item("A", "slow_a"), item("B", "fast_b"), item("C", "slow_a")]),
    );

    expect(outcome.kind).toBe("COMPLETED");
    if (outcome.kind !== "COMPLETED") throw new Error("expected completed batch");
    expect(calls).toEqual(["A", "B"]);
    expect(
      outcome.results.map((result) => [result.externalCallId, result.kind, result.isError]),
    ).toEqual([
      ["A", "TOOL_RESULT", false],
      ["B", "TOOL_RESULT", true],
      ["C", "SKIPPED_AFTER_UNCERTAIN_EXECUTION", true],
    ]);
  });

  it("rejects empty and duplicate batches before dispatch side effects", async () => {
    let dispatches = 0;
    const { coordinator } = makeCoordinator({
      execute: async () => {
        dispatches += 1;
        return { content: "ok", details: {}, isError: false };
      },
    });

    await expect(coordinator.execute(request([]))).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      coordinator.execute(request([item("same", "slow_a"), item("same", "fast_b")])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    expect(dispatches).toBe(0);
  });

  it("rejects malformed items and oversized external identities before dispatch", async () => {
    let dispatches = 0;
    const { coordinator } = makeCoordinator({
      execute: async () => {
        dispatches += 1;
        return { content: "ok", details: {}, isError: false };
      },
    });

    await expect(
      coordinator.execute(request([{ ...item("A", "slow_a"), extra: true } as never])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      coordinator.execute(request([item("A", "slow_a", { invalid: undefined })])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    await expect(
      coordinator.execute(request([item("x".repeat(513), "slow_a")])),
    ).rejects.toBeInstanceOf(ToolBatchInputError);
    expect(dispatches).toBe(0);
  });

  it("executes strictly in source order with one active handler", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { coordinator } = makeCoordinator({
      execute: async ({ externalCallId }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${externalCallId}`);
        await new Promise((resolve) => setTimeout(resolve, externalCallId === "A" ? 5 : 0));
        events.push(`finish:${externalCallId}`);
        active -= 1;
        return { content: externalCallId, details: {}, isError: externalCallId === "B" };
      },
    });

    const outcome = await coordinator.execute(request([item("A", "slow_a"), item("B", "fast_b")]));

    expect(outcome.kind).toBe("COMPLETED");
    if (outcome.kind !== "COMPLETED") throw new Error("expected completed batch");
    expect(events).toEqual(["start:A", "finish:A", "start:B", "finish:B"]);
    expect(maxActive).toBe(1);
    expect(outcome.results.map((result) => [result.externalCallId, result.isError])).toEqual([
      ["A", false],
      ["B", true],
    ]);
  });

  it("stops at approval without dispatching trailing items", async () => {
    const calls: string[] = [];
    const { coordinator, store } = makeCoordinator({
      gate: (toolName) => (toolName === "approval_tool" ? "REQUIRE_APPROVAL" : "ALLOW"),
      execute: async ({ externalCallId }) => {
        calls.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
    });

    const outcome = await coordinator.execute(
      request([item("A", "slow_a"), item("B", "approval_tool"), item("C", "fast_b")]),
    );

    expect(outcome.kind).toBe("WAITING_APPROVAL");
    if (outcome.kind !== "WAITING_APPROVAL") throw new Error("expected approval boundary");
    expect(outcome.completedResults.map((result) => result.externalCallId)).toEqual(["A"]);
    expect(outcome.waiting.externalCallId).toBe("B");
    expect(calls).toEqual(["A"]);
    expect(
      [...store.snapshots.values()].map(({ invocation }) => invocation.externalCallId),
    ).toEqual(["A", "B"]);
    expect(store.snapshots.get([...store.snapshots.keys()][1] ?? "")?.invocation.status).toBe(
      "WAITING_APPROVAL",
    );
  });

  it("recovers uncertain execution and skips all trailing calls", async () => {
    const calls: string[] = [];
    const { coordinator, dispatcher, store } = makeCoordinator({
      execute: async ({ externalCallId }) => {
        calls.push(externalCallId);
        return { content: externalCallId, details: {}, isError: false };
      },
    });
    const first = await dispatcher.dispatch({
      sessionId,
      runId,
      stepId,
      externalCallId: "A",
      toolName: "slow_a",
      args: {},
      environment,
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
    });
    expect(first.kind).toBe("RESULT");
    const running = startToolInvocation(
      createRequestedToolInvocation({
        id: createToolInvocationId(),
        runId,
        stepId,
        externalCallId: "B",
        toolName: "fast_b",
        args: {},
        riskLevel: "LOW",
        createdAt: createTimestampMs(200),
      }),
      createTimestampMs(201),
    );
    store.snapshots.set(running.id, { sessionId, invocation: running, revision: 1 });

    const outcome = await coordinator.recover(
      request([item("A", "slow_a"), item("B", "fast_b"), item("C", "slow_a")]),
    );

    expect(outcome.kind).toBe("COMPLETED");
    if (outcome.kind !== "COMPLETED") throw new Error("expected completed recovery batch");
    expect(
      outcome.results.map((result) => [result.externalCallId, result.kind, result.isError]),
    ).toEqual([
      ["A", "TOOL_RESULT", false],
      ["B", "TOOL_RESULT", true],
      ["C", "SKIPPED_AFTER_UNCERTAIN_EXECUTION", true],
    ]);
    expect(calls).toEqual(["A"]);
    expect(
      [...store.snapshots.values()].some(({ invocation }) => invocation.externalCallId === "C"),
    ).toBe(false);
  });
});
