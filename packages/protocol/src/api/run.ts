import { z } from "zod";
import { ApprovalPolicySchema, PermissionProfileSchema } from "../policy.js";
import { RunLimitsSchema } from "../limits.js";
import { ModelRefSchema } from "../model.js";
import { AgentRunSchema, RunStatusSchema } from "../run.js";
import { RuntimeRefSchema } from "../runtime.js";
import { WorkspaceRefSchema } from "../workspace.js";

export const CreateRunRequestSchema = z
  .object({
    goal: z.string().min(1),
    workspace: WorkspaceRefSchema,
    model: ModelRefSchema,
    runtime: RuntimeRefSchema,
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    limits: RunLimitsSchema,
  })
  .strict();
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const RunListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: RunStatusSchema.optional(),
  })
  .strict();
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

export const RunListResponseSchema = z
  .object({
    items: z.array(AgentRunSchema),
  })
  .strict();
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
