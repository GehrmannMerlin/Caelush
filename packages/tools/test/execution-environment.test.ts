import { createRunId, createSessionId, createStepId, createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { assertToolDispatchRequest, assertToolExecutionEnvironment } from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
};

describe("ToolExecutionEnvironment", () => {
  it("accepts only schema-valid workspace and runtime references", () => {
    expect(() => assertToolExecutionEnvironment(environment)).not.toThrow();
    expect(() =>
      assertToolExecutionEnvironment({
        ...environment,
        runtime: { ...environment.runtime, mutableService: {} },
      }),
    ).toThrow();
  });

  it("is required by dispatch requests and survives request validation", () => {
    const request = {
      sessionId: createSessionId(),
      runId: createRunId(),
      stepId: createStepId(),
      externalCallId: "call-1",
      toolName: "read_file",
      args: {},
      environment,
      securityContext: { permissionProfile: "READ_ONLY", approvalPolicy: "DANGEROUS_ONLY" },
    };

    expect(() => assertToolDispatchRequest(request)).not.toThrow();
    expect(() => assertToolDispatchRequest({ ...request, environment: undefined })).toThrow();
  });
});
