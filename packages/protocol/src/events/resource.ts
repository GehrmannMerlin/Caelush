import { z } from "zod";
import { createEventSchema } from "./base.js";

export const ResourceGuardEventSchema = createEventSchema(
  "resource.guard",
  z
    .object({
      reason: z.literal("NO_PROGRESS"),
      replanCount: z.number().int().nonnegative().safe().max(100),
      requestedToolCalls: z.number().int().positive().safe().max(128),
    })
    .strict(),
);

export type ResourceGuardEvent = z.infer<typeof ResourceGuardEventSchema>;
