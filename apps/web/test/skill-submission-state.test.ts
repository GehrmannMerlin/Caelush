import { describe, expect, it } from "vitest";
import {
  SubmissionIdSchema,
  createSessionId,
  createWorkspaceId,
  createRunId,
  type SkillSelectionV1,
} from "@caelush/protocol";
import { SkillSelectionStore } from "../src/application/skill-selection-store.js";
import {
  createInitialSkillSubmissionState,
  hasSubmissionSkillLoadFailure,
  hasSubmissionSkillLoadReceipt,
  reduceSkillSubmission,
  shouldSuppressStaleReceiptDraftMirror,
  transitionSkillSubmission,
  type ComposerSubmissionDraft,
} from "../src/application/skill-submission-state.js";

const olderSubmissionId = SubmissionIdSchema.parse("018f6f31-a987-7abc-9def-0123456789ab");
const currentSubmissionId = SubmissionIdSchema.parse("018f6f31-a987-7abc-9def-0123456789ac");
const olderRunId = createRunId();
const skillSelection: SkillSelectionV1 = {
  skillId: "user:review-notes",
  selectionToken: "selection-token-1",
};

function draft(overrides: Partial<ComposerSubmissionDraft> = {}): ComposerSubmissionDraft {
  return {
    draftVersion: 1,
    userText: "Review this change.",
    skillSelections: [skillSelection],
    attachments: [],
    ...overrides,
  };
}

