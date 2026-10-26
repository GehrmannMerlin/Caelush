import { z } from "zod";
import { RunLimitsSchema } from "../limits.js";
import { RunStatusSchema } from "../run.js";
import { RuntimeRefSchema } from "../runtime.js";
import { WorkspaceRefSchema } from "../workspace.js";
import { ClientAgentRunSchema } from "./public-entities.js";
import { ClientModelSelectionSchema, ReasoningLevelSchema } from "./model-selection.js";
import { RunResourcePolicySchema } from "../resource-policy.js";
import { PermissionPresetSelectionSchema } from "../security-policy.js";
import {
  AttachmentIdsSchema,
  ATTACHMENT_ONLY_RUN_GOAL,
  SubmissionIdSchema,
} from "../attachment.js";
import { CompletionRequirementSchema } from "../verification.js";

const UserCompletionRequirementSchema = CompletionRequirementSchema.omit({ source: true });

export const CreateRunRequestSchema = z
  .object({
    goal: z.string().min(1),
    /** Actual user-authored text; omitted by legacy clients, including text-only requests. */
    userText: z.string().max(200_000).optional(),
    attachmentIds: AttachmentIdsSchema.optional(),
    submissionId: SubmissionIdSchema.optional(),
    /** Explicit user request to retry a failed persisted Context compaction operation. */
    contextCompactionRetryOf: z.string().min(1).max(200).optional(),
    /** Explicit project checks the Run must pass before completion. Their persisted source is USER_EXPLICIT. */
    acceptanceRequirements: z.array(UserCompletionRequirementSchema).min(1).max(8).optional(),
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
  )
  .refine((value) => {
    if (value.userText === "") {
      return value.goal === ATTACHMENT_ONLY_RUN_GOAL && (value.attachmentIds?.length ?? 0) > 0;
    }
    return value.goal !== ATTACHMENT_ONLY_RUN_GOAL;
  }, "attachment-only Runs require their internal goal, empty user text and attachments")
  .refine(
    (value) => value.contextCompactionRetryOf === undefined || value.submissionId !== undefined,
    "explicit Context compaction retries require a persisted submissionId for idempotency",
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
