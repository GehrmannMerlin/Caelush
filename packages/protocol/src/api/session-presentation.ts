import { z } from "zod";

import { AssistantMessagePhaseSchema } from "./transcript.js";
import { RunStatusSchema } from "../run.js";
import { RunIdSchema, StepIdSchema, ToolInvocationIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";
import { ToolNameSchema } from "../tool.js";

/** Display lifecycle for one stable item in a session turn feed. */
export const TurnPresentationItemStatusSchema = z.enum([
  "STREAMING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type TurnPresentationItemStatus = z.infer<typeof TurnPresentationItemStatusSchema>;

const PresentationItemBaseSchema = z
  .object({
    id: z.string().min(1).max(512),
    runId: RunIdSchema,
    conversationTurnId: z.string().min(1).max(512),
    ordinal: z.number().int().nonnegative().safe(),
    status: TurnPresentationItemStatusSchema,
    createdAt: TimestampMsSchema,
  })
  .strict();

export const UserPresentationItemSchema = PresentationItemBaseSchema.extend({
  kind: z.literal("USER"),
  text: z.string().max(64 * 1024),
}).strict();
export type UserPresentationItem = z.infer<typeof UserPresentationItemSchema>;

export const AssistantPresentationItemSchema = PresentationItemBaseSchema.extend({
  kind: z.literal("ASSISTANT"),
  phase: AssistantMessagePhaseSchema,
  text: z.string().max(64 * 1024),
}).strict();
export type AssistantPresentationItem = z.infer<typeof AssistantPresentationItemSchema>;

export const AssistantPresentationItemV2Schema = PresentationItemBaseSchema.extend({
  kind: z.literal("ASSISTANT"),
  phase: AssistantMessagePhaseSchema,
  text: z.string().max(64 * 1024),
  assistantItemId: z.string().min(1).max(512).optional(),
  sourceStepId: StepIdSchema.optional(),
}).strict();
export type AssistantPresentationItemV2 = z.infer<typeof AssistantPresentationItemV2Schema>;

export const PresentationSafeFactSchema = z
  .object({
    key: z.string().min(1).max(64),
    value: z.string().max(512),
  })
  .strict();
export type PresentationSafeFact = z.infer<typeof PresentationSafeFactSchema>;

export const ToolPresentationItemSchema = PresentationItemBaseSchema.extend({
  kind: z.literal("TOOL"),
  toolInvocationId: ToolInvocationIdSchema,
  toolName: ToolNameSchema,
  title: z.string().min(1).max(256),
  summary: z.string().max(1024),
  facts: z.array(PresentationSafeFactSchema).max(16),
  preview: z.string().max(8192).optional(),
}).strict();
export type ToolPresentationItem = z.infer<typeof ToolPresentationItemSchema>;

export const VerificationPresentationItemSchema = PresentationItemBaseSchema.extend({
  kind: z.literal("VERIFICATION"),
  verificationId: z.string().min(1).max(512),
  title: z.string().min(1).max(256),
  summary: z.string().max(1024),
  evidence: z.string().max(8192).optional(),
}).strict();
export type VerificationPresentationItem = z.infer<typeof VerificationPresentationItemSchema>;

export const RunPresentationSummaryItemSchema = PresentationItemBaseSchema.extend({
  kind: z.literal("RUN_SUMMARY"),
  runStatus: RunStatusSchema,
  text: z.string().max(8192),
}).strict();
export type RunPresentationSummaryItem = z.infer<typeof RunPresentationSummaryItemSchema>;

export const TurnPresentationItemSchema = z.discriminatedUnion("kind", [
  UserPresentationItemSchema,
  AssistantPresentationItemSchema,
  ToolPresentationItemSchema,
  VerificationPresentationItemSchema,
  RunPresentationSummaryItemSchema,
]);
export type TurnPresentationItem = z.infer<typeof TurnPresentationItemSchema>;

export const TurnPresentationItemV2Schema = z.discriminatedUnion("kind", [
  UserPresentationItemSchema,
  AssistantPresentationItemV2Schema,
  ToolPresentationItemSchema,
  VerificationPresentationItemSchema,
  RunPresentationSummaryItemSchema,
]);
export type TurnPresentationItemV2 = z.infer<typeof TurnPresentationItemV2Schema>;

export const SessionTurnPresentationQuerySchema = z
  .object({
    runId: RunIdSchema.optional(),
    /** Maximum Turns in a V3 page; V1/V2 readers retain their historical item-page meaning. */
    limit: z.coerce.number().int().min(1).max(100).default(100),
    /** V3 treats this as the last included Run id; V1/V2 retain their historical item cursor. */
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type SessionTurnPresentationQuery = z.infer<typeof SessionTurnPresentationQuerySchema>;

export const SessionTurnPresentationResponseV1Schema = z
  .object({
    capabilityVersion: z.literal(1).default(1),
    items: z.array(TurnPresentationItemSchema).readonly(),
    highWatermark: z.number().int().nonnegative().safe(),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type SessionTurnPresentationResponseV1 = z.infer<
  typeof SessionTurnPresentationResponseV1Schema
>;

export const SessionTurnPresentationResponseV2Schema = z
  .object({
    capabilityVersion: z.literal(2),
    items: z.array(TurnPresentationItemV2Schema).readonly(),
    highWatermark: z.number().int().nonnegative().safe(),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type SessionTurnPresentationResponseV2 = z.infer<
  typeof SessionTurnPresentationResponseV2Schema
>;

/** One Run's complete Session presentation boundary. Ordinals and event coverage are Run-local. */
export const SessionTurnPresentationTurnV3Schema = z
  .object({
    runId: RunIdSchema,
    conversationTurnId: z.string().min(1).max(512),
    runStatus: RunStatusSchema,
    openedAt: TimestampMsSchema,
    closedAt: TimestampMsSchema.optional(),
    /** Durable RunEvent high-watermark, scoped to `runId`. */
    highWatermark: z.number().int().nonnegative().safe(),
    /** Complete Turn contents; a V3 page never cuts this array across page boundaries. */
    items: z.array(TurnPresentationItemV2Schema).readonly(),
  })
  .strict()
  .superRefine((turn, context) => {
    turn.items.forEach((item, index) => {
      if (item.runId !== turn.runId) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "runId"],
          message: "Presentation item must belong to its owning Run",
        });
      }
      if (item.conversationTurnId !== turn.conversationTurnId) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "conversationTurnId"],
          message: "Presentation item must belong to its owning ConversationTurn",
        });
      }
      if (item.ordinal !== index) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "ordinal"],
          message: "Presentation ordinals must be contiguous and Turn-local",
        });
      }
    });
  });
