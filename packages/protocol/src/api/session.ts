import { z } from "zod";
import { JsonObjectSchema } from "../primitives/json.js";
import { WorkspaceRefSchema } from "../workspace.js";
import { ClientModelSelectionSchema } from "./model-selection.js";
import { ClientAgentSessionSchema } from "./public-entities.js";

export const CreateSessionRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    defaultWorkspace: WorkspaceRefSchema.optional(),
    defaultModel: ClientModelSelectionSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SessionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;

export const SessionListResponseSchema = z
  .object({
    items: z.array(ClientAgentSessionSchema),
  })
  .strict();
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
