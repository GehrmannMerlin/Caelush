import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    service: z.literal("caelush-daemon"),
    status: z.literal("ready"),
    apiVersion: z.literal("v1"),
    protocolVersion: z.literal(1),
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
