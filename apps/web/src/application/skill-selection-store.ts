import {
  AttachmentOwnerSchema,
  SubmissionIdSchema,
  type AttachmentOwner,
  type SubmissionId,
} from "@caelush/protocol";
import {
  ComposerSubmissionDraftSchema,
  createInitialSkillSubmissionState,
  reduceSkillSubmission,
  SkillSubmissionStateSchema,
  type ComposerSubmissionDraft,
  type SkillSubmissionState,
} from "./skill-submission-state.js";

export interface SkillSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class SkillSelectionOwnerConflictError extends Error {
  constructor() {
    super("The target composer already contains a Skill draft.");
    this.name = "SkillSelectionOwnerConflictError";
  }
}

export class SkillSelectionStore {
  private readonly memory = new Map<string, string>();
  private readonly storage: SkillSelectionStorage | undefined;

  constructor(
    storage: SkillSelectionStorage | undefined = browserStorage(),
    private readonly createId: () => SubmissionId = randomSubmissionId,
  ) {
    this.storage = storage;
  }

  load(owner: AttachmentOwner): SkillSubmissionState | undefined {
    const key = ownerKey(owner);
    let raw: string | null | undefined;
    try {
      raw = this.storage?.getItem(key) ?? this.memory.get(key) ?? null;
    } catch {
      raw = this.memory.get(key) ?? null;
    }
    if (raw === null || raw === undefined) return undefined;
    try {
      const state = SkillSubmissionStateSchema.parse(JSON.parse(raw));
      return state;
    } catch {
      this.remove(owner);
      return undefined;
    }
  }

  save(owner: AttachmentOwner, state: SkillSubmissionState): SkillSubmissionState {
    const key = ownerKey(owner);
    const safeState = SkillSubmissionStateSchema.parse(state);
    const serialized = JSON.stringify(safeState);
    this.memory.set(key, serialized);
    try {
      this.storage?.setItem(key, serialized);
    } catch {
      // Keep this window usable when the browser storage quota is unavailable.
    }
    return safeState;
  }

  prepareSubmission(
    owner: AttachmentOwner,
    draft: ComposerSubmissionDraft,
    submissionId?: SubmissionId,
  ): SkillSubmissionState {
    const parsedDraft = ComposerSubmissionDraftSchema.parse(draft);
    const current = this.load(owner) ?? createInitialSkillSubmissionState(parsedDraft);
    if (!sameDraft(current.draft, parsedDraft)) {
      throw new Error("The Skill submission draft changed before it was prepared.");
    }
    if (current.acceptedSubmission !== undefined) {
      throw new Error("The previous Skill submission is still waiting for preparation.");
    }
    const existing = current.pendingSubmission;
    if (existing !== undefined && sameDraft(existing.draft, parsedDraft)) {
      return this.save(
        owner,
        reduceSkillSubmission(current, {
          type: "SUBMISSION_STARTED",
          submissionId: existing.submissionId,
          draft: parsedDraft,
        }),
      );
    }
    const next = reduceSkillSubmission(current, {
      type: "SUBMISSION_STARTED",
      submissionId: submissionId ?? this.createId(),
      draft: parsedDraft,
    });
    return this.save(owner, next);
  }

  transfer(source: AttachmentOwner, target: AttachmentOwner): SkillSubmissionState | undefined {
    if (ownerKey(source) === ownerKey(target)) return this.load(source);
    const state = this.load(source);
    if (state === undefined) return undefined;
    const targetState = this.load(target);
    if (targetState !== undefined && hasDraftData(targetState)) {
      throw new SkillSelectionOwnerConflictError();
    }
    this.save(target, state);
    this.remove(source);
    return state;
  }

  remove(owner: AttachmentOwner): void {
    const key = ownerKey(owner);
    this.memory.delete(key);
    try {
      this.storage?.removeItem(key);
    } catch {
      // The in-memory copy is already removed.
    }
  }
}

function sameDraft(left: ComposerSubmissionDraft, right: ComposerSubmissionDraft): boolean {
  return (
    left.draftVersion === right.draftVersion &&
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

function hasDraftData(state: SkillSubmissionState): boolean {
  return (
    state.draft.draftVersion > 0 ||
    state.draft.userText.length > 0 ||
    state.draft.skillSelections.length > 0 ||
    state.draft.attachments.length > 0 ||
    state.pendingSubmission !== undefined ||
    state.acceptedSubmission !== undefined
  );
}

function ownerKey(owner: AttachmentOwner): string {
  const parsed = AttachmentOwnerSchema.parse(owner);
  return parsed.kind === "SESSION"
    ? `caelush.skill-submission.v1.session.${parsed.sessionId}`
    : `caelush.skill-submission.v1.workspace.${parsed.workspaceId}`;
}

function browserStorage(): SkillSelectionStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function randomSubmissionId(): SubmissionId {
  return SubmissionIdSchema.parse(crypto.randomUUID());
}
