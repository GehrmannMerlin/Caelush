import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type JsonObject,
  type ToolDefinition,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@caelush/agent";
import {
  createToolExecutionDependencies,
  ToolDispatcher,
  ToolExecutionUncertainError,
  ToolRegistryBuilder,
  validateToolExecutionResult,
  type ToolExecutionCommit,
  type ToolExecutionCommitResult,
  type ToolExecutionRequest,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "../src/index.js";

/**
 * Legacy execution delegation.
 *
 * ```text
 * ToolDispatcher.startAndExecute -> durable RUNNING -> canonical executor -> AgentTool.execute
 *                                                                              ↓ (adapter)
 *                                                                        legacy ToolHandler
 * ```
 *
 * The point of these tests is *which* implementation actually ran. Each one drives the real
 * production shell and observes the canonical layer, not a legacy copy of it: the AgentTool is the
 * thing that was called, the handler is reached only through the adapter that built that AgentTool,
 * and the result the shell commits came back through the canonical pipeline.
 */

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

const securityContext = {
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "NEVER_ASK",
} as const;

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "echo_value",
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
    riskLevel: "LOW",
    requiredCapabilities: [],
    runtimeRequirements: {},
    ...overrides,
  };
}

class Store implements ToolExecutionStorePort {
  readonly snapshots = new Map<string, ToolExecutionSnapshot>();

  async load(invocationId: string): Promise<ToolExecutionSnapshot | null> {
    return this.snapshots.get(invocationId) ?? null;
  }

  async findByExternalCall(): Promise<ToolExecutionSnapshot | null> {
    return null;
  }

  async commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult> {
    const snapshot: ToolExecutionSnapshot = {
      sessionId: command.sessionId,
      invocation: command.invocation,
      revision: (this.snapshots.size + 1) as never,
      ...(command.observation === undefined ? {} : { observation: command.observation }),
    };
    this.snapshots.set(command.invocation.id, snapshot);
    return { snapshot, events: [] };
  }
}

function dispatchRequest(args: JsonObject = { value: "hello" }) {
  return {
    sessionId: createSessionId(),
    runId: createRunId(),
    stepId: createStepId(),
    externalCallId: "call-1",
    toolName: "echo_value" as const,
    args,
    environment,
    securityContext,
  };
}