export type SessionTurnPresentationTurnV3 = z.infer<typeof SessionTurnPresentationTurnV3Schema>;

export const SessionTurnPresentationResponseV3Schema = z
  .object({
    capabilityVersion: z.literal(3),
    turns: z.array(SessionTurnPresentationTurnV3Schema).readonly(),
    /** V3 cursor is the last Run id included in the previous page. */
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const seenRuns = new Set<string>();
    const seenTurns = new Set<string>();
    response.turns.forEach((turn, index) => {
      if (seenRuns.has(turn.runId)) {
        context.addIssue({
          code: "custom",
          path: ["turns", index, "runId"],
          message: "A Run may appear only once in a Session presentation page",
        });
      }
      if (seenTurns.has(turn.conversationTurnId)) {
        context.addIssue({
          code: "custom",
          path: ["turns", index, "conversationTurnId"],
          message: "A ConversationTurn may appear only once in a Session presentation page",
        });
      }
      seenRuns.add(turn.runId);
      seenTurns.add(turn.conversationTurnId);
      const previous = response.turns[index - 1];
      if (
        previous !== undefined &&
        (previous.openedAt > turn.openedAt ||
          (previous.openedAt === turn.openedAt && previous.runId >= turn.runId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["turns", index],
          message: "Session presentation Turns must use canonical Run ordering",
        });
      }
    });
  });
export type SessionTurnPresentationResponseV3 = z.infer<
  typeof SessionTurnPresentationResponseV3Schema
>;

export const SessionTurnPresentationResponseSchema = z.union([
  SessionTurnPresentationResponseV1Schema,
  SessionTurnPresentationResponseV2Schema,
  SessionTurnPresentationResponseV3Schema,
]);
export type SessionTurnPresentationResponse = z.infer<typeof SessionTurnPresentationResponseSchema>;
