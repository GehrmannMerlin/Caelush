import type { JsonObject } from "@caelush/ai";
import { describe, expect, it } from "vitest";
import {
  DefaultAgentToolRegistryBuilder,
  createToolCallPreparer,
  type AgentTool,
} from "@caelush/agent";

/**
 * The independent-use proof for the general Agent Tool framework.
 *
 * ```text
 * import only @caelush/agent's public API
 *   → register a pure in-memory echo AgentTool
 *   → build the registry
 *   → project modelSpecs()
 *   → prepare a call with ToolCallPreparer
 * ```
 *
 * No Coding Agent, no Runtime, no Storage implementation, no SQLite, no daemon and no provider.
 * What it proves is that registering and preparing Tools is a capability of the kernel by itself.
 *
 * What it does **not** prove, and must not be reported as proving: a durable Tool execution
 * pipeline. There is no Invocation, no admission, no approval, no executor and no settlement in this
 * round — those are Phases 4B to 4D, and the Tool System V2 pipeline is not complete without them.
 */

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo the supplied text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  },
  label: "Echo",
  resultDetailsSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  executionMode: "SEQUENTIAL",
  execute: async ({ args }) => ({
    content: String(args.text),
    details: { echoed: String(args.text) },
    isError: false,
  }),
};

describe("independent use of the general Agent Tool framework", () => {
  it("registers, projects and prepares an in-memory Tool with @caelush/agent alone", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const registry = builder.build();

    expect(registry.size).toBe(1);
    expect(registry.names()).toEqual(["echo"]);

    // The model-facing projection is exactly the AI tool spec.
    const specs = registry.modelSpecs();
    expect(specs).toEqual([
      {
        name: "echo",
        description: "Echo the supplied text.",
        inputSchema: echoTool.inputSchema,
      },
    ]);

    // And preparation resolves, bounds and validates against the same registry.
    const preparer = createToolCallPreparer(registry);
    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "echo",
      args: { text: "hello" },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    expect(outcome.call.args).toEqual({ text: "hello" });
    expect(outcome.call.resolved.tool.label).toBe("Echo");
  });

  it("executes the in-memory Tool directly, with no pipeline around it", async () => {
    // `AgentTool.execute` is callable on its own: a host that has not yet composed the durable
    // pipeline can still run a Tool, which is what makes the contract independently usable.
    const result = await echoTool.execute({
      identity: {
        runId: "run-1" as never,
        sessionId: "session-1" as never,
        sourceStepId: "step-1" as never,
        invocationId: "invocation-1" as never,
        externalCallId: "call-1",
      },
      args: { text: "hello" },
      environment: {
        workspace: { id: "workspace-1" as never, path: "/workspace" },
        runtime: { id: "local", kind: "local" },
      },
      signal: new AbortController().signal,
      updates: { publish: () => undefined },
    });

    expect(result).toEqual({ content: "hello", details: { echoed: "hello" }, isError: false });
  });

  it("keeps a generic Tool free of every Coding field", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const spec = builder.build().modelSpecs()[0]!;

    for (const codingField of [
      "riskLevel",
      "requiredCapabilities",
      "runtimeRequirements",
      "securityFactsProjector",
      "effectProjector",
      "presentation",
      "promptSnippet",
      "operations",
    ]) {
      expect(spec, `a generic AgentTool must not carry ${codingField}`).not.toHaveProperty(
        codingField,
      );
    }
    expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("declares an execution mode without enabling concurrency", () => {
    // `PARALLEL_SAFE` is a declared future capability. Registering one changes nothing about how the
    // pipeline runs it, because this round has one execution order.
    const parallelSafe: AgentTool = {
      ...echoTool,
      name: "echo_parallel",
      executionMode: "PARALLEL_SAFE",
    };
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    builder.register(parallelSafe);
    const registry = builder.build();

    expect(registry.resolve("echo_parallel")?.tool.executionMode).toBe("PARALLEL_SAFE");
    expect(registry.names()).toEqual(["echo", "echo_parallel"]);
    // Nothing the registry exposes turns that declaration into a scheduler: there is no batch port,
    // no concurrency knob and no execution entry point on the canonical registry.
    for (const schedulerish of ["execute", "dispatch", "batch", "concurrency", "parallel"]) {
      expect(registry).not.toHaveProperty(schedulerish);
    }
  });

  it("rejects an argument payload that does not match the registered schema", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const preparer = createToolCallPreparer(builder.build());

    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "echo",
      args: {} as JsonObject,
    });

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.disposition).toBe("SAFE_FAILURE");
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
  });
});
