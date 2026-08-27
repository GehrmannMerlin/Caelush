import { z } from "zod";

export const ModelRefSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;
