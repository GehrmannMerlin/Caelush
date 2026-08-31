import { z } from "zod";
import { AgentRunSchema } from "../run.js";
import { AgentSessionSchema } from "../session.js";
import { ClientModelSelectionSchema } from "./model-selection.js";

export const ClientAgentSessionSchema = AgentSessionSchema.omit({ defaultModel: true })
  .extend({ defaultModel: ClientModelSelectionSchema.optional() })
  .strict();
export type ClientAgentSession = z.infer<typeof ClientAgentSessionSchema>;

export const ClientAgentRunSchema = AgentRunSchema.omit({ model: true })
  .extend({ model: ClientModelSelectionSchema })
  .strict();
export type ClientAgentRun = z.infer<typeof ClientAgentRunSchema>;
