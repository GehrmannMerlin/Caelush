import { ModelRefSchema, ToolDefinitionSchema, ToolNameSchema } from "@caelush/protocol";
import { z } from "zod";
import { LLMMessageSchema } from "./messages.js";

export const LLMToolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("AUTO") }).strict(),
  z.object({ type: z.literal("NONE") }).strict(),
  z.object({ type: z.literal("REQUIRED") }).strict(),
  z.object({ type: z.literal("TOOL"), toolName: ToolNameSchema }).strict(),
]);
export type LLMToolChoice = z.infer<typeof LLMToolChoiceSchema>;

export const LLMRequestSchema = z
  .object({
    model: ModelRefSchema,
    messages: z.array(LLMMessageSchema),
    tools: z.array(ToolDefinitionSchema).optional(),
    toolChoice: LLMToolChoiceSchema.optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
  })
  .strict();
export type LLMRequest = z.infer<typeof LLMRequestSchema>;
