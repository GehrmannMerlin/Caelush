import { z } from "zod";
import { ModelRefSchema } from "../model.js";
import { AgentErrorSchema } from "../error.js";
import { UsageStateSchema } from "../usage.js";
import { createEventSchema } from "./base.js";

export const LlmStartedEventSchema = createEventSchema(
  "llm.started",
  z.object({ model: ModelRefSchema }).strict(),
);
export const LlmCompletedEventSchema = createEventSchema(
  "llm.completed",
  z.object({ model: ModelRefSchema, usage: UsageStateSchema }).strict(),
);
export const LlmFailedEventSchema = createEventSchema(
  "llm.failed",
  z.object({ model: ModelRefSchema, error: AgentErrorSchema }).strict(),
);
const RetryEventBaseSchema = z.object({
  attempt: z.number().int().positive().safe().max(10),
  maxAttempts: z.number().int().positive().safe().max(10),
});
export const RetryScheduledEventSchema = createEventSchema(
  "retry.scheduled",
  RetryEventBaseSchema.extend({
    delayMs: z.number().int().positive().safe(),
    nextAttemptAt: z.number().int().nonnegative().safe(),
    errorCode: z.enum(["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"]),
  }).strict(),
);
export const RetryStartedEventSchema = createEventSchema(
  "retry.started",
  RetryEventBaseSchema,
);

export type LlmStartedEvent = z.infer<typeof LlmStartedEventSchema>;
export type LlmCompletedEvent = z.infer<typeof LlmCompletedEventSchema>;
export type LlmFailedEvent = z.infer<typeof LlmFailedEventSchema>;
export type RetryScheduledEvent = z.infer<typeof RetryScheduledEventSchema>;
export type RetryStartedEvent = z.infer<typeof RetryStartedEventSchema>;
