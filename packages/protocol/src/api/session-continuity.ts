import { z } from "zod";
import { ModelRefSchema } from "../model.js";

/** Only the selected model identity crosses this best-effort preflight boundary. */
export const SessionContinuityPreflightQuerySchema = ModelRefSchema;
export type SessionContinuityPreflightQuery = z.infer<typeof SessionContinuityPreflightQuerySchema>;

/** The session-level result is a UI hint; exact safety is checked after Context selection. */
export const SessionContinuityPreflightResponseSchema = z
  .object({
    status: z.enum([
      "NO_NATIVE_REPLAY_REQUIRED",
      "NO_OBVIOUS_GAP",
      "POSSIBLE_INCOMPATIBILITY",
      "UNKNOWN",
    ]),
  })
  .strict();
export type SessionContinuityPreflightResponse = z.infer<
  typeof SessionContinuityPreflightResponseSchema
>;
