import { z } from "zod";
import {
  AttachmentIdSchema,
  RunIdSchema,
  SubmissionIdSchema,
  SkillSelectionV1Schema,
  type AttachmentId,
  type RunId,
  type SubmissionId,
  type SkillSelectionV1,
  type SessionTurnPresentationTurnV4,
  type SubmissionSkillPreparationV1,
} from "@caelush/protocol";

export const ComposerSubmissionDraftSchema = z
  .object({
    draftVersion: z.number().int().nonnegative().safe(),
    userText: z.string().max(200_000),
    skillSelections: z.array(SkillSelectionV1Schema).max(4096).readonly(),
    attachments: z.array(AttachmentIdSchema).max(10).readonly(),
  })
  .strict()
  .superRefine((draft, context) => {
    if (new TextEncoder().encode(JSON.stringify(draft.skillSelections)).byteLength > 64 * 1024) {
      context.addIssue({
        code: "custom",
        path: ["skillSelections"],
        message: "Skill selections exceed the Run request limit.",
      });
    }
    const seen = new Set<string>();
    draft.skillSelections.forEach((selection, index) => {
      if (seen.has(selection.skillId)) {
        context.addIssue({
          code: "custom",
          path: ["skillSelections", index, "skillId"],
          message: "A Skill may be selected only once.",
        });
      }
      seen.add(selection.skillId);
    });
  });
export type ComposerSubmissionDraft = z.infer<typeof ComposerSubmissionDraftSchema>;

export interface SubmissionAccepted {
  readonly runId: RunId;
  readonly submissionId: SubmissionId;
  readonly draftVersion: number;
}

export const SkillPreparationStatusSchema = z.enum([
  "IDLE",
  "SUBMITTING",
  "ACCEPTED",
  "PREPARED",
  "FAILED",
]);
export type SkillPreparationStatus = z.infer<typeof SkillPreparationStatusSchema>;

const PendingSkillSubmissionSchema = z
  .object({ submissionId: SubmissionIdSchema, draft: ComposerSubmissionDraftSchema })
  .strict();
const AcceptedSkillSubmissionSchema = z
  .object({
    runId: RunIdSchema,
    submissionId: SubmissionIdSchema,
    draftVersion: z.number().int().nonnegative().safe(),
    draft: ComposerSubmissionDraftSchema,
  })
  .strict();

export const SkillSubmissionStateSchema = z
  .object({
    draft: ComposerSubmissionDraftSchema,
    preparationStatus: SkillPreparationStatusSchema,
    pendingSubmission: PendingSkillSubmissionSchema.optional(),
    acceptedSubmission: AcceptedSkillSubmissionSchema.optional(),
  })
  .strict();
export type SkillSubmissionState = z.infer<typeof SkillSubmissionStateSchema>;

export type SkillSubmissionEvent =
  | {
      readonly type: "DRAFT_CHANGED";
      readonly userText: string;
      readonly skillSelections: readonly SkillSelectionV1[];
      readonly attachments: readonly AttachmentId[];
    }
  | {
      readonly type: "SUBMISSION_STARTED";
      readonly submissionId: SubmissionId;
      readonly draft: ComposerSubmissionDraft;
    }
  | {
      readonly type: "SUBMISSION_ACCEPTED";
      readonly runId: RunId;
      readonly submissionId: SubmissionId;
    }
  | { readonly type: "SUBMISSION_FAILED"; readonly submissionId: SubmissionId }
  | {
      readonly type: "PREPARED_INPUT_RECEIVED";
      readonly runId: RunId;
      readonly submissionId: SubmissionId;
      readonly draftVersion: number;
    }
  | {
      readonly type: "PREPARATION_FAILED";
      readonly runId: RunId;
      readonly submissionId: SubmissionId;
      readonly draftVersion: number;
    };

export function createInitialSkillSubmissionState(
  draft: ComposerSubmissionDraft = {
    draftVersion: 0,
    userText: "",
    skillSelections: [],
    attachments: [],
  },
): SkillSubmissionState {
  return freezeState({ draft, preparationStatus: "IDLE" });
}

