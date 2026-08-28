import { LLMCallIdSchema, ModelRefSchema } from "@caelush/protocol";
import { z } from "zod";
import { FinishReasonSchema } from "./tool-call.js";
import { LLMToolCallSchema } from "./tool-call.js";
import { LLMUsageSchema } from "./usage.js";

export const LLMTurnResultSchema = z
  .object({
    callId: LLMCallIdSchema,
    providerId: z.string().min(1),
    model: ModelRefSchema,
    text: z.string(),
    toolCalls: z.array(LLMToolCallSchema),
    finishReason: FinishReasonSchema,
    usage: LLMUsageSchema.optional(),
  })
  .strict();
export type LLMTurnResult = z.infer<typeof LLMTurnResultSchema>;
