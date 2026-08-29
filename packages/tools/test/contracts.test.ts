import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
  type ToolDefinition,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolHandler,
  ToolRegistration,
} from "../src/index.js";

const definition: ToolDefinition = {
  name: "echo_value",
  description: "Return the supplied value.",
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
};

describe("tool runtime contracts", () => {
  it("keeps execution requests JSON-safe and runtime-independent", () => {
    const request: ToolExecutionRequest = {
      runId: createRunId(),
      stepId: createStepId(),
      invocationId: createToolInvocationId(),
      externalCallId: "external-1",
      args: { value: "hello" },
      environment: {
        workspace: { id: createWorkspaceId(), path: "C:/workspace" },
        runtime: { id: "local", kind: "local" },
      },
    };

    expect(request.args).toEqual({ value: "hello" });
  });

  it("separates model content from structured details and error state", () => {
    const result: ToolExecutionResult = {
      content: "hello",
      details: { echoed: "hello" },
      isError: false,
    };

    expect(result).toEqual({ content: "hello", details: { echoed: "hello" }, isError: false });
  });

  it("binds one definition and one handler in a single registration", () => {
    const handler: ToolHandler = {
      async execute() {
        return { content: "unused", details: {}, isError: false };
      },
    };
    const registration: ToolRegistration = { definition, handler };

    expect(registration.definition.name).toBe("echo_value");
    expect(registration.handler).toBe(handler);
  });
});
