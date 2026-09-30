import { z } from "zod";

/** Provider-independent reasoning semantics shared by daemon and Web. */
export const ReasoningLevelSchema = z.enum(["OFF", "MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

export const ClientModelSelectionSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ClientModelSelection = z.infer<typeof ClientModelSelectionSchema>;

/** A model identity plus an optional canonical reasoning selection. */
export const ClientModelSelectionWithReasoningSchema = ClientModelSelectionSchema.extend({
  reasoningLevel: ReasoningLevelSchema.optional(),
}).strict();
export type ClientModelSelectionWithReasoning = z.infer<
  typeof ClientModelSelectionWithReasoningSchema
>;
