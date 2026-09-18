import type { JsonObject } from "@caelush/ai";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES,
  DEFAULT_MAX_INVOCATION_ARGS_BYTES,
  DefaultAgentToolRegistryBuilder,
  ToolArgumentPreparationError,
  ToolPreparationInfrastructureError,
  createToolCallPreparer,
  type AgentTool,
  type ToolCallPreparer,
} from "@caelush/agent";

/**
 * The canonical Tool-call Preparer.
 *
 * ```text
 * validate the call boundary -> resolve -> bound raw args -> copy
 *   -> optional prepareArguments -> bound prepared args -> strict schema validation -> READY
 * ```
 *
 * The tests below are organised around the four properties that make preparation trustworthy:
 * it resolves the one registry, it never guesses, it bounds both payloads, and it creates nothing.
 */

const inputSchema: JsonObject = {
  type: "object",
  properties: {
    text: { type: "string" },
    yield_time_ms: { type: "integer", minimum: 250, maximum: 30000 },
  },
  required: ["text"],
  additionalProperties: false,
};

function buildRegistry(tool: Partial<AgentTool> = {}, extra: readonly AgentTool[] = []) {
  const builder = new DefaultAgentToolRegistryBuilder();
  builder.register({
    name: "exec_command",
    description: "Execute a command.",
    inputSchema,
    label: "Exec Command",
    resultDetailsSchema: { type: "object", additionalProperties: false },
    executionMode: "SEQUENTIAL",
    execute: async () => ({ content: "ok", details: {}, isError: false }),
    ...tool,
  });
  for (const other of extra) builder.register(other);
  return builder.build();
}

function request(args: JsonObject): {
  readonly externalCallId: string;
  readonly toolName: "exec_command";
  readonly args: JsonObject;
} {
  return { externalCallId: "call-1", toolName: "exec_command", args };
}

