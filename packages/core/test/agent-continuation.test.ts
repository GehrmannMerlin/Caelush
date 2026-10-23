import {
  createLLMCallId,
  createRunId,
  createStepId,
  createVerificationPlanId,
  ModelRefSchema,
} from "@caelush/protocol";
import type { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ProviderRetryErrorCode,
  RetryErrorCode,
  WaitingProviderContinuation,
  WaitingRetryContinuation,
} from "../src/agent-continuation.js";
import {
  AgentFinalCandidateDecisionSchema,
  AgentToolCallsDecisionSchema,
  RunContinuationCheckpointSchema,
  WaitingProviderContinuationSchema,
  WaitingRetryContinuationSchema,
} from "../src/agent-continuation-schema.js";

const runId = createRunId();
const sourceStepId = createStepId();
const model = ModelRefSchema.parse({ provider: "fixture", model: "fixture-model" });

const assistantWithToolCall = {
  role: "assistant" as const,
  content: [
    {
      type: "tool-call" as const,
      toolCallId: "call_a",
      toolName: "read_file" as const,
      input: { path: "src/index.ts" },
    },
  ],
};

const toolDecision = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: {
    callId: createLLMCallId(),
    model,
    finishReason: "TOOL_CALLS" as const,
    assistantMessage: assistantWithToolCall,
    usage: { inputTokens: 10, outputTokens: 4 },
  },
  toolRequests: [
    {
      externalCallId: "call_a",
      toolName: "read_file" as const,
      args: { path: "src/index.ts" },
    },
  ],
};

