import type { JsonObject } from "@caelush/ai";
import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolInvocation,
  type ToolInvocationId,
  type ToolName,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createToolCallPreparer,
  createToolInvocationExecutor,
  DefaultAgentToolRegistryBuilder,
  DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER,
  ToolExecutionInfrastructureError,
  ToolExecutionUncertainError,
  UNCERTAIN_SIDE_EFFECT,
  type AgentTool,
  type AgentToolRegistry,
  type PreparedToolCall,
  type ToolExecutionIdentity,
  type ToolExecutionUpdate,
  type ToolExecutionUpdateSanitizerPort,
  type TransientToolUpdateDiagnostics,
} from "@caelush/agent";

/**
 * The canonical Tool invocation executor.
 *
 * ```text
 * durable RUNNING already committed (the caller's job, not this layer's)
 *   ↓  executor.execute({ call, identity, environment, signal })
 *   ↓  AgentTool.execute(...)
 *   ↓  raw AgentToolResult, or a classified execution failure
 * ```
 *
 * The tests below are grouped around what the executor is responsible for and, just as importantly,
 * what it must never do: create durable state, reach a host service, or let a late update out.
 */

const inputSchema: JsonObject = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const resultSchema: JsonObject = {
  type: "object",
  properties: { echoed: { type: "string" } },
  required: ["echoed"],
  additionalProperties: false,
};

const environment = {
  workspace: { id: createWorkspaceId(), path: "/workspace" },
  runtime: { id: "local", kind: "local" as const },
};

function agentTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "echo",
    description: "Echo text.",
    inputSchema,
    label: "Echo",
    resultDetailsSchema: resultSchema,
    executionMode: "SEQUENTIAL",
    execute: async ({ args }) => ({
      content: String(args.text),
      details: { echoed: String(args.text) },
      isError: false,
    }),
    ...overrides,
  };
}

function registryWith(tool: AgentTool): AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  builder.register(tool);
  return builder.build();
}

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName: "echo" as ToolName,
    externalCallId: "call-1",
    args: { text: "hello" },
    riskLevel: "LOW",
    status: "RUNNING",
    createdAt: createTimestampMs(1),
    ...overrides,
  };
}

function identityFor(
  bound: ToolInvocation,
  invocationId?: ToolInvocationId,
): ToolExecutionIdentity {
  return {
    runId: bound.runId,
    sessionId: createSessionId(),
    sourceStepId: bound.stepId,
    invocationId: invocationId ?? bound.id,
    externalCallId: bound.externalCallId ?? "call-1",
  };
}

function preparedCall(
  registry: AgentToolRegistry,
  args: JsonObject = { text: "hello" },
): PreparedToolCall {
  const outcome = createToolCallPreparer(registry).prepare({
    externalCallId: "call-1",
    toolName: "echo",
    args,
  });
  if (outcome.kind !== "READY") throw new Error("the fixture Tool did not prepare");
  return outcome.call;
}

/** A sanitizer that returns each update unchanged, so delivery can be observed. */
const PASSTHROUGH_UPDATES: ToolExecutionUpdateSanitizerPort = Object.freeze({
  sanitize: ({ update }: { update: ToolExecutionUpdate }) => update,
});