describe("Skill submission state", () => {
  it("does not publish or persist a draft transition when the draft is unchanged", () => {
    const current = createInitialSkillSubmissionState(draft());
    let changes = 0;

    const next = transitionSkillSubmission(
      current,
      {
        type: "DRAFT_CHANGED",
        userText: current.draft.userText,
        skillSelections: current.draft.skillSelections,
        attachments: current.draft.attachments,
      },
      () => {
        changes += 1;
        return current;
      },
    );

    expect(next).toBe(current);
    expect(changes).toBe(0);
  });

  it("U04 never clears a newer draft on an older preparation receipt", () => {
    const latestDraft = draft({ draftVersion: 2, userText: "Keep this newer instruction." });
    const before = {
      ...createInitialSkillSubmissionState(latestDraft),
      acceptedSubmission: {
        runId: olderRunId,
        submissionId: olderSubmissionId,
        draftVersion: 1,
        draft: draft(),
      },
      preparationStatus: "ACCEPTED" as const,
    };

    const next = reduceSkillSubmission(before, {
      type: "PREPARED_INPUT_RECEIVED",
      runId: olderRunId,
      submissionId: olderSubmissionId,
      draftVersion: 1,
    });

    expect(before.draft.draftVersion).toBe(2);
    expect(next.draft).toEqual(before.draft);
  });

  it("keeps the accepted draft until its matching preparation receipt arrives", () => {
    const submitted = draft();
    const before = createInitialSkillSubmissionState(submitted);
    const pending = reduceSkillSubmission(before, {
      type: "SUBMISSION_STARTED",
      submissionId: currentSubmissionId,
      draft: submitted,
    });
    const accepted = reduceSkillSubmission(pending, {
      type: "SUBMISSION_ACCEPTED",
      runId: olderRunId,
      submissionId: currentSubmissionId,
    });

    expect(accepted.draft).toEqual(submitted);
    expect(accepted.preparationStatus).toBe("ACCEPTED");
    expect(accepted.acceptedSubmission).toMatchObject({
      runId: olderRunId,
      submissionId: currentSubmissionId,
      draftVersion: submitted.draftVersion,
    });
  });

  it("clears exactly the submitted draft version on its first matching receipt", () => {
    const submitted = draft();
    const pending = reduceSkillSubmission(createInitialSkillSubmissionState(submitted), {
      type: "SUBMISSION_STARTED",
      submissionId: currentSubmissionId,
      draft: submitted,
    });
    const accepted = reduceSkillSubmission(pending, {
      type: "SUBMISSION_ACCEPTED",
      runId: olderRunId,
      submissionId: currentSubmissionId,
    });

    const prepared = reduceSkillSubmission(accepted, {
      type: "PREPARED_INPUT_RECEIVED",
      runId: olderRunId,
      submissionId: currentSubmissionId,
      draftVersion: submitted.draftVersion,
    });

    expect(prepared.draft).toEqual({
      draftVersion: submitted.draftVersion + 1,
      userText: "",
      skillSelections: [],
      attachments: [],
    });
    expect(prepared.preparationStatus).toBe("PREPARED");
    expect(prepared.acceptedSubmission).toBeUndefined();
  });

  it("does not treat CONTENT_READY as a prepared-input receipt", () => {
    const submitted = draft();
    const pending = reduceSkillSubmission(createInitialSkillSubmissionState(submitted), {
      type: "SUBMISSION_STARTED",
      submissionId: currentSubmissionId,
      draft: submitted,
    });
    const accepted = reduceSkillSubmission(pending, {
      type: "SUBMISSION_ACCEPTED",
      runId: olderRunId,
      submissionId: currentSubmissionId,
    });
    const contentReadyTurn = skillTurn("CONTENT_READY").turns[0]!;
    const contentReadyReceipt = {
      schemaVersion: 1 as const,
      runId: olderRunId,
      userText: submitted.userText,
      preparationStatus: "CONTENT_READY" as const,
      selectedSkills: [{ skillId: skillSelection.skillId as never, name: "review-notes" }],
    };

    expect(
      hasSubmissionSkillLoadReceipt(
        accepted.acceptedSubmission!,
        contentReadyReceipt,
        contentReadyTurn,
      ),
    ).toBe(false);
    const afterContentReady = hasSubmissionSkillLoadReceipt(
      accepted.acceptedSubmission!,
      contentReadyReceipt,
      contentReadyTurn,
    )
      ? reduceSkillSubmission(accepted, {
          type: "PREPARED_INPUT_RECEIVED",
          runId: olderRunId,
          submissionId: currentSubmissionId,
          draftVersion: submitted.draftVersion,
        })
      : accepted;
    expect(afterContentReady.draft).toEqual(submitted);
    expect(
      hasSubmissionSkillLoadFailure(olderRunId, [skillSelection.skillId], contentReadyTurn),
    ).toBe(false);
  });

  it("suppresses only the stale attachment mirror while receipt cleanup is reconciling", () => {
    const staleDraft = { userText: "submitted text", attachments: ["artifact_stale"] };
    const newerDraft = {
      userText: "new text typed during cleanup",
      attachments: ["artifact_stale"],
    };

    expect(
      shouldSuppressStaleReceiptDraftMirror(
        "session:one",
        "session:one",
        newerDraft,
        staleDraft,
        staleDraft,
      ),
    ).toBe(true);
    expect(
      shouldSuppressStaleReceiptDraftMirror(
        "session:one",
        "session:one",
        newerDraft,
        newerDraft,
        staleDraft,
      ),
    ).toBe(false);
    expect(
      shouldSuppressStaleReceiptDraftMirror(
        "session:one",
        "session:two",
        newerDraft,
        staleDraft,
        staleDraft,
      ),
    ).toBe(false);
  });

  it("confirms only a matching V4 LOADED binding and recognizes preparation failure", () => {
    const submitted = draft();
    const pending = reduceSkillSubmission(createInitialSkillSubmissionState(submitted), {
      type: "SUBMISSION_STARTED",
      submissionId: currentSubmissionId,
      draft: submitted,
    });
    const accepted = reduceSkillSubmission(pending, {
      type: "SUBMISSION_ACCEPTED",
      runId: olderRunId,
      submissionId: currentSubmissionId,
    });
    const receipt = {
      schemaVersion: 1 as const,
      runId: olderRunId,
      userText: submitted.userText,
      preparationStatus: "CONTENT_READY" as const,
      selectedSkills: [{ skillId: skillSelection.skillId as never, name: "review-notes" }],
    };
    const loadedTurn = skillTurn("LOADED").turns[0]!;
    const failedTurn = skillTurn("FAILED").turns[0]!;

    expect(hasSubmissionSkillLoadReceipt(accepted.acceptedSubmission!, receipt, loadedTurn)).toBe(
      true,
    );
    expect(hasSubmissionSkillLoadReceipt(accepted.acceptedSubmission!, receipt, failedTurn)).toBe(
      false,
    );
    expect(hasSubmissionSkillLoadFailure(olderRunId, [skillSelection.skillId], failedTurn)).toBe(
      true,
    );
    expect(
      reduceSkillSubmission(accepted, {
        type: "PREPARED_INPUT_RECEIVED",
        runId: olderRunId,
        submissionId: currentSubmissionId,
        draftVersion: submitted.draftVersion,
      }).draft.userText,
    ).toBe("");
  });

  it("preserves text, attachments, and Skills when submission or preparation fails", () => {
    const submitted = draft();
    const pending = reduceSkillSubmission(createInitialSkillSubmissionState(submitted), {
      type: "SUBMISSION_STARTED",
      submissionId: currentSubmissionId,
      draft: submitted,
    });
    const failed = reduceSkillSubmission(pending, {
      type: "SUBMISSION_FAILED",
      submissionId: currentSubmissionId,
    });

    expect(failed.draft).toEqual(submitted);
    expect(failed.preparationStatus).toBe("FAILED");
  });

  it("allows a new submission after preparation failure without changing the retained draft", () => {
    let nextId = currentSubmissionId;
    const store = new SkillSelectionStore(new MemoryStorage(), () => nextId);
    const owner = { kind: "WORKSPACE" as const, workspaceId: createWorkspaceId() };
    const submitted = draft();
    const pending = store.prepareSubmission(owner, submitted);
    const accepted = reduceSkillSubmission(pending, {
      type: "SUBMISSION_ACCEPTED",
      runId: olderRunId,
      submissionId: pending.pendingSubmission!.submissionId,
    });
    const failed = reduceSkillSubmission(accepted, {
      type: "PREPARATION_FAILED",
      runId: olderRunId,
      submissionId: pending.pendingSubmission!.submissionId,
      draftVersion: submitted.draftVersion,
    });
    store.save(owner, failed);
    nextId = olderSubmissionId;

    const retry = store.prepareSubmission(owner, submitted);

    expect(retry.draft).toEqual(submitted);
    expect(retry.pendingSubmission?.submissionId).toBe(olderSubmissionId);
    expect(retry.pendingSubmission?.submissionId).not.toBe(pending.pendingSubmission?.submissionId);
  });

  it("reuses the submission ID for an exact retry and rotates it when a Skill token changes", () => {
    const store = new SkillSelectionStore(new MemoryStorage());
    const owner = { kind: "WORKSPACE" as const, workspaceId: createWorkspaceId() };
    const submitted = draft();
    const first = store.prepareSubmission(owner, submitted);
    const retry = store.prepareSubmission(owner, submitted);
    const failed = reduceSkillSubmission(first, {
      type: "SUBMISSION_FAILED",
      submissionId: first.pendingSubmission!.submissionId,
    });
    store.save(owner, failed);
    const networkRetry = store.prepareSubmission(owner, submitted);
    const edited = reduceSkillSubmission(first, {
      type: "DRAFT_CHANGED",
      userText: submitted.userText,
      skillSelections: [{ ...skillSelection, selectionToken: "selection-token-2" }],
      attachments: submitted.attachments,
    });
    store.save(owner, edited);
    const changed = store.prepareSubmission(owner, edited.draft);

    expect(retry.pendingSubmission?.submissionId).toBe(first.pendingSubmission?.submissionId);
    expect(networkRetry.pendingSubmission?.submissionId).toBe(
      first.pendingSubmission?.submissionId,
    );
    expect(networkRetry.preparationStatus).toBe("SUBMITTING");
    expect(changed.pendingSubmission?.submissionId).not.toBe(first.pendingSubmission?.submissionId);
  });

  it("recovers accepted submissions and isolates their workspace and Session drafts", () => {
    const storage = new MemoryStorage();
    const firstStore = new SkillSelectionStore(storage);
    const workspaceOwner = { kind: "WORKSPACE" as const, workspaceId: createWorkspaceId() };
    const sessionOwner = { kind: "SESSION" as const, sessionId: createSessionId() };
    const pending = firstStore.prepareSubmission(workspaceOwner, draft());
    const accepted = reduceSkillSubmission(pending, {
      type: "SUBMISSION_ACCEPTED",
      runId: olderRunId,
      submissionId: pending.pendingSubmission!.submissionId,
    });
    firstStore.save(workspaceOwner, accepted);

    const recovered = new SkillSelectionStore(storage).load(workspaceOwner);
    const isolated = new SkillSelectionStore(storage).load(sessionOwner);

    expect(recovered?.acceptedSubmission).toEqual(accepted.acceptedSubmission);
    expect(recovered?.draft).toEqual(accepted.draft);
    expect(isolated).toBeUndefined();
  });
});

function skillTurn(status: "CONTENT_READY" | "LOADED" | "FAILED") {
  return {
    capabilityVersion: 4 as const,
    turns: [
      {
        runId: olderRunId,
        conversationTurnId: `turn:${olderRunId}`,
        runStatus: status === "FAILED" ? ("FAILED" as const) : ("RUNNING" as const),
        openedAt: 1,
        highWatermark: 1,
        items: [
          {
            id: `${olderRunId}:skill:${skillSelection.skillId}`,
            runId: olderRunId,
            conversationTurnId: `turn:${olderRunId}`,
            ordinal: 0,
            createdAt: 1,
            status: status === "FAILED" ? ("FAILED" as const) : ("COMPLETED" as const),
            kind: "SKILL" as const,
            skillId: skillSelection.skillId,
            name: "review-notes",
            skillStatus: status,
          },
        ],
      },
    ],
  };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}
