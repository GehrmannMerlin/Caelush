import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentState,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createToolSecurityContext } from "../src/run-controller.js";

const run = AgentRunSchema.parse({
  id: createRunId(),
  sessionId: createSessionId(),
  goal: "security context",
  status: "RUNNING",
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  model: { provider: "fixture", model: "fixture-model" },
  runtime: { id: "local", kind: "fixture" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 1000 },
  createdAt: createTimestampMs(1),
  startedAt: createTimestampMs(2),
});

const state = {
  permissionProfile: run.permissionProfile,
  approvalPolicy: run.approvalPolicy,
} as AgentState;

describe("RunController security authority", () => {
  it("derives ToolSecurityContext from the durable Run policy", () => {
    expect(createToolSecurityContext(run, state)).toEqual({
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
    });
  });

  it("fails closed when AgentState policy disagrees with the Run", () => {
    expect(() =>
      createToolSecurityContext(run, {
        ...state,
        permissionProfile: "READ_ONLY",
      }),
    ).toThrow("security policy does not match");
  });
});
