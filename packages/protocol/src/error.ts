import { z } from "zod";
import { JsonObjectSchema } from "./primitives/json.js";

export const AgentErrorCodeSchema = z.enum([
  "NETWORK_ERROR",
  "RATE_LIMIT",
  "MODEL_ERROR",
  "CONVERSATION_CONTINUITY_INCOMPATIBLE",
  "MODEL_TIMEOUT",
  "TOOL_ARGUMENT_ERROR",
  "TOOL_EXECUTION_ERROR",
  "TOOL_OUTPUT_ERROR",
  "TOOL_OUTCOME_UNKNOWN",
  "PERMISSION_DENIED",
  "APPROVAL_REJECTED",
  "FILE_CONFLICT",
  "COMMAND_FAILED",
  "PROCESS_FAILED",
  "VERIFICATION_FAILED",
  "RUNTIME_ERROR",
  "CANCELLED",
  "TIMEOUT",
  "BUDGET_EXCEEDED",
  "CONTEXT_EXHAUSTED",
  "BUDGET_ENFORCEMENT_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

export const AgentErrorPhaseSchema = z.enum([
  "LLM",
  "TOOL",
  "RUNTIME",
  "VERIFICATION",
  "SECURITY",
  "INTERNAL",
]);
export type AgentErrorPhase = z.infer<typeof AgentErrorPhaseSchema>;

/**
 * The bounded vocabulary for *why* a Tool boundary failed.
 *
 * ```text
 * TOOL_PREPARATION_FAILED               arguments could not be prepared
 * TOOL_ADMISSION_FAILED                 admission/Guard/Security infrastructure failed
 * TOOL_EXECUTION_INFRASTRUCTURE_FAILED  the invocation lifecycle or handler infrastructure failed
 * TOOL_RESULT_PIPELINE_FAILED           sanitizing/settling the result failed
 * TOOL_SETTLEMENT_FAILED                the settlement commit failed
 * TOOL_RECOVERY_FAILED                  resuming a durable invocation failed
 * TOOL_INFRASTRUCTURE_FAILED            a Tool failure whose stage could not be derived
 * ```
 *
 * These are the only values a host may publish. They say which stage failed, never *what* it
 * contained: no message, stack, argument, provider state or host path belongs in this vocabulary, and
 * a consumer that receives one of them must not infer anything narrower than the stage.
 */
export const ToolInfrastructureFailureReasonSchema = z.enum([
  "TOOL_PREPARATION_FAILED",
  "TOOL_ADMISSION_FAILED",
  "TOOL_EXECUTION_INFRASTRUCTURE_FAILED",
  "TOOL_RESULT_PIPELINE_FAILED",
  "TOOL_SETTLEMENT_FAILED",
  "TOOL_RECOVERY_FAILED",
  "TOOL_INFRASTRUCTURE_FAILED",
]);
export type ToolInfrastructureFailureReason = z.infer<typeof ToolInfrastructureFailureReasonSchema>;

export const AgentErrorSchema = z
  .object({
    code: AgentErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    phase: AgentErrorPhaseSchema.optional(),
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type AgentError = z.infer<typeof AgentErrorSchema>;