export function reduceSkillSubmission(
  current: SkillSubmissionState,
  event: SkillSubmissionEvent,
): SkillSubmissionState {
  const state = SkillSubmissionStateSchema.parse(current);
  switch (event.type) {
    case "DRAFT_CHANGED": {
      const candidate = ComposerSubmissionDraftSchema.parse({
        draftVersion: state.draft.draftVersion + 1,
        userText: event.userText,
        skillSelections: event.skillSelections,
        attachments: event.attachments,
      });
      if (sameDraftContent(state.draft, candidate)) return current;
      return freezeState({
        ...state,
        draft: candidate,
        preparationStatus:
          state.pendingSubmission !== undefined || state.acceptedSubmission !== undefined
            ? state.preparationStatus
            : "IDLE",
      });
    }
    case "SUBMISSION_STARTED": {
      const draft = ComposerSubmissionDraftSchema.parse(event.draft);
      if (
        state.acceptedSubmission !== undefined ||
        draft.draftVersion !== state.draft.draftVersion ||
        !sameDraftContent(draft, state.draft)
      ) {
        return state;
      }
      return freezeState({
        ...state,
        pendingSubmission: { submissionId: event.submissionId, draft },
        preparationStatus: "SUBMITTING",
      });
    }
    case "SUBMISSION_ACCEPTED": {
      const pending = state.pendingSubmission;
      if (pending === undefined || pending.submissionId !== event.submissionId) return state;
      return freezeState({
        draft: state.draft,
        acceptedSubmission: {
          runId: event.runId,
          submissionId: event.submissionId,
          draftVersion: pending.draft.draftVersion,
          draft: pending.draft,
        },
        preparationStatus: "ACCEPTED",
      });
    }
    case "SUBMISSION_FAILED": {
      if (state.pendingSubmission?.submissionId !== event.submissionId) return state;
      return freezeState({ ...state, preparationStatus: "FAILED" });
    }
    case "PREPARED_INPUT_RECEIVED": {
      const accepted = matchingAcceptedSubmission(state, event);
      if (accepted === undefined) return state;
      const draft =
        state.draft.draftVersion === event.draftVersion
          ? emptyDraft(state.draft.draftVersion + 1)
          : state.draft;
      return freezeState({ draft, preparationStatus: "PREPARED" });
    }
    case "PREPARATION_FAILED": {
      if (matchingAcceptedSubmission(state, event) === undefined) return state;
      if (state.preparationStatus === "FAILED") return current;
      return freezeState({ draft: state.draft, preparationStatus: "FAILED" });
    }
  }
}

/** `CONTENT_READY` proves the binding was frozen; only V4's durable LOADED fact confirms Context
 * recorded every selected manual Skill in a concrete PreparedInput Step. */
export function hasSubmissionSkillLoadReceipt(
  accepted: NonNullable<SkillSubmissionState["acceptedSubmission"]>,
  receipt: SubmissionSkillPreparationV1 | undefined,
  turn: SessionTurnPresentationTurnV4 | undefined,
): boolean {
  if (
    receipt === undefined ||
    turn?.runId !== accepted.runId ||
    receipt.runId !== accepted.runId ||
    receipt.userText !== accepted.draft.userText.trim()
  ) {
    return false;
  }
  const expectedSkillIds = accepted.draft.skillSelections.map((selection) => selection.skillId);
  const receiptSkillIds = receipt.selectedSkills.map((skill) => skill.skillId);
  if (expectedSkillIds.length === 0 || !sameSkillIds(expectedSkillIds, receiptSkillIds))
    return false;
  return expectedSkillIds.every((skillId) =>
    turn.items.some(
      (item) =>
        item.kind === "SKILL" &&
        item.id === `${accepted.runId}:skill:${skillId}` &&
        item.skillStatus === "LOADED",
    ),
  );
}

