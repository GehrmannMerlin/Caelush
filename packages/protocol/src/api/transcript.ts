import { z } from "zod";

import { JsonObjectSchema } from "../primitives/json.js";
import { RunIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";

const transcriptTextSchema = z.string();

/** Provider-neutral intent of an assistant message in a durable conversation. */
export const AssistantMessagePhaseSchema = z.enum(["COMMENTARY", "FINAL_ANSWER", "UNKNOWN"]);
export type AssistantMessagePhase = z.infer<typeof AssistantMessagePhaseSchema>;

export const TranscriptAttachmentRefSchema = z
  .object({
    artifactId: z.string().min(1),
    label: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
  })
  .strict();
export type TranscriptAttachmentRef = z.infer<typeof TranscriptAttachmentRefSchema>;

export const TranscriptEntryBaseSchema = z
  .object({
    id: z.string().min(1),
    runId: RunIdSchema,
    conversationTurnId: z.string().min(1),
    createdAt: TimestampMsSchema,
  })
  .strict();
export type TranscriptEntryBase = z.infer<typeof TranscriptEntryBaseSchema>;

export const UserTranscriptEntrySchema = TranscriptEntryBaseSchema.extend({
  kind: z.literal("USER"),
  text: transcriptTextSchema,
  attachments: z.array(TranscriptAttachmentRefSchema).readonly().optional(),
}).strict();
export type UserTranscriptEntry = z.infer<typeof UserTranscriptEntrySchema>;

export const AssistantTranscriptEntrySchema = TranscriptEntryBaseSchema.extend({
  kind: z.literal("ASSISTANT"),
  phase: AssistantMessagePhaseSchema.default("UNKNOWN"),
  assistantItemId: z.string().min(1).max(512).optional(),
  text: transcriptTextSchema,
}).strict();
export type AssistantTranscriptEntry = z.infer<typeof AssistantTranscriptEntrySchema>;

export const ToolTranscriptEntrySchema = TranscriptEntryBaseSchema.extend({
  kind: z.literal("TOOL_RESULT"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  text: transcriptTextSchema,
  isError: z.boolean(),
}).strict();
export type ToolTranscriptEntry = z.infer<typeof ToolTranscriptEntrySchema>;

export const CustomTranscriptEntrySchema = TranscriptEntryBaseSchema.extend({
  kind: z.literal("CUSTOM"),
  presentationType: z.string().min(1),
  label: z.string().min(1),
  text: transcriptTextSchema,
  metadata: JsonObjectSchema.optional(),
}).strict();
export type CustomTranscriptEntry = z.infer<typeof CustomTranscriptEntrySchema>;

export const RunTerminalTranscriptEntrySchema = TranscriptEntryBaseSchema.extend({
  kind: z.literal("RUN_TERMINAL"),
  status: z.string().min(1),
  text: transcriptTextSchema,
}).strict();
export type RunTerminalTranscriptEntry = z.infer<typeof RunTerminalTranscriptEntrySchema>;

export const TranscriptEntrySchema = z.discriminatedUnion("kind", [
  UserTranscriptEntrySchema,
  AssistantTranscriptEntrySchema,
  ToolTranscriptEntrySchema,
  CustomTranscriptEntrySchema,
  RunTerminalTranscriptEntrySchema,
]);
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const SessionTranscriptQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type SessionTranscriptQuery = z.infer<typeof SessionTranscriptQuerySchema>;

export const SessionTranscriptResponseSchema = z
  .object({
    items: z.array(TranscriptEntrySchema).readonly(),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type SessionTranscriptResponse = z.infer<typeof SessionTranscriptResponseSchema>;
