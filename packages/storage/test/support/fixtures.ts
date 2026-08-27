import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import type { AgentRun, AgentSession, AgentState, AgentStep } from "@caelush/protocol";

export function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: createSessionId(),
    createdAt: createTimestampMs(100),
    updatedAt: createTimestampMs(100),
    metadata: { test: true },
    ...overrides,
  };
}

export function makeRun(
  sessionId: AgentSession["id"],
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return {
    id: createRunId(),
    sessionId,
    goal: "test goal",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    ...overrides,
  };
}

export function makeStep(runId: AgentRun["id"], overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: createStepId(),
    runId,
    sequence: 1,
    status: "RUNNING",
    startedAt: createTimestampMs(100),
    ...overrides,
  };
}

export function makeState(run: AgentRun, overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
    status: run.status,
    workspace: run.workspace,
    runtime: run.runtime,
    permissionProfile: run.permissionProfile,
    approvalPolicy: run.approvalPolicy,
    plan: [],
    recentObservations: [],
    changedFiles: [],
    activeProcesses: [],
    errors: [],
    verification: "NOT_RUN",
    usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    updatedAt: createTimestampMs(100),
    ...overrides,
  };
}
