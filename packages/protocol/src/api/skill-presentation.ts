import { z } from "zod";
import { RunStatusSchema } from "../run.js";
import { RunIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";
import {
  AssistantPresentationItemV2Schema,
  RunPresentationSummaryItemSchema,
  ToolPresentationItemV3Schema,
  TurnPresentationItemStatusSchema,
  UserPresentationItemSchema,
  VerificationPresentationItemSchema,
} from "./session-presentation.js";
import { SkillFailureReasonSchema, SkillIdSchema, SkillNameSchema } from "../skills.js";

export const SelectedSkillPresentationV1Schema = z
  .object({
    skillId: SkillIdSchema,
    name: SkillNameSchema,
    displayName: z.string().min(1).max(256).optional(),
  })
  .strict();
export type SelectedSkillPresentationV1 = z.infer<typeof SelectedSkillPresentationV1Schema>;

export const UserPresentationItemV4Schema = UserPresentationItemSchema.extend({
  selectedSkills: z.array(SelectedSkillPresentationV1Schema).max(4096).readonly(),
})
  .strict()
  .superRefine((item, context) => {
    const seen = new Set<string>();
    item.selectedSkills.forEach((skill, index) => {
      if (seen.has(skill.skillId)) {
        context.addIssue({
          code: "custom",
          path: ["selectedSkills", index, "skillId"],
          message: "A selected Skill may appear only once",
        });
      }
      seen.add(skill.skillId);
    });
  });
export type UserPresentationItemV4 = z.infer<typeof UserPresentationItemV4Schema>;

export const SkillPresentationStatusSchema = z.enum([
  "LOADING",
  "CONTENT_READY",
  "LOADED",
  "FAILED",
]);
export type SkillPresentationStatus = z.infer<typeof SkillPresentationStatusSchema>;

const PresentationItemBaseV4Schema = z
  .object({
    id: z.string().min(1).max(512),
    runId: RunIdSchema,
    conversationTurnId: z.string().min(1).max(512),
    ordinal: z.number().int().nonnegative().safe(),
    status: TurnPresentationItemStatusSchema,
    createdAt: TimestampMsSchema,
  })
  .strict();

export const SkillPresentationItemSchema = PresentationItemBaseV4Schema.extend({
  kind: z.literal("SKILL"),
  skillId: SkillIdSchema,
  name: SkillNameSchema,
  displayName: z.string().min(1).max(256).optional(),
  skillStatus: SkillPresentationStatusSchema,
  failureReason: SkillFailureReasonSchema.optional(),
})
  .strict()
  .superRefine((item, context) => {
    if (item.failureReason !== undefined && item.skillStatus !== "FAILED") {
      context.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "Only a failed Skill item may contain a failure reason",
      });
    }
  });
export type SkillPresentationItem = z.infer<typeof SkillPresentationItemSchema>;

export const TurnPresentationItemV4Schema = z.discriminatedUnion("kind", [
  UserPresentationItemV4Schema,
  AssistantPresentationItemV2Schema,
  ToolPresentationItemV3Schema,
  VerificationPresentationItemSchema,
  RunPresentationSummaryItemSchema,
  SkillPresentationItemSchema,
]);
export type TurnPresentationItemV4 = z.infer<typeof TurnPresentationItemV4Schema>;

export const SessionTurnPresentationTurnV4Schema = z
  .object({
    runId: RunIdSchema,
    conversationTurnId: z.string().min(1).max(512),
    runStatus: RunStatusSchema,
    openedAt: TimestampMsSchema,
    closedAt: TimestampMsSchema.optional(),
    highWatermark: z.number().int().nonnegative().safe(),
    items: z.array(TurnPresentationItemV4Schema).readonly(),
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
export type SessionTurnPresentationTurnV4 = z.infer<typeof SessionTurnPresentationTurnV4Schema>;

export const SessionTurnPresentationResponseV4Schema = z
  .object({
    capabilityVersion: z.literal(4),
    turns: z.array(SessionTurnPresentationTurnV4Schema).readonly(),
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
export type SessionTurnPresentationResponseV4 = z.infer<
  typeof SessionTurnPresentationResponseV4Schema
>;
