import {
  AI_FINISH_REASONS,
  assertAIContent,
  assertAIMessage,
  assertModelUsage,
  type AIAssistantMessage,
  type AIContent,
  type AIMessage,
  type AIToolResultMessage,
  type ModelUsage,
} from "@caelush/ai";

/**
 * The durable usage shape.
 *
 * The stored JSON is unchanged: the legacy schema still decides what is valid. The
 * transform only drops explicitly-undefined members so the decoded value satisfies
 * the frozen `ModelUsage` contract, which distinguishes an absent counter from a
 * present-but-undefined one.
 */
const DurableModelUsageSchema = z
  .custom<ModelUsage>((value) => {
    try {
      assertModelUsage(value);
      return true;
    } catch {
      return false;
    }
  })
  .transform((usage): ModelUsage => {
    const normalized: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage)) {
      if (value !== undefined) normalized[key] = value as number;
    }
    return normalized as ModelUsage;
  });

const AIMessageSchema = z.custom<AIMessage>((value) => {
  try {
    assertAIMessage(value);
    return true;
  } catch {
    return false;
  }
});

const AIAssistantMessageSchema = AIMessageSchema.refine(
  (message): message is AIAssistantMessage => message.role === "assistant",
);

const AIToolResultMessageSchema = AIMessageSchema.refine(
  (message): message is AIToolResultMessage => message.role === "tool",
);

const FinishReasonSchema = z.enum(AI_FINISH_REASONS);
const AIMessagePhaseSchema = z.enum(["COMMENTARY", "FINAL_ANSWER", "UNKNOWN"]);
const AIContentSchema = z.custom<AIContent>((value) => {
  try {
    assertAIContent(value);
    return true;
  } catch {
    return false;
  }
});
const AIModelTurnAssistantItemSchema = z
  .object({
    assistantItemId: z.string().min(1).max(512),
    phase: AIMessagePhaseSchema,
    content: z.array(AIContentSchema).min(1),
  })
  .strict();
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
    assistantMessage: AIAssistantMessageSchema,
    // Optional for durable continuations written before phase-aware item identity existed.
    assistantItems: z.array(AIModelTurnAssistantItemSchema).optional(),
    usage: DurableModelUsageSchema.optional(),
  })
  .strict()
  .superRefine((turn, context) => {
    if (turn.assistantItems === undefined) return;
    const ids = new Set<string>();
    for (const item of turn.assistantItems) {
      if (ids.has(item.assistantItemId)) {
        context.addIssue({ code: "custom", message: "assistant item ids must be unique" });
        return;
      }
      ids.add(item.assistantItemId);
    }
    const flattened = turn.assistantItems.flatMap((item) => item.content);
    if (JSON.stringify(flattened) !== JSON.stringify(turn.assistantMessage.content)) {
      context.addIssue({
        code: "custom",
        message: "assistant items do not match the model conversation message",
      });
    }
  });

export const AgentToolRequestSchema = z
  .object({
    externalCallId: z.string().min(1),
    toolName: ToolNameSchema,
    args: JsonObjectSchema,
  })
  .strict();

/**
 * A request the model made whose arguments were not executable.
 *
 * It has no `args`, because no argument object existed. The three reasons are the frozen AI set, so
 * an unknown reason is refused here rather than decoded into a plausible-looking one.
 */
export const AgentRejectedToolRequestSchema = z
  .object({
    externalCallId: z.string().min(1),
    toolName: ToolNameSchema,
    issue: z
      .object({
        code: z.enum(["MALFORMED_JSON", "EXPECTED_OBJECT", "INCOMPLETE_ARGUMENTS"]),
        argumentBytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

function assistantToolCalls(
  message: AIAssistantMessage,
): readonly { toolCallId: string; toolName: string; input: unknown }[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }]
      : [],
  );
}

function assistantRejectedToolCalls(message: AIAssistantMessage): readonly {
  toolCallId: string;
  toolName: string;
  issue: { code: string; argumentBytes: number };
}[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call-rejected"
      ? [
          {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            issue: { code: part.issue.code, argumentBytes: part.issue.argumentBytes },
          },
        ]
      : [],
  );
}

