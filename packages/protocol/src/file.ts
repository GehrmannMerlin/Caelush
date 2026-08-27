import { z } from "zod";

export const FileChangeTypeSchema = z.enum(["CREATED", "MODIFIED", "MOVED", "DELETED"]);
export type FileChangeType = z.infer<typeof FileChangeTypeSchema>;

export const FileChangeSummarySchema = z
  .object({
    path: z.string().min(1),
    changeType: FileChangeTypeSchema,
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
  })
  .strict();
export type FileChangeSummary = z.infer<typeof FileChangeSummarySchema>;
