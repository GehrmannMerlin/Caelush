import { z } from "zod";

export const ProcessStatusSchema = z.enum(["STARTING", "RUNNING", "EXITED", "FAILED", "KILLED"]);
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

export const ProcessSummarySchema = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    status: ProcessStatusSchema,
  })
  .strict();
export type ProcessSummary = z.infer<typeof ProcessSummarySchema>;
