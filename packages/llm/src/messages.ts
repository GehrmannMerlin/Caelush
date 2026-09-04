import { JsonObjectSchema, ToolNameSchema } from "@caelush/protocol";
import { z } from "zod";

export const LLMSystemMessageSchema = z
  .object({
    role: z.literal("system"),
    content: z.string(),
  })
  .strict();
export type LLMSystemMessage = z.infer<typeof LLMSystemMessageSchema>;

export const LLMUserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.string(),
  })
  .strict();
export type LLMUserMessage = z.infer<typeof LLMUserMessageSchema>;

const LLMAssistantTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const LLMAssistantToolCallPartSchema = z
  .object({
    type: z.literal("tool-call"),
    toolCallId: z.string().min(1),
    toolName: ToolNameSchema,
    input: JsonObjectSchema,
  })
  .strict();

export const LLMAssistantContentSchema = z.discriminatedUnion("type", [
  LLMAssistantTextPartSchema,
  LLMAssistantToolCallPartSchema,
]);
export type LLMAssistantContent = z.infer<typeof LLMAssistantContentSchema>;

export const LLMAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(LLMAssistantContentSchema).min(1),
  })
  .strict();
export type LLMAssistantMessage = z.infer<typeof LLMAssistantMessageSchema>;

export const LLMToolResultMessageSchema = z
  .object({
    role: z.literal("tool"),
    toolCallId: z.string().min(1),
    toolName: ToolNameSchema,
    content: z.string(),
    isError: z.boolean(),
    /** Opaque durable pointer used by Context Runtime recovery; provider adapters omit it. */
    rawArtifactRef: z.string().min(1).optional(),
  })
  .strict();
export type LLMToolResultMessage = z.infer<typeof LLMToolResultMessageSchema>;

export const LLMMessageSchema = z.discriminatedUnion("role", [
  LLMSystemMessageSchema,
  LLMUserMessageSchema,
  LLMAssistantMessageSchema,
  LLMToolResultMessageSchema,
]);
export type LLMMessage = z.infer<typeof LLMMessageSchema>;
