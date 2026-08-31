import {
  AgentRunSchema,
  VerificationPlanSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationPlanId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  evaluateCompletionAuthority,
  createVerifiedRunFinalResult,
} from "../src/completion-authority.js";

function fixture() {
  const runId = createRunId();
  const sourceStepId = createStepId();
  const planId = createVerificationPlanId();
  const plan = VerificationPlanSchema.parse({
    id: planId,
    runId,
    sourceStepId,
    plannerVersion: "v1",
    planHash: "a".repeat(64),
    candidateHash: "b".repeat(64),
    checks: [],
    createdAt: createTimestampMs(1),
  });
  const run = AgentRunSchema.parse({
    id: runId,
    sessionId: createSessionId(),
    goal: "goal",
    status: "VERIFYING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  });
  const candidateText = "verified answer";
  return {
    run,
    plan,
    candidateText,
    continuation: {
      type: "AWAITING_VERIFICATION" as const,
      runId,
      sourceStepId,
      verificationPlanId: planId,
      finalDecision: {
        type: "FINAL_CANDIDATE" as const,
        candidateText,
        model: "fixture",
      } as never,
    },
  };
}

describe("Completion Authority", () => {
  it("requires Core-owned boundary identity and freshness before completion", () => {
    const input = fixture();
    expect(
      evaluateCompletionAuthority({
        ...input,
        verificationStatus: "PASSED",
        candidateHash: "b".repeat(64),
        workspaceFreshness: "FRESH",
        gitFreshness: "FRESH",
        cancellationRequested: false,
      }),
    ).toEqual({ kind: "COMPLETE" });
    expect(
      evaluateCompletionAuthority({
        ...input,
        verificationStatus: "PASSED",
        candidateHash: "c".repeat(64),
        workspaceFreshness: "FRESH",
        gitFreshness: "FRESH",
        cancellationRequested: false,
      }),
    ).toMatchObject({ kind: "DEFER", reason: "CANDIDATE_HASH_MISMATCH" });
  });

  it("builds only the strict verified final result and never embeds evidence text", () => {
    const input = fixture();
    const result = createVerifiedRunFinalResult({
      ...input,
      candidateHash: "b".repeat(64),
      seal: {
        runId: input.run.id,
        planId: input.plan.id,
        sourceStepId: input.plan.sourceStepId,
        planHash: input.plan.planHash,
        candidateHash: "b".repeat(64),
        evidenceDigest: "c".repeat(64),
        workspaceFreshnessHash: "d".repeat(64),
        sealHash: "e".repeat(64),
      },
      counts: { total: 0, passed: 0, skipped: 0, advisoryWarnings: 0 },
    });
    expect(result).toMatchObject({ type: "VERIFIED_COMPLETION", text: input.candidateText });
    expect(JSON.stringify(result)).not.toContain("stdout");
  });
});
