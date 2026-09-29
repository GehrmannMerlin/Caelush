import { z } from "zod";
import { WorkspaceIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";
import { WorkspaceRecordSchema, WorkspaceSummarySchema } from "../workspace.js";
import { ClientAgentRunSchema, ClientAgentSessionSchema } from "./public-entities.js";

export const CreateWorkspaceRequestSchema = z
  .object({
    path: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const WorkspaceListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();
export type WorkspaceListQuery = z.infer<typeof WorkspaceListQuerySchema>;

export const WorkspaceListResponseSchema = z
  .object({
    items: z.array(WorkspaceSummarySchema),
  })
  .strict();
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;

export const WorkspaceDirectoryPickerResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("SELECTED"),
      path: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("CANCELLED") }).strict(),
  z.object({ status: z.literal("UNAVAILABLE") }).strict(),
  z.object({ status: z.literal("TIMEOUT") }).strict(),
]);
export type WorkspaceDirectoryPickerResponse = z.infer<
  typeof WorkspaceDirectoryPickerResponseSchema
>;

export const WorkspaceIdParamSchema = z.object({ workspaceId: WorkspaceIdSchema }).strict();

export const WorkspaceSessionSummarySchema = z
  .object({
    session: ClientAgentSessionSchema,
    lastActivityAt: TimestampMsSchema,
    latestRun: ClientAgentRunSchema.optional(),
  })
  .strict();
export type WorkspaceSessionSummary = z.infer<typeof WorkspaceSessionSummarySchema>;

export const WorkspaceSessionListResponseSchema = z
  .object({ items: z.array(WorkspaceSessionSummarySchema) })
  .strict();
export type WorkspaceSessionListResponse = z.infer<typeof WorkspaceSessionListResponseSchema>;

export { WorkspaceRecordSchema };
