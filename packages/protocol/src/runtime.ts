import { z } from "zod";

export const RuntimeRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
  })
  .strict();
export type RuntimeRef = z.infer<typeof RuntimeRefSchema>;