describe("ToolCallPreparer", () => {
  it("returns READY with prepared, frozen arguments and no execution", () => {
    let executions = 0;
    const registry = buildRegistry({
      execute: async () => {
        executions += 1;
        return { content: "ok", details: {}, isError: false };
      },
    });
    const preparer = createToolCallPreparer(registry);

    const outcome = preparer.prepare(request({ text: "hello" }));

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    expect(outcome.call.args).toEqual({ text: "hello" });
    expect(outcome.call.request.externalCallId).toBe("call-1");
    expect(outcome.call.resolved.tool.name).toBe("exec_command");
    expect(Object.isFrozen(outcome.call.args)).toBe(true);
    expect(executions).toBe(0);
  });

  it("rejects an unknown Tool without fabricating a resolution", () => {
    const preparer = createToolCallPreparer(buildRegistry());

    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "missing_tool",
      args: {},
    });

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.code).toBe("TOOL_UNAVAILABLE");
    expect(outcome.feedback.disposition).toBe("SAFE_FAILURE");
    expect(outcome.feedback.content).toContain("missing_tool");
    expect(outcome.request.toolName).toBe("missing_tool");
  });

  it("validates strictly when the Tool declares no preparation hook", () => {
    const preparer = createToolCallPreparer(buildRegistry());

    const numericString = preparer.prepare(request({ text: "x", yield_time_ms: "3000" }));
    expect(numericString.kind).toBe("REJECTED");
    if (numericString.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(numericString.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
  });

  it("validates the prepared value when the Tool declares a hook", () => {
    const registry = buildRegistry({
      prepareArguments: (raw: Readonly<JsonObject>) => {
        const args = { ...raw } as { text: string; yield_time_ms?: number };
        if (typeof args.yield_time_ms === "string") {
          args.yield_time_ms = Number(args.yield_time_ms);
        }
        return args;
      },
    });
    const preparer = createToolCallPreparer(registry);

    const outcome = preparer.prepare(request({ text: "x", yield_time_ms: "3000" }));

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    expect(outcome.call.args).toEqual({ text: "x", yield_time_ms: 3000 });
  });

  it("still rejects what the hook did not fix", () => {
    const registry = buildRegistry({
      prepareArguments: (raw: Readonly<JsonObject>) => raw,
    });
    const preparer = createToolCallPreparer(registry);

    const outcome = preparer.prepare(request({ yield_time_ms: 3000 }));

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
    expect(JSON.stringify(outcome.feedback.details)).toContain("text");
  });

  it("reports a preparation failure the Tool author declared safe", () => {
    const registry = buildRegistry({
      prepareArguments: () => {
        throw new ToolArgumentPreparationError({
          code: "TEXT_UNSUPPORTED",
          content: 'Parameter "text" cannot be normalized. Send a plain string.',
          details: {},
          disposition: "SAFE_FAILURE",
        });
      },
    });
    const preparer = createToolCallPreparer(registry);

    const outcome = preparer.prepare(request({ text: "x" }));

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.code).toBe("TEXT_UNSUPPORTED");
    expect(outcome.feedback.content).toContain("plain string");
  });

  it("turns any other preparation throw into an infrastructure failure", () => {
    const registry = buildRegistry({
      prepareArguments: () => {
        throw new TypeError("undefined is not a function at C:\\host\\path.ts:12");
      },
    });
    const preparer = createToolCallPreparer(registry);

    expect(() => preparer.prepare(request({ text: "x" }))).toThrowError(
      ToolPreparationInfrastructureError,
    );
    try {
      preparer.prepare(request({ text: "x" }));
    } catch (error) {
      // The host keeps the cause; the model-facing surface never sees the raw text.
      expect(error).toBeInstanceOf(ToolPreparationInfrastructureError);
      expect((error as ToolPreparationInfrastructureError).phase).toBe("PREPARATION");
      expect((error as Error).message).not.toContain("C:\\host\\path.ts");
    }
  });

  it("treats a non-object preparation result as an infrastructure failure", () => {
    const registry = buildRegistry({
      prepareArguments: (() => "not an object") as unknown as AgentTool["prepareArguments"],
    });
    const preparer = createToolCallPreparer(registry);

    expect(() => preparer.prepare(request({ text: "x" }))).toThrowError(
      ToolPreparationInfrastructureError,
    );
  });

  it("treats a promise-returning preparation hook as an infrastructure failure", () => {
    // `isJsonObject` refuses a thenable on purpose: a hook written as `async` hands back a promise,
    // and passing it to schema validation would report a confusing field error instead of the
    // contract violation it is.
    const registry = buildRegistry({
      prepareArguments: (async (raw: Readonly<JsonObject>) =>
        raw) as unknown as AgentTool["prepareArguments"],
    });
    const preparer = createToolCallPreparer(registry);

    let thrown: unknown;
    try {
      preparer.prepare(request({ text: "x" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolPreparationInfrastructureError);
    expect((thrown as ToolPreparationInfrastructureError).phase).toBe("PREPARATION");
  });

  it("refuses an oversized raw payload before any hook runs", () => {
    const hook = vi.fn((raw: Readonly<JsonObject>) => raw as { text: string });
    const registry = buildRegistry({ prepareArguments: hook });
    const preparer = createToolCallPreparer(registry, { maxInvocationArgsBytes: 64 });

    const outcome = preparer.prepare(request({ text: "x".repeat(200) }));

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENTS_TOO_LARGE");
    expect(hook).not.toHaveBeenCalled();
  });

  it("refuses a payload a hook enlarged past the bound", () => {
    const registry = buildRegistry({
      prepareArguments: (raw: Readonly<JsonObject>) => ({
        text: `${String(raw.text)}${"y".repeat(400)}`,
      }),
    });
    const preparer = createToolCallPreparer(registry, { maxInvocationArgsBytes: 256 });

    const outcome = preparer.prepare(request({ text: "small" }));

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENTS_TOO_LARGE");
  });

  it("never mutates the caller's arguments and never rewrites the call identity", () => {
    const raw: JsonObject = { text: "hello" };
    const registry = buildRegistry({
      prepareArguments: (value: Readonly<JsonObject>) => {
        (value as { text: string }).text = "mutated";
        return value as { text: string };
      },
    });
    const preparer = createToolCallPreparer(registry);

    const outcome = preparer.prepare({
      externalCallId: "call-9",
      toolName: "exec_command",
      args: raw,
    });

    expect(raw).toEqual({ text: "hello" });
    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    expect(outcome.call.args).toEqual({ text: "mutated" });
    expect(outcome.call.request.externalCallId).toBe("call-9");
  });

  it("fails the call boundary as infrastructure, not as model feedback", () => {
    const preparer = createToolCallPreparer(buildRegistry());

    expect(() =>
      preparer.prepare({ externalCallId: "call-1", toolName: "exec_command", args: [] as never }),
    ).toThrowError(ToolPreparationInfrastructureError);
    expect(() =>
      preparer.prepare({ externalCallId: "", toolName: "exec_command", args: {} }),
    ).toThrowError(ToolPreparationInfrastructureError);
    expect(() =>
      preparer.prepare({
        externalCallId: "x".repeat(DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES + 1),
        toolName: "exec_command",
        args: {},
      }),
    ).toThrowError(ToolPreparationInfrastructureError);
  });

  it("uses the frozen argument bound by default", () => {
    const preparer = createToolCallPreparer(buildRegistry());
    const withinBound = preparer.prepare(
      request({ text: "x".repeat(DEFAULT_MAX_INVOCATION_ARGS_BYTES - 32) }),
    );

    expect(withinBound.kind).toBe("READY");
  });
});

describe("ToolCallPreparer side-effect freedom", () => {
  it("creates nothing durable and touches no host service", () => {
    const registry = buildRegistry();
    const preparer: ToolCallPreparer = createToolCallPreparer(registry);

    // The Preparer is a value built from a registry and two integers: a host service cannot be
    // reached through it, and `prepare` is synchronous by contract, so there is no suspension point
    // at which one could be awaited either.
    expect(Object.keys(preparer)).toEqual(["prepare"]);
    const outcome = preparer.prepare(request({ text: "x" }));
    expect(outcome).not.toBeInstanceOf(Promise);
  });

  it("returns only a call or a feedback, never a durable-shaped record", () => {
    const registry = buildRegistry();
    const preparer = createToolCallPreparer(registry);

    const ready = preparer.prepare(request({ text: "x" }));
    expect(ready.kind).toBe("READY");
    expect(Object.keys(ready).sort()).toEqual(["call", "kind"]);
    if (ready.kind === "READY") {
      expect(Object.keys(ready.call).sort()).toEqual(["args", "request", "resolved"]);
      expect(ready.call).not.toHaveProperty("invocationId");
    }

    const rejected = preparer.prepare({ externalCallId: "c", toolName: "missing_tool", args: {} });
    expect(Object.keys(rejected).sort()).toEqual(["feedback", "kind", "request"]);
    if (rejected.kind === "REJECTED") {
      // Safe, bounded and actionable — and carrying no identifier for a call that never became one.
      expect(rejected.feedback).not.toHaveProperty("invocationId");
      expect(rejected.feedback).not.toHaveProperty("observationId");
      expect(Object.keys(rejected.feedback).sort()).toEqual([
        "code",
        "content",
        "details",
        "disposition",
      ]);
    }
  });

  it("keeps the frozen phase-3 Tool turn contract structurally unchanged", async () => {
    const toolTurn = await import("@caelush/agent");
    // The Phase 3 model-visible result still has exactly its four frozen fields, and the Tool
    // System's execution result is published under its own alias rather than merged into it.
    const modelVisible: import("@caelush/agent").AgentToolResult = {
      externalCallId: "call-1",
      toolName: "exec_command",
      content: "ok",
      isError: false,
    };
    const execution: import("@caelush/agent").AgentToolExecutionResult = {
      content: "ok",
      details: {},
      isError: false,
    };
    expect(Object.keys(modelVisible).sort()).toEqual([
      "content",
      "externalCallId",
      "isError",
      "toolName",
    ]);
    expect(Object.keys(execution).sort()).toEqual(["content", "details", "isError"]);
    expect(toolTurn.TOOL_TURN_RESULT_KINDS).toEqual([
      "COMPLETED",
      "WAITING_APPROVAL",
      "BUDGET_EXCEEDED",
      "RESOURCE_WAIT",
      "REPLAN",
    ]);
    expect(toolTurn.TOOL_TURN_RESULT_KINDS).toHaveLength(5);
  });
});
