import { JsonObjectSchema, ToolNameSchema } from "@caelush/protocol";
import { z } from "zod";

export const LLMToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: ToolNameSchema,
    input: JsonObjectSchema,
  })
  .strict();
export type LLMToolCall = z.infer<typeof LLMToolCallSchema>;

export const FinishReasonSchema = z.enum([
  "STOP",
  "LENGTH",
  "TOOL_CALLS",
  "CONTENT_FILTER",
  "OTHER",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;
