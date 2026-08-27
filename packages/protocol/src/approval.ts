import { z } from "zod";
import { ApprovalPolicySchema, RiskLevelSchema } from "./policy.js";
import { JsonObjectSchema } from "./primitives/json.js";
import { ApprovalRequestIdSchema, RunIdSchema, ToolInvocationIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

export const ApprovalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalScopeSchema = z.enum(["ONCE", "RUN"]);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = z
  .object({
    id: ApprovalRequestIdSchema,
    runId: RunIdSchema,
    toolInvocationId: ToolInvocationIdSchema,
    riskLevel: RiskLevelSchema,
    title: z.string().min(1),
    reason: z.string().min(1),
    action: JsonObjectSchema,
    status: ApprovalStatusSchema,
    scope: ApprovalScopeSchema,
    grantedScope: ApprovalScopeSchema.optional(),
    expiresAt: TimestampMsSchema.optional(),
    createdAt: TimestampMsSchema,
    resolvedAt: TimestampMsSchema.optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export { ApprovalPolicySchema };
