import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  ToolRegistryBuilder,
  ToolValidationError,
  validateToolArguments,
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
      options: {
        type: "object",
        properties: { retries: { type: "integer", minimum: 0 } },
        required: [],
        additionalProperties: false,
      },
    },
    required: ["cmd"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", additionalProperties: false },
  riskLevel: "LOW",
  requiredCapabilities: [],
  runtimeRequirements: {},
};

const handler: ToolHandler = {
  execute: async () => ({ content: "ok", details: {}, isError: false }),
};

function resolvedTool() {
  const resolved = new ToolRegistryBuilder()
    .register({ definition, handler })
    .build()
    .resolve("exec_command");
  if (resolved === undefined) throw new Error("test Tool was not registered");
  return resolved;
}

describe("validateToolArguments", () => {
  it("normalizes schema-declared numeric strings without mutating the caller", () => {
    const tool = resolvedTool();
    const input = { cmd: "pnpm test", yield_time_ms: "3000", options: { retries: "2" } };

    const normalized = validateToolArguments(tool, input);

    expect(normalized).toEqual({ cmd: "pnpm test", yield_time_ms: 3000, options: { retries: 2 } });
    expect(input).toEqual({ cmd: "pnpm test", yield_time_ms: "3000", options: { retries: "2" } });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.options)).toBe(true);
  });

  it("returns safe validation issues for invalid values and missing fields", () => {
    const tool = resolvedTool();

    expect(() => validateToolArguments(tool, { cmd: "pnpm test", yield_time_ms: "soon" })).toThrow(
      ToolValidationError,
    );
    expect(() => validateToolArguments(tool, { yield_time_ms: 3000 })).toThrow(
      /cmd must be provided/,
    );
    try {
      validateToolArguments(tool, { cmd: "pnpm test", yield_time_ms: "soon" });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolValidationError);
      expect((error as ToolValidationError).message).toContain("yield_time_ms");
      expect((error as ToolValidationError).message).not.toContain("pnpm test");
    }
  });

  it("rejects numeric strings that cannot be represented as safe integers", () => {
    const tool = resolvedTool();

    expect(() =>
      validateToolArguments(tool, {
        cmd: "pnpm test",
        options: { retries: "9007199254740992" },
      }),
    ).toThrow(ToolValidationError);
  });

  it("never guesses missing fields, removes unknown fields, or changes command text", () => {
    const tool = resolvedTool();

    expect(() => validateToolArguments(tool, { cmd: "pnpm test", extra: true })).toThrow(
      /must NOT have additional properties/,
    );
    expect(() => validateToolArguments(tool, { cmd: "pnpm test" })).not.toThrow();
    expect(validateToolArguments(tool, { cmd: "pnpm test" }).cmd).toBe("pnpm test");
  });
});