export const AgentToolCallsDecisionSchema = z
  .object({
    type: z.literal("TOOL_CALLS_REQUESTED"),
    modelTurn: AgentModelTurnSchema,
    toolRequests: z.array(AgentToolRequestSchema),
    /**
     * Absent on every checkpoint written before rejected requests could be recorded.
     *
     * That absence is meaningful: a historical decision had no rejected request, so nothing is
     * inferred for it and no result is invented for a call it never contained.
     */
    rejectedToolRequests: z.array(AgentRejectedToolRequestSchema).optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    const rejected = decision.rejectedToolRequests ?? [];
    if (decision.toolRequests.length + rejected.length === 0) {
      context.addIssue({ code: "custom", message: "a Tool decision must request something" });
      return;
    }
    const calls = assistantToolCalls(decision.modelTurn.assistantMessage);
    const rejectedCalls = assistantRejectedToolCalls(decision.modelTurn.assistantMessage);
    if (calls.length !== decision.toolRequests.length || rejectedCalls.length !== rejected.length) {
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
    for (const [index, call] of rejectedCalls.entries()) {
      const request = rejected[index];
      if (
        request === undefined ||
        call.toolCallId !== request.externalCallId ||
        call.toolName !== request.toolName ||
        call.issue.code !== request.issue.code ||
        call.issue.argumentBytes !== request.issue.argumentBytes
      ) {
        context.addIssue({
          code: "custom",
          message: "assistant rejected tool call identity does not match",
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

/**
 * The durable Tool observation policy snapshot.
 *
 * The canonical contract owns the type; this owns the *bytes*. The field is optional on every
 * variant that carries it, so a checkpoint written before the field existed still decodes — the
 * same forward-compatible JSON evolution `sourceStepId` already uses, and not a migration.
 */
const ToolObservationPolicySnapshotSchema = z
  .object({
    maxSingleObservationTokens: z.number().int().positive().safe(),
    maxObservationBatchTokens: z.number().int().positive().safe(),
  })
  .strict();

export const WaitingToolResultsContinuationSchema = z
  .object({
    type: z.literal("WAITING_TOOL_RESULTS"),
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    pendingDecision: AgentToolCallsDecisionSchema,
    receivedResults: z.array(AIToolResultMessageSchema).min(1).optional(),
    observationPolicy: ToolObservationPolicySnapshotSchema.optional(),
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

export const WaitingResourceContinuationSchema = z.discriminatedUnion("reason", [
  z
    .object({
      type: z.literal("WAITING_RESOURCE"),
      runId: RunIdSchema,
      sourceStepId: StepIdSchema,
      pendingDecision: AgentToolCallsDecisionSchema,
      reason: z.literal("NO_PROGRESS"),
      replanCount: z.number().int().nonnegative().safe().max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("WAITING_RESOURCE"),
      runId: RunIdSchema,
      sourceStepId: StepIdSchema,
      pendingDecision: AgentToolCallsDecisionSchema,
      reason: z.literal("EFFECT_UNCONFIRMED"),
      observationPolicy: ToolObservationPolicySnapshotSchema.optional(),
      invocationId: ToolInvocationIdSchema,
      toolName: ToolNameSchema,
      reasonCode: z.enum(["DOES_NOT_MATCH", "INCONCLUSIVE", "UNSUPPORTED", "UNAVAILABLE"]),
    })
    .strict(),
]);

export const WaitingSteeringContinuationSchema = z
  .object({
    type: z.literal("WAITING_STEERING"),
    runId: RunIdSchema,
    sourceStepId: StepIdSchema,
    // One safe boundary materializes at most a bounded batch; the message list is the exact set
    // the next turn must carry, so an empty list is not a legal boundary.
    messageIds: z.array(z.string().min(1)).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.messageIds).size !== value.messageIds.length) {
      context.addIssue({ code: "custom", message: "steering message ids must be unique" });
    }
  });

const ProviderRetryErrorCodeSchema = z.enum(["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"]);
const RetryErrorCodeSchema = z.union([
  ProviderRetryErrorCodeSchema,
  z.literal("LLM_OUTPUT_TRUNCATED"),
]);
const RetryAttemptSchema = z.number().int().positive().safe().max(10);
const TransportIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const ModelTransportRecoverySchema = z
  .object({
    currentTransportId: TransportIdSchema,
    attemptedTransportIds: z.array(TransportIdSchema).min(1).max(9),
  })
  .strict()
  .superRefine((transport, context) => {
    if (new Set(transport.attemptedTransportIds).size !== transport.attemptedTransportIds.length) {
      context.addIssue({ code: "custom", message: "attempted transport ids must be unique" });
    }
    if (!transport.attemptedTransportIds.includes(transport.currentTransportId)) {
      context.addIssue({
        code: "custom",
        message: "current transport must be included in attempted transport ids",
      });
    }
  });
const WaitingRetryBase = {
  runId: RunIdSchema,
  failedStepId: StepIdSchema,
  attempt: RetryAttemptSchema,
  maxAttempts: RetryAttemptSchema,
  episode: z.number().int().positive().safe().optional(),
  totalAttempts: z.number().int().positive().safe().optional(),
  nextAttemptAt: TimestampMsSchema,
  errorCode: RetryErrorCodeSchema,
  transport: ModelTransportRecoverySchema.optional(),
};

function createRetryBoundarySchema<
  const Type extends "WAITING_RETRY" | "WAITING_PROVIDER",
  const ErrorCodeSchema extends z.ZodType<
    "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT" | "LLM_OUTPUT_TRUNCATED"
  >,
>(type: Type, errorCodeSchema: ErrorCodeSchema) {
  const base = { ...WaitingRetryBase, errorCode: errorCodeSchema, type: z.literal(type) };
  return z.discriminatedUnion("mode", [
    z
      .object({ ...base, mode: z.literal("START") })
      .strict()
      .superRefine((value, context) => {
        refineRetryBoundary(value, context);
      }),
    z
      .object({
        ...base,
        mode: z.literal("TOOL_RESULTS"),
        pendingDecision: AgentToolCallsDecisionSchema,
        receivedResults: z.array(AIToolResultMessageSchema).min(1),
        observationPolicy: ToolObservationPolicySnapshotSchema.optional(),
        // Backward-compatible JSON evolution: the field is optional so a checkpoint written
        // before it existed still decodes. Recovery treats a missing value as "not determined"
        // and refuses to resume rather than inventing one, and every new write persists it.
        sourceStepId: StepIdSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        refineRetryBoundary(value, context);
      }),
    z
      .object({
        ...base,
        mode: z.literal("STEERING"),
        messageIds: z.array(z.string().min(1)).min(1).max(64),
        sourceStepId: StepIdSchema,
      })
      .strict()
      .superRefine((value, context) => {
        refineRetryBoundary(value, context);
        if (new Set(value.messageIds).size !== value.messageIds.length) {
          context.addIssue({ code: "custom", message: "steering message ids must be unique" });
        }
      }),
  ]);
}

function refineRetryBoundary(
  value: {
    readonly attempt?: number | undefined;
    readonly maxAttempts?: number | undefined;
    readonly errorCode?: string | undefined;
    readonly episode?: unknown;
    readonly totalAttempts?: unknown;
    readonly transport?: unknown;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.attempt !== undefined &&
    value.maxAttempts !== undefined &&
    value.attempt > value.maxAttempts
  ) {
    context.addIssue({ code: "custom", message: "attempt cannot exceed maxAttempts" });
  }
  if (value.errorCode !== "LLM_OUTPUT_TRUNCATED") return;

  if (value.attempt !== 2 || value.maxAttempts !== 2) {
    context.addIssue({
      code: "custom",
      path: ["attempt"],
      message: "output recovery is limited to attempt two of two",
    });
  }
  if (
    Object.hasOwn(value, "episode") ||
    Object.hasOwn(value, "totalAttempts") ||
    Object.hasOwn(value, "transport")
  ) {
    context.addIssue({
      code: "custom",
      message: "output recovery cannot carry provider retry or transport state",
    });
  }
}

export const WaitingRetryContinuationSchema = createRetryBoundarySchema(
  "WAITING_RETRY",
  RetryErrorCodeSchema,
);
export const WaitingProviderContinuationSchema = createRetryBoundarySchema(
  "WAITING_PROVIDER",
  ProviderRetryErrorCodeSchema,
);

export const RunContinuationCheckpointSchema = z.discriminatedUnion("type", [
  WaitingToolResultsContinuationSchema,
  AwaitingVerificationContinuationSchema,
  WaitingVerificationRepairContinuationSchema,
  WaitingResourceContinuationSchema,
  WaitingSteeringContinuationSchema,
  WaitingProviderContinuationSchema,
  WaitingRetryContinuationSchema,
]);
