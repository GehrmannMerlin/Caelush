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

/**
 * Which part of Context preparation failed.
 *
 * ```text
 * surface_read          the durable Prompt Surface could not be read back as recorded
 * surface_capacity      the projection does not fit the Surface's byte/record bounds
 * surface_persistence   a rollover or append could not be committed
 * pressure_accounting   the input budget or its reservations could not be established
 * compaction            reducing the context to fit failed
 * unknown               a local failure whose stage could not be derived from its type
 * ```
 *
 * Stages are a closed vocabulary for the same reason the Tool stages are: they say where a failure
 * happened, never what it contained. They are lower case because they name a phase of preparation
 * rather than a published error code, and the design that introduced them names them this way.
 */
export const ContextPreparationStageSchema = z.enum([
  "surface_read",
  "surface_capacity",
  "surface_persistence",
  "pressure_accounting",
  "compaction",
  "unknown",
]);
export type ContextPreparationStage = z.infer<typeof ContextPreparationStageSchema>;

/**
 * The bounded vocabulary for *why* Context preparation failed.
 *
 * Every value names the artifact that broke, not the model, the provider or the network. A consumer
 * that receives one of these must not infer a provider rejection: a context that cannot be prepared
 * is a local failure, and reporting it as "the model refused" is the misdiagnosis this vocabulary
 * exists to prevent.
 */
export const ContextPreparationFailureReasonSchema = z.enum([
  "CONTEXT_SURFACE_INTEGRITY_FAILED",
  "CONTEXT_SURFACE_BASELINE_TOO_LARGE",
  "CONTEXT_SURFACE_ROLLOVER_CONFLICT",
  "CONTEXT_SURFACE_ROLLOVER_FAILED",
  "CONTEXT_SURFACE_PERSISTENCE_FAILED",
  "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
  "CONTEXT_WINDOW_EXHAUSTED",
  "CONTEXT_PREPARATION_FAILED",
]);
export type ContextPreparationFailureReason = z.infer<typeof ContextPreparationFailureReasonSchema>;

/**
 * The one object a Run error may publish about Context preparation.
 *
 * `dimension`, `observed` and `limit` come from the typed capacity error that raised the failure and
 * are only present when it carried them: a byte bound that was measured, not a guess. They are
 * non-negative safe integers and a short token, so the shape cannot carry a message, a path or a
 * payload even if a future producer tried.
 */
export const ContextPreparationDiagnosticSchema = z
  .object({
    reasonCode: ContextPreparationFailureReasonSchema,
    stage: ContextPreparationStageSchema,
    dimension: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/u)
      .optional(),
    observed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type ContextPreparationDiagnostic = z.infer<typeof ContextPreparationDiagnosticSchema>;

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
