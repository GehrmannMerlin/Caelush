import type { RunContinuationCheckpoint } from "@caelush/agent";
import {
  createRunId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationPlanId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  toAgentContinuation,
  toDurableContinuation,
} from "../src/run-continuation-compatibility.js";

/**
 * The continuation codec's contract, stated as parity.
 *
 * Every discriminant is asserted, including the two that a general store test cannot legally
 * construct on a bare Run: a projection is only trustworthy if it is exhaustive over the union,
 * and a variant that was never round-tripped is a variant nobody has checked.
 */

const RUN_ID = createRunId();
const STEP_ID = createStepId();
const PLAN_ID = createVerificationPlanId();
const CHECK_ID = createVerificationCheckId();

const OBSERVATION_POLICY = { maxSingleObservationTokens: 11, maxObservationBatchTokens: 22 };

const TOOL_RESULT = {
  role: "tool",
  toolCallId: "call_a",
  toolName: "read_file",
  content: "a.ts:1: hello",
  isError: false,
} as const;

const PENDING_DECISION = {
  type: "TOOL_CALLS_REQUESTED",
  modelTurn: {
    callId: "llm_01a04963-5904-73ad-909e-2134fe57547e",
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "TOOL_CALLS",
    assistantMessage: {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "a" } },
      ],
    },
  },
  toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a" } }],
} as unknown as Extract<
  RunContinuationCheckpoint,
  { type: "WAITING_TOOL_RESULTS" }
>["pendingDecision"];

const FINAL_DECISION = {
  type: "FINAL_CANDIDATE",
  modelTurn: {
    callId: "llm_01a04963-5904-73ad-909e-2134fe57547e",
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "STOP",
    assistantMessage: { role: "assistant", content: [{ type: "text", text: "done" }] },
  },
  candidateText: "done",
} as unknown as Extract<
  RunContinuationCheckpoint,
  { type: "AWAITING_VERIFICATION" }
>["finalDecision"];

const CHECKPOINTS: readonly RunContinuationCheckpoint[] = [
  {
    type: "WAITING_TOOL_RESULTS",
    runId: RUN_ID,
    sourceStepId: STEP_ID,
    pendingDecision: PENDING_DECISION,
    receivedResults: [TOOL_RESULT],
    observationPolicy: OBSERVATION_POLICY,
    waitingApproval: {
      invocationId: "tinv_01a04963-5904-73ad-909e-2134fe57547e" as never,
      approvalId: "appr_01a04963-5904-73ad-909e-2134fe57547e" as never,
      externalCallId: "call_a",
      toolName: "read_file",
    },
  },
  {
    type: "WAITING_TOOL_RESULTS",
    runId: RUN_ID,
    sourceStepId: STEP_ID,
    pendingDecision: PENDING_DECISION,
  },
  {
    type: "AWAITING_VERIFICATION",
    runId: RUN_ID,
    sourceStepId: STEP_ID,
    verificationPlanId: PLAN_ID,
    finalDecision: FINAL_DECISION,
  },
  {
    type: "WAITING_VERIFICATION_REPAIR",
    runId: RUN_ID,
    failedPlanId: PLAN_ID,
    sourceStepId: STEP_ID,
    failedCheckIds: [CHECK_ID],
    evidenceIds: [],
    repairCycle: 3,
  },
  {
    type: "WAITING_RESOURCE",
    runId: RUN_ID,
    sourceStepId: STEP_ID,
    pendingDecision: PENDING_DECISION,
    reason: "NO_PROGRESS",
    replanCount: 2,
  },
  {
    type: "WAITING_RETRY",
    mode: "START",
    runId: RUN_ID,
    failedStepId: STEP_ID,
    attempt: 1,
    maxAttempts: 3,
    nextAttemptAt: createTimestampMs(500),
    errorCode: "LLM_TIMEOUT",
  },
  {
    type: "WAITING_RETRY",
    mode: "TOOL_RESULTS",
    runId: RUN_ID,
    failedStepId: STEP_ID,
    attempt: 2,
    maxAttempts: 3,
    nextAttemptAt: createTimestampMs(500),
    errorCode: "LLM_RATE_LIMIT",
    pendingDecision: PENDING_DECISION,
    receivedResults: [TOOL_RESULT],
    sourceStepId: STEP_ID,
    observationPolicy: OBSERVATION_POLICY,
  },
];

describe("Run continuation compatibility codec", () => {
  it("round-trips every discriminant and every variant of the union", () => {
    for (const checkpoint of CHECKPOINTS) {
      const label = `${checkpoint.type}${checkpoint.type === "WAITING_RETRY" ? `/${checkpoint.mode}` : ""}`;
      expect(toAgentContinuation(toDurableContinuation(checkpoint)), label).toEqual(checkpoint);
    }
  });

  it("keeps the observation policy in the durable record", () => {
    const withPolicy = CHECKPOINTS[0]!;
    const durable = toDurableContinuation(withPolicy);

    expect(durable).toHaveProperty("observationPolicy", OBSERVATION_POLICY);
    expect(toAgentContinuation(durable)).toHaveProperty("observationPolicy", OBSERVATION_POLICY);
  });

  it("drops the artifact pointer a persisted Tool result may still carry", () => {
    // Rows written before Phase 3C can hold it, and the canonical contract has no field for it.
    const durable = {
      type: "WAITING_TOOL_RESULTS",
      runId: RUN_ID,
      sourceStepId: STEP_ID,
      pendingDecision: PENDING_DECISION,
      receivedResults: [{ ...TOOL_RESULT, rawArtifactRef: "artifact:call_a" }],
    } as unknown as ReturnType<typeof toDurableContinuation>;

    expect(toAgentContinuation(durable)).toEqual({
      type: "WAITING_TOOL_RESULTS",
      runId: RUN_ID,
      sourceStepId: STEP_ID,
      pendingDecision: PENDING_DECISION,
      receivedResults: [TOOL_RESULT],
    });
  });
});
