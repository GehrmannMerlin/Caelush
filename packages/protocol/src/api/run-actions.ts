import { z } from "zod";
import { RunIdSchema } from "../primitives/ids.js";
import { ClientAgentRunSchema } from "./public-entities.js";

export const RunActionSchema = z.enum([
  "START",
  "RECOVER",
  "CANCEL",
  "RESOLVE_APPROVAL",
  "CONTINUE_RESOURCE",
]);
export type RunAction = z.infer<typeof RunActionSchema>;

export const RunActionDispositionSchema = z.enum([
  "SCHEDULED",
  "ALREADY_ACTIVE",
  "NOOP_TERMINAL",
  "SETTLED",
]);
export type RunActionDisposition = z.infer<typeof RunActionDispositionSchema>;

export const RunActionResponseSchema = z
  .object({
    runId: RunIdSchema,
    action: RunActionSchema,
    disposition: RunActionDispositionSchema,
    run: ClientAgentRunSchema,
  })
  .strict();
export type RunActionResponse = z.infer<typeof RunActionResponseSchema>;
