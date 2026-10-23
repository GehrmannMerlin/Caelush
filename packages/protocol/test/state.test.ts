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

describe("protocol AgentState projection", () => {
  it("parses a bounded, serializable current Run projection", () => {
    const stateSchema = getSchema("AgentStateSchema");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    const createWorkspaceId = getFactory("createWorkspaceId");
    if (
      stateSchema === undefined ||
      createRunId === undefined ||
      createSessionId === undefined ||
      createWorkspaceId === undefined
    ) {
      return;
    }

    const timestamp = 1_700_000_000_000;
    const state = {
      runId: createRunId(),
      sessionId: createSessionId(),
      goal: "verify the project",
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: "D:/workspace" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      plan: [],
      recentObservations: [],
      changedFiles: [{ path: "README.md", changeType: "MODIFIED" }],
      activeProcesses: [{ id: "proc-1", command: "pnpm test", status: "RUNNING" }],
      errors: [],
      verification: "NOT_RUN",
      usage: { steps: 1, toolCalls: 0, inputTokens: 12, outputTokens: 24 },
      startedAt: timestamp,
      updatedAt: timestamp,
    };

    expect(stateSchema.parse(state)).toEqual(state);
    expect(stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(state).not.toHaveProperty("modelOutputRecovery");
  });

  it("round-trips the bounded model output recovery reservation states", () => {
    const stateSchema = getSchema("AgentStateSchema");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    const createWorkspaceId = getFactory("createWorkspaceId");
    const createStepId = getFactory("createStepId");
    if (
      stateSchema === undefined ||
      createRunId === undefined ||
      createSessionId === undefined ||
      createWorkspaceId === undefined ||
      createStepId === undefined
    ) {
      return;
    }

    const baseState = {
      runId: createRunId(),
      sessionId: createSessionId(),
      goal: "verify the project",
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: "D:/workspace" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      plan: [],
      recentObservations: [],
      changedFiles: [],
      activeProcesses: [],
      errors: [],
      verification: "NOT_RUN",
      usage: { steps: 1, toolCalls: 0, inputTokens: 12, outputTokens: 24 },
      updatedAt: 1_700_000_000_000,
    };
    const reserved = {
      ...baseState,
      modelOutputRecovery: {
        version: 1,
        sourceStepId: createStepId(),
        previousOutputTokens: 16_384,
        targetOutputTokens: 32_768,
        phase: "RESERVED",
      },
    };
    const opened = {
      ...reserved,
      modelOutputRecovery: {
        ...reserved.modelOutputRecovery,
        phase: "OPENED",
        recoveryStepId: createStepId(),
      },
    };

    expect(stateSchema.parse(JSON.parse(JSON.stringify(reserved)))).toEqual(reserved);
    expect(stateSchema.parse(JSON.parse(JSON.stringify(opened)))).toEqual(opened);
    expect(
      stateSchema.safeParse({
        ...baseState,
        modelOutputRecovery: { ...reserved.modelOutputRecovery, targetOutputTokens: 16_384 },
      }).success,
    ).toBe(false);
    expect(
      stateSchema.safeParse({
        ...baseState,
        modelOutputRecovery: { ...reserved.modelOutputRecovery, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      stateSchema.safeParse({
        ...baseState,
        modelOutputRecovery: {
          ...reserved.modelOutputRecovery,
          phase: "OPENED",
        },
      }).success,
    ).toBe(false);
    expect(
      stateSchema.safeParse({
        ...baseState,
        modelOutputRecovery: {
          ...opened.modelOutputRecovery,
          phase: "RESERVED",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects negative counters and an unbounded event-history field", () => {
    const stateSchema = getSchema("AgentStateSchema");
    const createRunId = getFactory("createRunId");
    const createSessionId = getFactory("createSessionId");
    const createWorkspaceId = getFactory("createWorkspaceId");
    if (
      stateSchema === undefined ||
      createRunId === undefined ||
      createSessionId === undefined ||
      createWorkspaceId === undefined
    ) {
      return;
    }

    const state = {
      runId: createRunId(),
      sessionId: createSessionId(),
      goal: "verify the project",
      status: "RUNNING",
      workspace: { id: createWorkspaceId(), path: "D:/workspace" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      plan: [],
      recentObservations: [],
      changedFiles: [],
      activeProcesses: [],
      errors: [],
      verification: "NOT_RUN",
      usage: { steps: -1, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
      updatedAt: 1_700_000_000_000,
      events: [],
    };

    expect(stateSchema.safeParse(state).success).toBe(false);
  });
});
