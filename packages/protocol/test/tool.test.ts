import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const api = protocol as Record<string, unknown>;
type SchemaLike = {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
};

function getSchema(name: string): SchemaLike | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as SchemaLike;
}

function getFactory(name: string): (() => string) | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "function") {
    return undefined;
  }

  return value as () => string;
}

describe("protocol tool contracts", () => {
  it("parses a data-only ToolDefinition and ToolInvocation", () => {
    const definitionSchema = getSchema("ToolDefinitionSchema");
    const invocationSchema = getSchema("ToolInvocationSchema");
    const createRunId = getFactory("createRunId");
    const createStepId = getFactory("createStepId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      definitionSchema === undefined ||
      invocationSchema === undefined ||
      createRunId === undefined ||
      createStepId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    const runId = createRunId();
    const stepId = createStepId();
    const invocationId = createToolInvocationId();
    const definition = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      outputSchema: { type: "object" },
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { kind: "local" },
    };
    const invocation = {
      id: invocationId,
      runId,
      stepId,
      toolName: definition.name,
      args: { path: "README.md" },
      riskLevel: "LOW",
      status: "REQUESTED",
      createdAt: 1_700_000_000_000,
    };

    expect(definitionSchema.parse(definition)).toEqual(definition);
    expect(invocationSchema.parse(invocation)).toEqual(invocation);
  });

  it("rejects executable fields, invalid names, and non-object arguments", () => {
    const definitionSchema = getSchema("ToolDefinitionSchema");
    const invocationSchema = getSchema("ToolInvocationSchema");
    const createRunId = getFactory("createRunId");
    const createStepId = getFactory("createStepId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      definitionSchema === undefined ||
      invocationSchema === undefined ||
      createRunId === undefined ||
      createStepId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    expect(
      definitionSchema.safeParse({
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        riskLevel: "LOW",
        requiredCapabilities: ["FS_READ"],
        runtimeRequirements: { kind: "local" },
        execute: () => "must not be protocol data",
      }).success,
    ).toBe(false);
    expect(
      definitionSchema.safeParse({
        name: "Read File",
        description: "Read a file",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        riskLevel: "LOW",
        requiredCapabilities: ["FS_READ"],
        runtimeRequirements: { kind: "local" },
      }).success,
    ).toBe(false);

    expect(
      invocationSchema.safeParse({
        id: createToolInvocationId(),
        runId: createRunId(),
        stepId: createStepId(),
        toolName: "read_file",
        args: ["README.md"],
        riskLevel: "LOW",
        status: "REQUESTED",
        createdAt: 1_700_000_000_000,
      }).success,
    ).toBe(false);
  });
});
