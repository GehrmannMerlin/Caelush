import { z } from "zod";
import { JsonObjectSchema } from "./primitives/json.js";

export const AgentErrorCodeSchema = z.enum([
  "NETWORK_ERROR",
  "RATE_LIMIT",
  "MODEL_ERROR",
  "MODEL_TIMEOUT",
  "TOOL_ARGUMENT_ERROR",
  "TOOL_EXECUTION_ERROR",
  "TOOL_OUTPUT_ERROR",
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
