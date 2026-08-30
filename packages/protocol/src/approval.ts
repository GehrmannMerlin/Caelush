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
  .strict()
  .superRefine((approval, context) => {
    if (approval.expiresAt !== undefined && approval.expiresAt <= approval.createdAt) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after createdAt" });
    }
    if (approval.resolvedAt !== undefined && approval.resolvedAt < approval.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "must be at or after createdAt",
      });
    }
    if (approval.status === "PENDING") {
      if (approval.grantedScope !== undefined || approval.resolvedAt !== undefined) {
        context.addIssue({ code: "custom", message: "pending approval cannot be resolved" });
      }
      return;
    }
    if (approval.status === "APPROVED") {
      if (approval.grantedScope === undefined || approval.resolvedAt === undefined) {
        context.addIssue({
          code: "custom",
          message: "approved approval requires resolution fields",
        });
      }
      return;
    }
    if (approval.grantedScope !== undefined || approval.resolvedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "non-approved approval has invalid resolution fields",
      });
    }
  });
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResolutionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("APPROVE"), scope: ApprovalScopeSchema }).strict(),
  z.object({ action: z.literal("REJECT") }).strict(),
]);
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export { ApprovalPolicySchema };
