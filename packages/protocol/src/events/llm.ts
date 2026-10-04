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
const RetryEventBaseSchema = z
  .object({
    attempt: z.number().int().positive().safe().max(10),
    maxAttempts: z.number().int().positive().safe().max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attempt > value.maxAttempts) {
      context.addIssue({ code: "custom", message: "attempt cannot exceed maxAttempts" });
    }
  });
export const RetryScheduledEventSchema = createEventSchema(
  "retry.scheduled",
  RetryEventBaseSchema.extend({
    delayMs: z.number().int().nonnegative().safe(),
    nextAttemptAt: z.number().int().nonnegative().safe(),
    errorCode: z.enum(["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"]),
  }).strict(),
);
export const RetryStartedEventSchema = createEventSchema("retry.started", RetryEventBaseSchema);
const RetryExhaustedPayloadSchema = z
  .object({
    attempt: z.number().int().positive().safe().max(10),
    maxAttempts: z.number().int().positive().safe().max(10),
    retriesUsed: z.number().int().nonnegative().safe().max(9),
    maxRetries: z.number().int().nonnegative().safe().max(9),
    errorCode: z.enum(["LLM_RATE_LIMIT", "LLM_NETWORK", "LLM_TIMEOUT"]),
    reason: z.enum([
      "ATTEMPTS_EXHAUSTED",
      "DEADLINE_EXCEEDED",
      "MAX_STEPS_REACHED",
      "RETRY_AFTER_EXCEEDS_POLICY",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attempt > value.maxAttempts) {
      context.addIssue({
        code: "custom",
        path: ["attempt"],
        message: "attempt cannot exceed maxAttempts",
      });
    }
    if (value.retriesUsed !== value.attempt - 1) {
      context.addIssue({
        code: "custom",
        path: ["retriesUsed"],
        message: "retriesUsed must equal attempt minus one",
      });
    }
    if (value.maxRetries !== value.maxAttempts - 1) {
      context.addIssue({
        code: "custom",
        path: ["maxRetries"],
        message: "maxRetries must equal maxAttempts minus one",
      });
    }
  });
export const RetryExhaustedEventSchema = createEventSchema(
  "retry.exhausted",
  RetryExhaustedPayloadSchema,
);
export const TransportFallbackSelectedEventSchema = createEventSchema(
  "transport.fallback.selected",
  RetryEventBaseSchema.extend({
    fromTransportId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    toTransportId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  })
    .strict()
    .superRefine((value, context) => {
      if (value.fromTransportId === value.toTransportId) {
        context.addIssue({
          code: "custom",
          path: ["toTransportId"],
          message: "fallback destination must differ from the source transport",
        });
      }
    }),
);

export type LlmStartedEvent = z.infer<typeof LlmStartedEventSchema>;
export type LlmCompletedEvent = z.infer<typeof LlmCompletedEventSchema>;
export type LlmFailedEvent = z.infer<typeof LlmFailedEventSchema>;
export type RetryScheduledEvent = z.infer<typeof RetryScheduledEventSchema>;
export type RetryStartedEvent = z.infer<typeof RetryStartedEventSchema>;
export type RetryExhaustedEvent = z.infer<typeof RetryExhaustedEventSchema>;
export type TransportFallbackSelectedEvent = z.infer<typeof TransportFallbackSelectedEventSchema>;
