import { z } from "zod";
import { AgentErrorSchema } from "./error.js";
import { CapabilitySchema, RiskLevelSchema } from "./policy.js";
import { JsonObjectSchema } from "./primitives/json.js";
import { RunIdSchema, StepIdSchema, ToolInvocationIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolDefinitionSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().min(1),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    riskLevel: RiskLevelSchema,
    requiredCapabilities: z.array(CapabilitySchema),
    runtimeRequirements: JsonObjectSchema,
  })
  .strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

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
