import { z } from "zod";

export const CapabilitySupportSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "UNKNOWN"]);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const LLMCapabilitiesSchema = z
  .object({
    textStreaming: CapabilitySupportSchema,
    toolCalling: CapabilitySupportSchema,
    parallelToolCalls: CapabilitySupportSchema,
    structuredOutput: CapabilitySupportSchema,
    vision: CapabilitySupportSchema,
    reasoningSummary: CapabilitySupportSchema,
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict();
export type LLMCapabilities = z.infer<typeof LLMCapabilitiesSchema>;
