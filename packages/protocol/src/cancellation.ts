import { z } from "zod";
import { RunIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

export const RunCancellationCauseSchema = z.literal("USER_REQUESTED");
export type RunCancellationCause = z.infer<typeof RunCancellationCauseSchema>;

export const RunCancellationIntentSchema = z
  .object({
    runId: RunIdSchema,
    cause: RunCancellationCauseSchema,
    requestedAt: TimestampMsSchema,
  })
  .strict();
export type RunCancellationIntent = z.infer<typeof RunCancellationIntentSchema>;
