import { z } from "zod";
import { ModelRefSchema } from "./model.js";
import { JsonObjectSchema } from "./primitives/json.js";
import { SessionIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";
import { WorkspaceRefSchema } from "./workspace.js";
import { WorkspaceIdSchema } from "./primitives/ids.js";

export const AgentSessionSchema = z
  .object({
    id: SessionIdSchema,
    workspaceId: WorkspaceIdSchema.optional(),
    title: z.string().min(1).optional(),
    defaultWorkspace: WorkspaceRefSchema.optional(),
    defaultModel: ModelRefSchema.optional(),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
    metadata: JsonObjectSchema,
  })
  .strict();
export type AgentSession = z.infer<typeof AgentSessionSchema>;