function buildDispatcher(input: {
  readonly execute: (request: ToolExecutionRequest) => Promise<{
    readonly content: string;
    readonly details: JsonObject;
    readonly isError: boolean;
  }>;
  readonly store?: Store;
  readonly agentTool?: AgentTool;
}) {
  const store = input.store ?? new Store();
  const builder = new ToolRegistryBuilder();
  builder.register({
    definition: definition(),
    handler: { execute: input.execute },
    ...(input.agentTool === undefined ? {} : { adapters: { agent: input.agentTool } }),
  });
  const registry = builder.build();
  let now = 100;
  const dispatcher = new ToolDispatcher({
    registry,
    store,
    gate: { decide: async () => ({ kind: "ALLOW" as const }) },
    notifier: { notifyCommitted() {} },
    clock: { now: () => createTimestampMs(++now) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    execution: createToolExecutionDependencies({ registry }),
  });
  return { dispatcher, store, registry };
}

describe("legacy ToolDispatcher execution delegation", () => {
  it("reaches the canonical AgentTool, not the handler directly", async () => {
    const handlerExecute = vi.fn(async () => ({
      content: "from the handler",
      details: { echoed: "from the handler" },
      isError: false,
    }));
    const executorSpy = vi.fn(async () => ({
      content: "from the canonical AgentTool",
      details: { echoed: "from the canonical AgentTool" },
      isError: false,
    }));
    const agentTool: AgentTool = {
      name: "echo_value",
      description: "Echo a value.",
      inputSchema: definition().inputSchema,
      label: "Echo Value",
      resultDetailsSchema: definition().outputSchema,
      executionMode: "SEQUENTIAL",
      execute: executorSpy,
    };
    const { dispatcher } = buildDispatcher({
      execute: handlerExecute,
      agentTool,
    });

    const outcome = await dispatcher.dispatch(dispatchRequest());

    expect(outcome.kind).toBe("RESULT");
    // The AgentTool is the execution authority; the handler is not reached at all when the
    // registration carries an AgentTool of its own.
    expect(executorSpy).toHaveBeenCalledTimes(1);
    expect(handlerExecute).not.toHaveBeenCalled();
    if (outcome.kind === "RESULT") {
      expect(outcome.observation.content).toBe("from the canonical AgentTool");
    }
  });

  it("reaches a legacy handler only through the AgentTool adapter", async () => {
    const handlerExecute = vi.fn(async (request: ToolExecutionRequest) => ({
      content: `handler saw ${String(request.args.value)}`,
      details: { echoed: String(request.args.value) },
      isError: false,
    }));
    const { dispatcher } = buildDispatcher({ execute: handlerExecute });

    const outcome = await dispatcher.dispatch(dispatchRequest());

    expect(outcome.kind).toBe("RESULT");
    expect(handlerExecute).toHaveBeenCalledTimes(1);
    // The adapter forwards the canonical identity and the effective arguments it always did.
    const request = handlerExecute.mock.calls[0]![0];
    expect(request.externalCallId).toBe("call-1");
    expect(request.args).toEqual({ value: "hello" });
    expect(request.environment).toEqual(environment);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    if (outcome.kind === "RESULT") {
      expect(outcome.observation.content).toBe("handler saw hello");
    }
  });

  it("passes the prepared arguments and the durable identity to the executor", async () => {
    const seen: { identity?: unknown; args?: JsonObject } = {};
    const agentTool: AgentTool = {
      name: "echo_value",
      description: "Echo a value.",
      inputSchema: definition().inputSchema,
      label: "Echo Value",
      resultDetailsSchema: definition().outputSchema,
      executionMode: "SEQUENTIAL",
      execute: async (input) => {
        seen.identity = input.identity;
        // The canonical `AgentTool` speaks the AI package's JSON model; the assertion only needs the
        // value, so the two declarations meet at this boundary like everywhere else.
        seen.args = input.args as unknown as JsonObject;
        return { content: "ok", details: { echoed: "ok" }, isError: false };
      },
    };
    const { dispatcher, store } = buildDispatcher({
      execute: async () => ({ content: "unused", details: {}, isError: false }),
      agentTool,
    });

    await dispatcher.dispatch(dispatchRequest());

    const identity = seen.identity as {
      runId: string;
      sourceStepId: string;
      invocationId: string;
      externalCallId: string;
      sessionId: string;
    };
    const snapshot = [...store.snapshots.values()][0]!;
    expect(identity.invocationId).toBe(snapshot.invocation.id);
    expect(identity.runId).toBe(snapshot.invocation.runId);
    expect(identity.sourceStepId).toBe(snapshot.invocation.stepId);
    expect(identity.externalCallId).toBe("call-1");
    expect(identity.sessionId).toBe(snapshot.sessionId);
    expect(seen.args).toEqual({ value: "hello" });
  });

  it("reaches the canonical update path, delivering nothing by default", async () => {
    const agentTool: AgentTool = {
      name: "echo_value",
      description: "Echo a value.",
      inputSchema: definition().inputSchema,
      label: "Echo Value",
      resultDetailsSchema: definition().outputSchema,
      executionMode: "SEQUENTIAL",
      execute: async ({ updates }) => {
        // A canonical Tool may publish; with no transient transport configured the update is dropped
        // and the durable result is unaffected.
        updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "progress" });
        return { content: "ok", details: { echoed: "ok" }, isError: false };
      },
    };
    const { dispatcher } = buildDispatcher({
      execute: async () => ({ content: "unused", details: {}, isError: false }),
      agentTool,
    });

    const outcome = await dispatcher.dispatch(dispatchRequest());
    expect(outcome.kind).toBe("RESULT");
  });

  it("preserves UNCERTAIN_SIDE_EFFECT when the canonical executor reports uncertainty", async () => {
    const agentTool: AgentTool = {
      name: "echo_value",
      description: "Echo a value.",
      inputSchema: definition().inputSchema,
      label: "Echo Value",
      resultDetailsSchema: definition().outputSchema,
      executionMode: "SEQUENTIAL",
      execute: async () => {
        throw new ToolExecutionUncertainError();
      },
    };
    const { dispatcher, store } = buildDispatcher({
      execute: async () => ({ content: "unused", details: {}, isError: false }),
      agentTool,
    });

    const outcome = await dispatcher.dispatch(dispatchRequest());

    expect(outcome.kind).toBe("RESULT");
    if (outcome.kind !== "RESULT") throw new Error("expected a result");
    expect(outcome.invocation.status).toBe("FAILED");
    expect(outcome.invocation.error?.details?.executionDisposition).toBe("UNCERTAIN_SIDE_EFFECT");
    expect(outcome.observation.isError).toBe(true);
    expect(store.snapshots.size).toBeGreaterThan(0);
  });

  it("classifies an unknown Tool throw as an execution infrastructure failure", async () => {
    const agentTool: AgentTool = {
      name: "echo_value",
      description: "Echo a value.",
      inputSchema: definition().inputSchema,
      label: "Echo Value",
      resultDetailsSchema: definition().outputSchema,
      executionMode: "SEQUENTIAL",
      execute: async () => {
        throw new TypeError("internal bug");
      },
    };
    const { dispatcher, store } = buildDispatcher({
      execute: async () => ({ content: "unused", details: {}, isError: false }),
      agentTool,
    });

    await expect(dispatcher.dispatch(dispatchRequest())).rejects.toThrowError(/execution/i);
    const snapshot = [...store.snapshots.values()].at(-1)!;
    expect(snapshot.invocation.error?.code).toBe("RUNTIME_ERROR");
  });

  it("keeps the legacy result validation entry point answering identically", () => {
    const { registry } = buildDispatcher({
      execute: async () => ({ content: "ok", details: { echoed: "ok" }, isError: false }),
    });
    const resolved = registry.resolve("echo_value")!;

    expect(
      validateToolExecutionResult(
        { content: "safe", details: { echoed: "hello" }, isError: false },
        resolved,
      ),
    ).toMatchObject({ content: "safe", isError: false });
    expect(() => validateToolExecutionResult(null, resolved)).toThrow(/result/i);
    expect(() =>
      validateToolExecutionResult(
        { content: 1, details: { echoed: "x" }, isError: false },
        resolved,
      ),
    ).toThrow(/result/i);
    expect(() =>
      validateToolExecutionResult(
        { content: "safe", details: { echoed: 42 }, isError: false },
        resolved,
      ),
    ).toThrow(/output/i);
    expect(() =>
      validateToolExecutionResult(
        { content: "safe", details: { echoed: "hello" }, isError: false },
        resolved,
        { maxModelContentBytes: 100, maxDetailsBytes: 4 },
      ),
    ).toThrow(/details/i);
  });
});
