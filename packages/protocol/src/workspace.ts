import { z } from "zod";
import { WorkspaceIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

export const WorkspaceRefSchema = z
  .object({
    id: WorkspaceIdSchema,
    path: z.string().min(1),
  })
  .strict();
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

export const WorkspaceRecordSchema = z
  .object({
    id: WorkspaceIdSchema,
    canonicalPath: z.string().min(1),
    displayName: z.string().min(1),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    lastOpenedAt: TimestampMsSchema,
  })
  .strict();
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

export const WorkspaceSummarySchema = WorkspaceRecordSchema;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
