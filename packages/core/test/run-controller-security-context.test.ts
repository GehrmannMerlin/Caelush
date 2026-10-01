import {
  AgentRunSchema,
  computeSecurityPolicyDigest,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentState,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createToolSecurityContext } from "../src/tool-security-context.js";

const run = AgentRunSchema.parse({
  id: createRunId(),
  sessionId: createSessionId(),
  goal: "security context",
  status: "RUNNING",
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  model: { provider: "fixture", model: "fixture-model" },
  runtime: { id: "local", kind: "fixture" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "ON_BOUNDARY",
  limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 1000 },
  createdAt: createTimestampMs(1),
  startedAt: createTimestampMs(2),
  securityPolicy: (() => {
    const policy = {
      schemaVersion: 1 as const,
      preset: { id: "WORKSPACE_WRITE" as const, version: 1 },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "ON_BOUNDARY" as const,
      filesystemBoundary: "WORKSPACE_READ_WRITE" as const,
      processBoundary: "WORKSPACE_WRITE" as const,
      requiredEnforcement: "OS_RESTRICTED" as const,
      hardSafetyPolicyVersion: "hard-safety@1",
      commandPolicyVersion: "command-policy@1",
      secretPolicyVersion: "secret-policy@1",
      createdAt: new Date(1).toISOString(),
    };
    return { ...policy, policyDigest: computeSecurityPolicyDigest(policy) };
  })(),
});

const state = {
  permissionProfile: run.permissionProfile,
  approvalPolicy: run.approvalPolicy,
} as AgentState;

describe("RunController security authority", () => {
  it("derives ToolSecurityContext from the durable Run policy", () => {
    expect(createToolSecurityContext(run, state)).toEqual({
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
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
