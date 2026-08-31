import { z } from "zod";

export const ClientModelSelectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ClientModelSelection = z.infer<typeof ClientModelSelectionSchema>;
