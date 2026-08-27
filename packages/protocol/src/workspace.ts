import { z } from "zod";
import { WorkspaceIdSchema } from "./primitives/ids.js";

export const WorkspaceRefSchema = z
  .object({
    id: WorkspaceIdSchema,
    path: z.string().min(1),
  })
  .strict();
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;
