import {
  LLMCallIdSchema,
  ModelRefSchema,
  ToolNameSchema,
} from "@caelush/protocol";
import { z } from "zod";
import { FinishReasonSchema } from "./tool-call.js";
import { LLMToolCallSchema } from "./tool-call.js";
import { LLMUsageSchema } from "./usage.js";

const providerIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

const streamStartEventSchema = z
  .object({
    type: z.literal("stream.start"),
    payload: z
      .object({
        callId: LLMCallIdSchema,
        providerId: providerIdSchema,
        model: ModelRefSchema,
      })
      .strict(),
  })
  .strict();

const textDeltaEventSchema = z
  .object({
    type: z.literal("text.delta"),
    payload: z.object({ text: z.string().min(1) }).strict(),
  })
  .strict();

const toolCallStartEventSchema = z
  .object({
    type: z.literal("tool_call.start"),
    payload: z
      .object({
        toolCallId: z.string().min(1),
        toolName: ToolNameSchema,
      })
      .strict(),
  })
  .strict();

const toolCallDeltaEventSchema = z
  .object({
    type: z.literal("tool_call.delta"),
    payload: z.object({ toolCallId: z.string().min(1), delta: z.string() }).strict(),
  })
  .strict();

const toolCallCompletedEventSchema = z
  .object({
    type: z.literal("tool_call.completed"),
    payload: LLMToolCallSchema,
  })
  .strict();

const usageEventSchema = z
  .object({
    type: z.literal("usage"),
    payload: LLMUsageSchema,
  })
  .strict();

const streamFinishEventSchema = z
  .object({
    type: z.literal("stream.finish"),
    payload: z
      .object({
        finishReason: FinishReasonSchema,
        finalUsage: LLMUsageSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const LLMStreamEventSchema = z.discriminatedUnion("type", [
  streamStartEventSchema,
  textDeltaEventSchema,
  toolCallStartEventSchema,
  toolCallDeltaEventSchema,
  toolCallCompletedEventSchema,
  usageEventSchema,
  streamFinishEventSchema,
]);
export type LLMStreamEvent = z.infer<typeof LLMStreamEventSchema>;
