import { LLMAssistantMessageSchema, LLMToolResultMessageSchema } from "@caelush/llm/messages";
import { FinishReasonSchema, LLMUsageSchema } from "@caelush/llm/turn";
import type { ModelUsage } from "@caelush/ai";

/**
 * The durable usage shape.
 *
 * The stored JSON is unchanged: the legacy schema still decides what is valid. The
 * transform only drops explicitly-undefined members so the decoded value satisfies
 * the frozen `ModelUsage` contract, which distinguishes an absent counter from a
 * present-but-undefined one.
 */
const DurableModelUsageSchema = LLMUsageSchema.transform((usage): ModelUsage => {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (value !== undefined) normalized[key] = value as number;
  }
  return normalized as ModelUsage;
});
import {
  JsonObjectSchema,
  ApprovalRequestIdSchema,
  LLMCallIdSchema,
  ModelRefSchema,
  RunIdSchema,
  StepIdSchema,
  TimestampMsSchema,
  ToolInvocationIdSchema,
  ToolNameSchema,
  VerificationCheckIdSchema,
  VerificationEvidenceIdSchema,
  VerificationPlanIdSchema,
} from "@caelush/protocol";
import { z } from "zod";

export const AgentModelTurnSchema = z
  .object({
    callId: LLMCallIdSchema,
    model: ModelRefSchema,
    finishReason: FinishReasonSchema,
    assistantMessage: LLMAssistantMessageSchema,
    usage: DurableModelUsageSchema.optional(),
  })
  .strict();

export const AgentToolRequestSchema = z
  .object({
    externalCallId: z.string().min(1),
    toolName: ToolNameSchema,
    args: JsonObjectSchema,
  })
  .strict();

function assistantToolCalls(
  message: z.infer<typeof LLMAssistantMessageSchema>,
): readonly { toolCallId: string; toolName: string; input: unknown }[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
      : [],
  );
}

export const AgentToolCallsDecisionSchema = z
  .object({
    type: z.literal("TOOL_CALLS_REQUESTED"),
    modelTurn: AgentModelTurnSchema,
    toolRequests: z.array(AgentToolRequestSchema).min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    const calls = assistantToolCalls(decision.modelTurn.assistantMessage);
    if (calls.length !== decision.toolRequests.length) {
      context.addIssue({ code: "custom", message: "assistant tool calls do not match requests" });
      return;
    }
    for (const [index, call] of calls.entries()) {
      const request = decision.toolRequests[index];
      if (
        request === undefined ||
        call.toolCallId !== request.externalCallId ||
        call.toolName !== request.toolName ||
        JSON.stringify(call.input) !== JSON.stringify(request.args)
      ) {
        context.addIssue({
          code: "custom",
          message: "assistant tool call identity does not match",
        });
        return;
      }
    }
  });

export const AgentFinalCandidateDecisionSchema = z
  .object({
    type: z.literal("FINAL_CANDIDATE"),
    modelTurn: AgentModelTurnSchema,
    candidateText: z.string().min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    const textParts = decision.modelTurn.assistantMessage.content.filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    );
    if (
      textParts.length === 0 ||
      textParts.map((part) => part.text).join("") !== decision.candidateText
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate text does not match assistant message",
      });
    }
  });

export const AgentDecisionSchema = z.discriminatedUnion("type", [
  AgentToolCallsDecisionSchema,
  AgentFinalCandidateDecisionSchema,
]);

export const WaitingToolResultsContinuationSchema = z
  .object({
    type: z.literal("WAITING_TOOL_RESULTS"),
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    pendingDecision: AgentToolCallsDecisionSchema,
    receivedResults: z.array(LLMToolResultMessageSchema).min(1).optional(),
    waitingApproval: z
      .object({
        invocationId: ToolInvocationIdSchema,
        approvalId: ApprovalRequestIdSchema.optional(),
        externalCallId: z.string().min(1),
        toolName: ToolNameSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const AwaitingVerificationContinuationSchema = z
  .object({
    type: z.literal("AWAITING_VERIFICATION"),
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    verificationPlanId: VerificationPlanIdSchema,
    finalDecision: AgentFinalCandidateDecisionSchema,
  })
  .strict();

export const WaitingVerificationRepairContinuationSchema = z
  .object({
    type: z.literal("WAITING_VERIFICATION_REPAIR"),
    runId: RunIdSchema,
    failedPlanId: VerificationPlanIdSchema,
    sourceStepId: StepIdSchema,
    failedCheckIds: z.array(VerificationCheckIdSchema).min(1).max(32),
    evidenceIds: z.array(VerificationEvidenceIdSchema).max(64),
    repairCycle: z.number().int().nonnegative().safe().max(10),
  })
  .strict();

export const WaitingResourceContinuationSchema = z
  .object({
    type: z.literal("WAITING_RESOURCE"),
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    pendingDecision: AgentToolCallsDecisionSchema,
    reason: z.literal("NO_PROGRESS"),
    replanCount: z.number().int().nonnegative().safe().max(100),
  })
  .strict();

const RetryErrorCodeSchema = z.enum(["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"]);
const RetryAttemptSchema = z.number().int().positive().safe().max(10);
const WaitingRetryBase = {
  type: z.literal("WAITING_RETRY"),
  runId: RunIdSchema,
  failedStepId: StepIdSchema,
  attempt: RetryAttemptSchema,
  maxAttempts: RetryAttemptSchema,
  nextAttemptAt: TimestampMsSchema,
  errorCode: RetryErrorCodeSchema,
};

export const WaitingRetryContinuationSchema = z.discriminatedUnion("mode", [
  z
    .object({ ...WaitingRetryBase, mode: z.literal("START") })
    .strict()
    .superRefine((value, context) => {
      if (value.attempt > value.maxAttempts) {
        context.addIssue({ code: "custom", message: "attempt cannot exceed maxAttempts" });
      }
    }),
  z
    .object({
      ...WaitingRetryBase,
      mode: z.literal("TOOL_RESULTS"),
      pendingDecision: AgentToolCallsDecisionSchema,
      receivedResults: z.array(LLMToolResultMessageSchema).min(1),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.attempt > value.maxAttempts) {
        context.addIssue({ code: "custom", message: "attempt cannot exceed maxAttempts" });
      }
    }),
]);

export const RunContinuationCheckpointSchema = z.discriminatedUnion("type", [
  WaitingToolResultsContinuationSchema,
  AwaitingVerificationContinuationSchema,
  WaitingVerificationRepairContinuationSchema,
  WaitingResourceContinuationSchema,
  WaitingRetryContinuationSchema,
]);