describe("ToolInvocationExecutor", () => {
  it("executes the prepared call's canonical AgentTool with the exact inputs", async () => {
    const seen: {
      identity?: ToolExecutionIdentity;
      args?: JsonObject;
      environment?: unknown;
      signal?: AbortSignal;
      hasSink?: boolean;
    } = {};
    const signal = new AbortController().signal;
    const registry = registryWith(
      agentTool({
        execute: async (input) => {
          seen.identity = input.identity;
          seen.args = input.args;
          seen.environment = input.environment;
          seen.signal = input.signal;
          seen.hasSink = typeof input.updates?.publish === "function";
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const identity = identityFor(bound);
    const executor = createToolInvocationExecutor({ invocation: bound });

    const result = await executor.execute({
      call: preparedCall(registry),
      identity,
      environment,
      signal,
    });

    expect(result).toEqual({ content: "ok", details: { echoed: "ok" }, isError: false });
    expect(seen.identity).toEqual(identity);
    expect(seen.args).toEqual({ text: "hello" });
    expect(seen.environment).toEqual(environment);
    expect(seen.signal).toBe(signal);
    expect(seen.hasSink).toBe(true);
  });

  it("returns an isError result as a result instead of throwing", async () => {
    const registry = registryWith(
      agentTool({
        execute: async () => ({
          content: "FILE_NOT_FOUND",
          details: { echoed: "FILE_NOT_FOUND" },
          isError: true,
        }),
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({ invocation: bound });

    const result = await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("FILE_NOT_FOUND");
  });

  it("maps an unexpected throw to an EXECUTION infrastructure failure", async () => {
    const registry = registryWith(
      agentTool({
        execute: async () => {
          throw new TypeError("cannot read properties of undefined at C:\\host\\tool.ts:9");
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({ invocation: bound });

    let thrown: unknown;
    try {
      await executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolExecutionInfrastructureError);
    expect((thrown as ToolExecutionInfrastructureError).phase).toBe("EXECUTION");
    // The host path and the raw message never surface.
    expect((thrown as Error).message).not.toContain("C:\\host\\tool.ts");
  });

  it("maps a synchronous throw to an EXECUTION infrastructure failure", async () => {
    const registry = registryWith(
      agentTool({
        execute: (() => {
          throw new Error("synchronous bug");
        }) as unknown as AgentTool["execute"],
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({ invocation: bound });

    await expect(
      executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolExecutionInfrastructureError);
  });

  it("preserves the uncertain-side-effect semantics without converting them to a result", async () => {
    const registry = registryWith(
      agentTool({
        execute: async () => {
          throw new ToolExecutionUncertainError();
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({ invocation: bound });

    let thrown: unknown;
    try {
      await executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolExecutionUncertainError);
    expect((thrown as ToolExecutionUncertainError).executionDisposition).toBe(
      UNCERTAIN_SIDE_EFFECT,
    );
    expect(thrown).not.toBeInstanceOf(ToolExecutionInfrastructureError);
  });

  it("recognizes a legacy uncertain error by its disposition, not by its message", async () => {
    const legacyShaped = Object.assign(new Error("patched state unknown"), {
      executionDisposition: UNCERTAIN_SIDE_EFFECT,
    });
    const registry = registryWith(
      agentTool({
        execute: async () => {
          throw legacyShaped;
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({ invocation: bound });

    await expect(
      executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolExecutionUncertainError);
  });

  it("fails the identity check before any Tool code runs", async () => {
    const execute = vi.fn(async () => ({
      content: "ok",
      details: { echoed: "ok" },
      isError: false,
    }));
    const registry = registryWith(agentTool({ execute }));
    const bound = invocation();
    const executor = createToolInvocationExecutor({ invocation: bound });

    for (const identity of [
      identityFor(bound, createToolInvocationId()),
      { ...identityFor(bound), runId: createRunId() },
      { ...identityFor(bound), sourceStepId: createStepId() },
      { ...identityFor(bound), externalCallId: "a-different-call" },
    ]) {
      await expect(
        executor.execute({
          call: preparedCall(registry),
          identity,
          environment,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(ToolExecutionInfrastructureError);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("ToolInvocationExecutor transient updates", () => {
  it("sanitizes each update before the consumer sees it", async () => {
    const delivered: ToolExecutionUpdate[] = [];
    const sanitized = vi.fn(({ update }: { update: ToolExecutionUpdate }) => {
      if (update.kind === "OUTPUT") return { ...update, chunk: "REDACTED" } as ToolExecutionUpdate;
      return update;
    });
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "secret" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: { sanitize: sanitized },
      transientUpdates: {
        publish: ({ update }) => {
          delivered.push(update);
        },
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(sanitized).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([{ kind: "OUTPUT", stream: "stdout", chunk: "REDACTED" }]);
  });

  it("drops an update the sanitizer rejects, and the raw one never reaches the consumer", async () => {
    const delivered: ToolExecutionUpdate[] = [];
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "raw-secret" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: { sanitize: () => null },
      transientUpdates: {
        publish: ({ update }) => {
          delivered.push(update);
        },
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(delivered).toEqual([]);
  });

  it("drops the update when the sanitizer throws, without cancelling the Tool", async () => {
    const delivered: ToolExecutionUpdate[] = [];
    const drops: string[] = [];
    let toolFinished = false;
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "STATUS", message: "unsafe" });
          toolFinished = true;
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const diagnostics: TransientToolUpdateDiagnostics = {
      onUpdateDropped: ({ reason }) => drops.push(reason),
      onDeliveryFailed: () => undefined,
    };
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: {
        sanitize: () => {
          throw new Error("sanitizer infrastructure failure");
        },
      },
      transientUpdates: {
        publish: ({ update }) => {
          delivered.push(update);
        },
      },
      diagnostics,
    });

    const result = await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(toolFinished).toBe(true);
    expect(delivered).toEqual([]);
    expect(drops).toEqual(["SANITIZER_FAILED"]);
  });

  it("drops every update when no sanitizer is configured", async () => {
    const delivered: ToolExecutionUpdate[] = [];
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "PROGRESS", message: "half" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      transientUpdates: {
        publish: ({ update }) => {
          delivered.push(update);
        },
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(delivered).toEqual([]);
  });

  it("delivers multiple updates in the order they were accepted", async () => {
    const delivered: string[] = [];
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "first" });
          updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "second" });
          updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "third" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: async ({ update }) => {
          // A slow, deliberately out-of-order-looking consumer.
          await new Promise((resolve) =>
            setTimeout(resolve, update.kind === "OUTPUT" && update.chunk === "first" ? 5 : 0),
          );
          if (update.kind === "OUTPUT") delivered.push(update.chunk);
        },
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(delivered).toEqual(["first", "second", "third"]);
  });

  it("does not make the Tool wait for a slow consumer", async () => {
    let publishReturned = false;
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "STATUS", message: "slow" });
          publishReturned = true;
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    expect(publishReturned).toBe(true);
  });

  it("drains accepted updates before resolving the execution result", async () => {
    const order: string[] = [];
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "OUTPUT", stream: "stdout", chunk: "before-return" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push("update-delivered");
        },
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });
    order.push("executor-returned");

    // The terminal lifecycle the caller writes next can never be overtaken by an accepted update.
    expect(order).toEqual(["update-delivered", "executor-returned"]);
  });

  it("drains accepted updates before throwing an execution failure", async () => {
    const order: string[] = [];
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "STATUS", message: "then it fails" });
          throw new TypeError("boom");
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push("update-delivered");
        },
      },
    });

    await expect(
      executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolExecutionInfrastructureError);

    expect(order).toEqual(["update-delivered"]);
  });

  it("silently ignores an update published after the Tool promise settled", async () => {
    const delivered: ToolExecutionUpdate[] = [];
    const drops: string[] = [];
    let orphanSink: { publish(update: ToolExecutionUpdate): void } | undefined;
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          orphanSink = updates;
          updates.publish({ kind: "STATUS", message: "on time" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: ({ update }) => {
          delivered.push(update);
        },
      },
      diagnostics: {
        onUpdateDropped: ({ reason }) => drops.push(reason),
        onDeliveryFailed: () => undefined,
      },
    });

    await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    // A late callback from a finished invocation is an orphan, not an event.
    orphanSink?.publish({ kind: "STATUS", message: "too late" });

    expect(delivered).toHaveLength(1);
    expect(drops).toEqual(["ORPHAN"]);
  });

  it("silently ignores an update published after a rejected Tool promise", async () => {
    const delivered: ToolExecutionUpdate[] = [];
    let orphanSink: { publish(update: ToolExecutionUpdate): void } | undefined;
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          orphanSink = updates;
          throw new TypeError("boom");
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: ({ update }) => {
          delivered.push(update);
        },
      },
    });

    await expect(
      executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolExecutionInfrastructureError);

    orphanSink?.publish({ kind: "STATUS", message: "too late" });
    expect(delivered).toEqual([]);
  });

  it("keeps working when the transient consumer rejects", async () => {
    const deliveryFailures: unknown[] = [];
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "STATUS", message: "first" });
          updates.publish({ kind: "STATUS", message: "second" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: {
        publish: () => Promise.reject(new Error("transport down")),
      },
      diagnostics: {
        onUpdateDropped: () => undefined,
        onDeliveryFailed: ({ cause }) => deliveryFailures.push(cause),
      },
    });

    const result = await executor.execute({
      call: preparedCall(registry),
      identity: identityFor(bound),
      environment,
      signal: new AbortController().signal,
    });

    // A transient consumer failure is observational: the Tool result is unaffected.
    expect(result.isError).toBe(false);
    expect(deliveryFailures).toHaveLength(2);
  });

  it("uses the discarding consumer when none is configured", async () => {
    const registry = registryWith(
      agentTool({
        execute: async ({ updates }) => {
          updates.publish({ kind: "STATUS", message: "nowhere" });
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    const bound = invocation();
    const executor = createToolInvocationExecutor({
      invocation: bound,
      updateSanitizer: PASSTHROUGH_UPDATES,
      transientUpdates: DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER,
    });

    await expect(
      executor.execute({
        call: preparedCall(registry),
        identity: identityFor(bound),
        environment,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ isError: false });
  });
});
