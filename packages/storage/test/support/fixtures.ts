import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  computeSecurityPolicyDigest,
} from "@caelush/protocol";
import type {
  AgentRun,
  AgentSession,
  AgentState,
  AgentStep,
  VerificationPlanDraft,
} from "@caelush/protocol";

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
  const securityPolicy = {
    schemaVersion: 1 as const,
    preset: { id: "VIEW_ONLY" as const, version: 1 },
    permissionProfile: "READ_ONLY" as const,
    approvalPolicy: "ON_BOUNDARY" as const,
    filesystemBoundary: "WORKSPACE_READ_ONLY" as const,
    processBoundary: "READ_ONLY" as const,
    requiredEnforcement: "OS_RESTRICTED" as const,
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: new Date(100).toISOString(),
  };
  return {
    id: createRunId(),
    sessionId,
    goal: "test goal",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    securityPolicy: {
      ...securityPolicy,
      policyDigest: computeSecurityPolicyDigest(securityPolicy),
    },
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

export const verificationPlanner = {
  plan: ({
    runId,
    sourceStepId,
  }: Pick<VerificationPlanDraft, "runId" | "sourceStepId">): VerificationPlanDraft => ({
    runId,
    sourceStepId,
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: [
      {
        ordinal: 0,
        stage: "ACCEPTANCE",
        requirement: "REQUIRED",
        spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
      },
    ],
  }),
};
