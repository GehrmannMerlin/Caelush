import { z } from "zod";
import { RunLimitsSchema } from "../limits.js";
import { RunStatusSchema } from "../run.js";
import { RuntimeRefSchema } from "../runtime.js";
import { WorkspaceRefSchema } from "../workspace.js";
import { ClientAgentRunSchema } from "./public-entities.js";
import { ClientModelSelectionSchema, ReasoningLevelSchema } from "./model-selection.js";
import { RunResourcePolicySchema } from "../resource-policy.js";
import { PermissionPresetSelectionSchema } from "../security-policy.js";

export const CreateRunRequestSchema = z
  .object({
    goal: z.string().min(1),
    workspace: WorkspaceRefSchema,
    model: ClientModelSelectionSchema.optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    runtime: RuntimeRefSchema,
    preset: PermissionPresetSelectionSchema,
    limits: RunLimitsSchema.optional(),
    resourcePolicy: RunResourcePolicySchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.limits === undefined) !== (value.resourcePolicy === undefined),
    "exactly one of limits or resourcePolicy is required",
  );
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
    items: z.array(ClientAgentRunSchema),
  })
  .strict();
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
