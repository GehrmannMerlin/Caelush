import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  createWorkspaceId,
  computeSecurityPolicyDigest,
} from "@caelush/protocol";
import type {
  AgentRun,
  AgentSession,
  AgentState,
  TimestampMs,
  AgentStep,
  VerificationPlanDraft,
} from "@caelush/protocol";
import { createCodingCompletionAssembly } from "@caelush/core";
import type { CaelushStorage } from "../../src/index.js";

export function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: createSessionId(),
    createdAt: createTimestampMs(100),
    updatedAt: createTimestampMs(100),
    metadata: { test: true },
    ...overrides,
  };
}

export function makeSecurityPolicy(
  permissionProfile: AgentRun["permissionProfile"] = "READ_ONLY",
  approvalPolicy: AgentRun["approvalPolicy"] = "ON_BOUNDARY",
): NonNullable<AgentRun["securityPolicy"]> {
  const preset =
    permissionProfile === "READ_ONLY"
      ? { id: "VIEW_ONLY" as const, version: 1 }
      : permissionProfile === "PROJECT_ACCESS"
        ? { id: "WORKSPACE_WRITE" as const, version: 1 }
        : { id: "FULL_ACCESS" as const, version: 1 };
  const securityPolicyWithoutDigest = {
    schemaVersion: 1 as const,
    preset,
    permissionProfile,
    approvalPolicy,
    filesystemBoundary:
      permissionProfile === "READ_ONLY"
        ? ("WORKSPACE_READ_ONLY" as const)
        : permissionProfile === "PROJECT_ACCESS"
          ? ("WORKSPACE_READ_WRITE" as const)
          : ("HOST_USER_SCOPE" as const),
    processBoundary:
      permissionProfile === "READ_ONLY"
        ? ("READ_ONLY" as const)
        : permissionProfile === "PROJECT_ACCESS"
          ? ("WORKSPACE_WRITE" as const)
          : ("UNRESTRICTED" as const),
    requiredEnforcement:
      permissionProfile === "FULL_ACCESS"
        ? ("HARD_SAFETY_ONLY" as const)
        : ("OS_RESTRICTED" as const),
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: new Date(100).toISOString(),
  };
  return {
    ...securityPolicyWithoutDigest,
    policyDigest: computeSecurityPolicyDigest(securityPolicyWithoutDigest),
  };
}

export function makeRun(
  sessionId: AgentSession["id"],
  overrides: Partial<AgentRun> = {},
): AgentRun {
  const permissionProfile = overrides.permissionProfile ?? "READ_ONLY";
  const approvalPolicy = overrides.approvalPolicy ?? "ON_BOUNDARY";
  return {
    id: createRunId(),
    sessionId,
    goal: "test goal",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "test" },
    permissionProfile,
    approvalPolicy,
    limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
    createdAt: createTimestampMs(100),
    ...overrides,
    securityPolicy:
      overrides.securityPolicy ?? makeSecurityPolicy(permissionProfile, approvalPolicy),
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

export function createStorageTestCompletionAssembly(
  storage: CaelushStorage,
  clock: { now(): TimestampMs },
) {
  return createCodingCompletionAssembly({
    clock,
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    planner: verificationPlanner,
    planIdFactory: createVerificationPlanId,
    checkIdFactory: createVerificationCheckId,
    evidenceIdFactory: createVerificationEvidenceId,
    executionStore: storage.verificationExecution,
    executionRecovery: storage.verificationExecution,
    reviewer: {
      review: async ({ bundle }) => ({
        status: "PASSED" as const,
        review: { verdict: "PASS" as const, summary: "The fixture candidate is acceptable." },
        reviewInputHash: bundle.reviewInputHash,
      }),
    },
    evidenceSanitizer: {
      redactText: (value) => value,
      boundText: (value, maxBytes) => ({
        text: value.slice(0, maxBytes),
        omittedBytes: Math.max(0, Buffer.byteLength(value, "utf8") - maxBytes),
        truncated: Buffer.byteLength(value, "utf8") > maxBytes,
      }),
    },
    workspace: {
      inspect: async () => ({ inspectionComplete: true, paths: [] }),
    },
    git: {
      status: async () => ({ available: false }),
      diff: async ({ path }) => ({ path, diff: "", truncated: false }),
    },
  });
}
