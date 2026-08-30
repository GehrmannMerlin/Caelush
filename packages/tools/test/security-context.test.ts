import { createRunId, createSessionId, createStepId, createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  assertToolBatchRequest,
  assertToolDispatchRequest,
  assertToolSecurityContext,
  type ToolBatchRequest,
  type ToolDispatchRequest,
  type ToolSecurityContext,
} from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

const context: ToolSecurityContext = {
  permissionProfile: "READ_ONLY",
  approvalPolicy: "DANGEROUS_ONLY",
};

function dispatchRequest(): ToolDispatchRequest {
  return {
    sessionId: createSessionId(),
    runId: createRunId(),
    stepId: createStepId(),
    externalCallId: "call-1",
    toolName: "read_file",
    args: { path: "README.md" },
    environment,
    securityContext: context,
  };
}

function batchRequest(): ToolBatchRequest {
  return {
    sessionId: createSessionId(),
    runId: createRunId(),
    stepId: createStepId(),
    environment,
    securityContext: context,
    items: [{ externalCallId: "call-1", toolName: "read_file", args: { path: "README.md" } }],
  };
}

describe("ToolSecurityContext", () => {
  it.each([
    ["READ_ONLY", "ALWAYS_ASK"],
    ["PROJECT_ACCESS", "DANGEROUS_ONLY"],
    ["FULL_ACCESS", "NEVER_ASK"],
  ] as const)("accepts %s with %s", (permissionProfile, approvalPolicy) => {
    expect(() =>
      assertToolSecurityContext({ permissionProfile, approvalPolicy }),
    ).not.toThrow();
  });

  it.each([
    undefined,
    null,
    [],
    { permissionProfile: "whatever", approvalPolicy: "NEVER_ASK" },
    { permissionProfile: "READ_ONLY" },
    { permissionProfile: "READ_ONLY", approvalPolicy: "NEVER_ASK", extra: true },
  ])("rejects invalid context %j", (value) => {
    expect(() => assertToolSecurityContext(value)).toThrow();
  });

  it("requires the context on dispatch and batch requests", () => {
    expect(() => assertToolDispatchRequest({ ...dispatchRequest(), securityContext: undefined })).toThrow();
    expect(() => assertToolBatchRequest({ ...batchRequest(), securityContext: undefined })).toThrow();
    expect(() => assertToolDispatchRequest(dispatchRequest())).not.toThrow();
    expect(() => assertToolBatchRequest(batchRequest())).not.toThrow();
  });
});
