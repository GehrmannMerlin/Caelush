import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ToolPreflight,
  ToolRegistryBuilder,
  ToolValidationError,
  type ToolHandler,
} from "../src/index.js";

const definition: ToolDefinition = {
  name: "exec_command",
  description: "Execute a command.",
  inputSchema: {
    type: "object",
    properties: {
      cmd: { type: "string", minLength: 1 },
      yield_time_ms: { type: "integer", minimum: 250, maximum: 30000 },
    },
    required: ["cmd"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", additionalProperties: false },
  riskLevel: "LOW",
  requiredCapabilities: [],
  runtimeRequirements: {},
};

function createPreflight() {
  let executions = 0;
  const handler: ToolHandler = {
    execute: async () => {
      executions += 1;
      return { content: "ok", details: {}, isError: false };
    },
  };
  const registry = new ToolRegistryBuilder().register({ definition, handler }).build();
  return {
    preflight: new ToolPreflight(registry),
    get executions() {
      return executions;
    },
  };
}

describe("ToolPreflight", () => {
  it("returns normalized arguments without invoking a handler", () => {
    const { preflight, executions } = createPreflight();

    const result = preflight.prepare("exec_command", {
      cmd: "pnpm test",
      yield_time_ms: "3000",
    });

    expect(result).toMatchObject({
      kind: "READY",
      args: { cmd: "pnpm test", yield_time_ms: 3000 },
    });
    expect(executions).toBe(0);
  });

  it("returns a model-recoverable validation error without guessing arguments", () => {
    const { preflight } = createPreflight();

    const result = preflight.prepare("exec_command", { yield_time_ms: "3000" });

    expect(result.kind).toBe("INVALID_ARGUMENTS");
    if (result.kind !== "INVALID_ARGUMENTS") throw new Error("expected invalid arguments");
    expect(result.error).toBeInstanceOf(ToolValidationError);
    expect(result.error.message).toContain("cmd must be provided");
  });

  it("reports unknown tools without fabricating a registration", () => {
    const { preflight } = createPreflight();

    expect(preflight.prepare("missing_tool", {})).toEqual({
      kind: "UNAVAILABLE_TOOL",
      toolName: "missing_tool",
    });
  });
});