describe("durable continuation schemas", () => {
  it("accepts a verification repair continuation without a RunStatus", () => {
    expect(
      RunContinuationCheckpointSchema.parse({
        type: "WAITING_VERIFICATION_REPAIR",
        runId,
        failedPlanId: createVerificationPlanId(),
        sourceStepId,
        failedCheckIds: ["vchk_019a0000-0000-7000-8000-000000000000"],
        evidenceIds: ["vevd_019a0000-0000-7000-8000-000000000000"],
        repairCycle: 1,
      }),
    ).toMatchObject({ type: "WAITING_VERIFICATION_REPAIR", repairCycle: 1 });
  });
  it("validates a waiting-tool-results checkpoint and its accepted result batch", () => {
    const checkpoint = {
      type: "WAITING_TOOL_RESULTS" as const,
      runId,
      sourceStepId,
      pendingDecision: toolDecision,
      receivedResults: [
        {
          role: "tool" as const,
          toolCallId: "call_a",
          toolName: "read_file" as const,
          content: "source",
          isError: false,
        },
      ],
    };

    expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(AgentToolCallsDecisionSchema.parse(toolDecision)).toEqual(toolDecision);
  });

  it("validates a final candidate checkpoint without treating it as a completed run", () => {
    const decision = {
      type: "FINAL_CANDIDATE" as const,
      modelTurn: {
        callId: createLLMCallId(),
        model,
        finishReason: "STOP" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "answer" }],
        },
      },
      candidateText: "answer",
    };
    const checkpoint = {
      type: "AWAITING_VERIFICATION" as const,
      runId,
      sourceStepId,
      verificationPlanId: createVerificationPlanId(),
      finalDecision: decision,
    };

    expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(AgentFinalCandidateDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects malformed or synthetic continuation data", () => {
    expect(() =>
      RunContinuationCheckpointSchema.parse({ type: "WAITING_TOOL_RESULTS", runId, sourceStepId }),
    ).toThrow();
    expect(() =>
      RunContinuationCheckpointSchema.parse({
        type: "AWAITING_VERIFICATION",
        runId,
        sourceStepId,
        verificationPlanId: createVerificationPlanId(),
        finalDecision: { candidateText: "answer" },
      }),
    ).toThrow();
    expect(() =>
      RunContinuationCheckpointSchema.parse({
        type: "WAITING_TOOL_RESULTS",
        runId,
        sourceStepId,
        pendingDecision: toolDecision,
        systemPrompt: "secret",
      }),
    ).toThrow();
  });

  it("validates a START retry continuation with the next attempt number", () => {
    const checkpoint = {
      type: "WAITING_RETRY" as const,
      runId,
      failedStepId: sourceStepId,
      attempt: 2,
      maxAttempts: 3,
      nextAttemptAt: 2_000,
      errorCode: "LLM_NETWORK" as const,
      mode: "START" as const,
    };
    expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(() =>
      RunContinuationCheckpointSchema.parse({ ...checkpoint, errorCode: "LLM_AUTHENTICATION" }),
    ).toThrow();
  });

  it("accepts one output retry only at attempt two and keeps it out of provider waits", () => {
    const outputRetry = {
      type: "WAITING_RETRY" as const,
      runId,
      failedStepId: sourceStepId,
      attempt: 2,
      maxAttempts: 2,
      nextAttemptAt: 2_000,
      errorCode: "LLM_OUTPUT_TRUNCATED" as const,
      mode: "START" as const,
    };

    expect(RunContinuationCheckpointSchema.parse(outputRetry)).toEqual(outputRetry);
    for (const invalid of [
      { ...outputRetry, attempt: 1 },
      { ...outputRetry, maxAttempts: 3 },
      { ...outputRetry, episode: 1 },
      { ...outputRetry, episode: undefined },
      { ...outputRetry, totalAttempts: 2 },
      {
        ...outputRetry,
        transport: { currentTransportId: "primary", attemptedTransportIds: ["primary"] },
      },
      { ...outputRetry, type: "WAITING_PROVIDER" },
    ]) {
      expect(RunContinuationCheckpointSchema.safeParse(invalid).success).toBe(false);
    }
    for (const errorCode of ["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"] as const) {
      expect(
        RunContinuationCheckpointSchema.safeParse({
          ...outputRetry,
          type: "WAITING_PROVIDER",
          attempt: 1,
          maxAttempts: 3,
          episode: 1,
          totalAttempts: 1,
          errorCode,
        }).success,
      ).toBe(true);
      expect(
        RunContinuationCheckpointSchema.safeParse({
          ...outputRetry,
          errorCode,
          attempt: 1,
          maxAttempts: 3,
          episode: 1,
          totalAttempts: 1,
          transport: { currentTransportId: "primary", attemptedTransportIds: ["primary"] },
        }).success,
      ).toBe(true);
    }
  });

  it("keeps retry error-code associations narrow in the inferred contracts", () => {
    expectTypeOf<RetryErrorCode>().toEqualTypeOf<ProviderRetryErrorCode | "LLM_OUTPUT_TRUNCATED">();
    expectTypeOf<WaitingRetryContinuation["errorCode"]>().toEqualTypeOf<RetryErrorCode>();
    expectTypeOf<
      WaitingProviderContinuation["errorCode"]
    >().toEqualTypeOf<ProviderRetryErrorCode>();
    expectTypeOf<
      z.output<typeof WaitingRetryContinuationSchema>["errorCode"]
    >().toEqualTypeOf<RetryErrorCode>();
    expectTypeOf<
      z.output<typeof WaitingProviderContinuationSchema>["errorCode"]
    >().toEqualTypeOf<ProviderRetryErrorCode>();

    // @ts-expect-error Output truncation is never a provider cooldown or transport-recovery cause.
    const invalidProviderErrorCode: WaitingProviderContinuation["errorCode"] =
      "LLM_OUTPUT_TRUNCATED";
    void invalidProviderErrorCode;

    // @ts-expect-error The provider schema's inferred output also excludes output truncation.
    const invalidSchemaProviderErrorCode: z.output<
      typeof WaitingProviderContinuationSchema
    >["errorCode"] = "LLM_OUTPUT_TRUNCATED";
    void invalidSchemaProviderErrorCode;
  });

  it("preserves output retry provenance for all three continuation modes", () => {
    const base = {
      type: "WAITING_RETRY" as const,
      runId,
      failedStepId: sourceStepId,
      attempt: 2,
      maxAttempts: 2,
      nextAttemptAt: 2_000,
      errorCode: "LLM_OUTPUT_TRUNCATED" as const,
    };
    const checkpoints = [
      { ...base, mode: "START" as const },
      {
        ...base,
        mode: "TOOL_RESULTS" as const,
        pendingDecision: toolDecision,
        receivedResults: [
          {
            role: "tool" as const,
            toolCallId: "call_a",
            toolName: "read_file" as const,
            content: "source",
            isError: false,
          },
        ],
        sourceStepId,
      },
      {
        ...base,
        mode: "STEERING" as const,
        messageIds: ["msg_steering_1"],
        sourceStepId,
      },
    ];

    for (const checkpoint of checkpoints) {
      expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
      for (const providerState of [
        { episode: 1 },
        { totalAttempts: 2 },
        { transport: { currentTransportId: "primary", attemptedTransportIds: ["primary"] } },
      ]) {
        expect(
          RunContinuationCheckpointSchema.safeParse({ ...checkpoint, ...providerState }).success,
        ).toBe(false);
      }
    }
  });

  it("decodes legacy retry checkpoints and validates persisted transport recovery", () => {
    const checkpoint = {
      type: "WAITING_RETRY" as const,
      runId,
      failedStepId: sourceStepId,
      attempt: 2,
      maxAttempts: 6,
      nextAttemptAt: 2_000,
      errorCode: "LLM_NETWORK" as const,
      mode: "START" as const,
    };

    expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(
      RunContinuationCheckpointSchema.parse({
        ...checkpoint,
        transport: {
          currentTransportId: "backup",
          attemptedTransportIds: ["default", "backup"],
        },
      }),
    ).toMatchObject({
      transport: {
        currentTransportId: "backup",
        attemptedTransportIds: ["default", "backup"],
      },
    });
    for (const transport of [
      { currentTransportId: "backup", attemptedTransportIds: ["default"] },
      { currentTransportId: "backup", attemptedTransportIds: ["default", "backup", "backup"] },
      { currentTransportId: "../backup", attemptedTransportIds: ["../backup"] },
      { currentTransportId: "backup", attemptedTransportIds: [] },
    ]) {
      expect(() => RunContinuationCheckpointSchema.parse({ ...checkpoint, transport })).toThrow();
    }
  });

  it("requires the complete Tool Result context for a retry continuation", () => {
    const checkpoint = {
      type: "WAITING_RETRY" as const,
      runId,
      failedStepId: sourceStepId,
      attempt: 2,
      maxAttempts: 3,
      nextAttemptAt: 2_000,
      errorCode: "LLM_NETWORK" as const,
      mode: "TOOL_RESULTS" as const,
    };
    expect(() => RunContinuationCheckpointSchema.parse(checkpoint)).toThrow();
    expect(
      RunContinuationCheckpointSchema.parse({
        ...checkpoint,
        pendingDecision: toolDecision,
        receivedResults: [
          {
            role: "tool" as const,
            toolCallId: "call_a",
            toolName: "read_file" as const,
            content: "source",
            isError: false,
          },
        ],
      }),
    ).toMatchObject({ mode: "TOOL_RESULTS" });
  });
});