export function hasSubmissionSkillLoadFailure(
  runId: RunId,
  skillIds: readonly string[],
  turn: SessionTurnPresentationTurnV4 | undefined,
): boolean {
  if (turn?.runId !== runId) return false;
  return skillIds.some((skillId) =>
    turn.items.some(
      (item) =>
        item.kind === "SKILL" &&
        item.id === `${runId}:skill:${skillId}` &&
        item.skillStatus === "FAILED",
    ),
  );
}

export function shouldSuppressStaleReceiptDraftMirror(
  suppressionOwnerKey: string,
  currentOwnerKey: string,
  currentDraft: Pick<ComposerSubmissionDraft, "userText" | "attachments">,
  attachmentDraft: Pick<ComposerSubmissionDraft, "userText" | "attachments">,
  submittedDraft: Pick<ComposerSubmissionDraft, "userText" | "attachments">,
): boolean {
  return (
    suppressionOwnerKey === currentOwnerKey &&
    sameDraftTextAndAttachments(attachmentDraft, submittedDraft) &&
    !sameDraftTextAndAttachments(currentDraft, submittedDraft)
  );
}

export function transitionSkillSubmission(
  current: SkillSubmissionState,
  event: SkillSubmissionEvent,
  onChanged: (next: SkillSubmissionState) => SkillSubmissionState,
): SkillSubmissionState {
  const next = reduceSkillSubmission(current, event);
  return next === current ? current : onChanged(next);
}

function matchingAcceptedSubmission(
  state: SkillSubmissionState,
  receipt: {
    readonly runId: RunId;
    readonly submissionId: SubmissionId;
    readonly draftVersion: number;
  },
) {
  const accepted = state.acceptedSubmission;
  return accepted?.runId === receipt.runId &&
    accepted.submissionId === receipt.submissionId &&
    accepted.draftVersion === receipt.draftVersion
    ? accepted
    : undefined;
}

function sameDraftContent(left: ComposerSubmissionDraft, right: ComposerSubmissionDraft): boolean {
  return (
    left.userText === right.userText &&
    left.skillSelections.length === right.skillSelections.length &&
    left.skillSelections.every(
      (selection, index) =>
        selection.skillId === right.skillSelections[index]?.skillId &&
        selection.selectionToken === right.skillSelections[index]?.selectionToken,
    ) &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((id, index) => id === right.attachments[index])
  );
}

function sameSkillIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((skillId, index) => skillId === right[index]);
}

function sameDraftTextAndAttachments(
  left: Pick<ComposerSubmissionDraft, "userText" | "attachments">,
  right: Pick<ComposerSubmissionDraft, "userText" | "attachments">,
): boolean {
  return left.userText === right.userText && sameIds(left.attachments, right.attachments);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function emptyDraft(draftVersion: number): ComposerSubmissionDraft {
  return { draftVersion, userText: "", skillSelections: [], attachments: [] };
}

function freezeState(state: SkillSubmissionState): SkillSubmissionState {
  const draft = freezeDraft(state.draft);
  return Object.freeze({
    draft,
    preparationStatus: state.preparationStatus,
    ...(state.pendingSubmission === undefined
      ? {}
      : {
          pendingSubmission: Object.freeze({
            submissionId: state.pendingSubmission.submissionId,
            draft: freezeDraft(state.pendingSubmission.draft),
          }),
        }),
    ...(state.acceptedSubmission === undefined
      ? {}
      : {
          acceptedSubmission: Object.freeze({
            ...state.acceptedSubmission,
            draft: freezeDraft(state.acceptedSubmission.draft),
          }),
        }),
  });
}

function freezeDraft(draft: ComposerSubmissionDraft): ComposerSubmissionDraft {
  const parsed = ComposerSubmissionDraftSchema.parse(draft);
  return Object.freeze({
    ...parsed,
    skillSelections: Object.freeze(
      parsed.skillSelections.map((selection) => Object.freeze(selection)),
    ),
    attachments: Object.freeze([...parsed.attachments]),
  });
}
