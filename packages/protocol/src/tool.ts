import { z } from "zod";
import { AgentErrorSchema } from "./error.js";
import { RiskLevelSchema } from "./policy.js";
import { JsonObjectSchema } from "./primitives/json.js";
import { RunIdSchema, StepIdSchema, ToolInvocationIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

/**
 * The durable Tool identity primitive.
 *
 * ```text
 * ^[a-z][a-z0-9_]*$        a stable, lowercase, underscore-separated Tool name
 * ```
 *
 * It remains a Protocol primitive after Phase 4F retired `ToolDefinition` and `ToolDefinitionSchema`
 * from this module, because it is not part of that contract: a `ToolName` is a durable value the
 * `ToolInvocation` row stores, the model catalog keys on, and the approval identity hashes. It is
 * used by layers that have no opinion about a Tool's description or its input schema.
 */
export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolInvocationStatusSchema = z.enum([
  "REQUESTED",
  "WAITING_APPROVAL",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type ToolInvocationStatus = z.infer<typeof ToolInvocationStatusSchema>;

export const ToolInvocationSchema = z
  .object({
    id: ToolInvocationIdSchema,
    runId: RunIdSchema,
    stepId: StepIdSchema,
    toolName: ToolNameSchema,
    externalCallId: z.string().min(1).optional(),
    args: JsonObjectSchema,
    riskLevel: RiskLevelSchema,
    status: ToolInvocationStatusSchema,
    createdAt: TimestampMsSchema,
    startedAt: TimestampMsSchema.optional(),
    finishedAt: TimestampMsSchema.optional(),
    error: AgentErrorSchema.optional(),
  })
  .strict();
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
