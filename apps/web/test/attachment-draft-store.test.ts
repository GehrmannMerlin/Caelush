import { createWorkspaceId, type AttachmentDraft, type AttachmentOwner } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { CaelushClientHttpError } from "@caelush/client";
import {
  AttachmentDraftStore,
  type AttachmentDraftClient,
} from "../src/application/attachment-draft-store.js";

const workspaceOwner: AttachmentOwner = { kind: "WORKSPACE", workspaceId: createWorkspaceId() };
const sessionOwner: AttachmentOwner = {
  kind: "SESSION",
  sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never,
};

const emptyDraft = (owner: AttachmentOwner, revision = 0): AttachmentDraft => ({
  owner,
  revision,
  text: "",
  artifactIds: [],
});

describe("AttachmentDraftStore", () => {
  it("restores independent workspace and session drafts", async () => {
    const client: AttachmentDraftClient = {
      getAttachmentDraft: vi.fn(async (owner) =>
        owner.kind === "WORKSPACE"
          ? { ...emptyDraft(owner, 4), text: "workspace draft" }
          : { ...emptyDraft(owner, 2), text: "session draft" },
      ),
      saveAttachmentDraft: vi.fn(),
    };
    const store = new AttachmentDraftStore(client);
    await expect(store.load(workspaceOwner)).resolves.toMatchObject({
      text: "workspace draft",
      revision: 4,
    });
    await expect(store.load(sessionOwner)).resolves.toMatchObject({
      text: "session draft",
      revision: 2,
    });
  });

  it("keeps the server's newer draft when an optimistic save conflicts", async () => {
    let reads = 0;
    const latest = { ...emptyDraft(workspaceOwner, 7), text: "newer from another window" };
    const client: AttachmentDraftClient = {
      getAttachmentDraft: vi.fn(async () =>
        reads++ === 0 ? emptyDraft(workspaceOwner, 1) : latest,
      ),
      saveAttachmentDraft: vi.fn(async () => {
        throw new CaelushClientHttpError({
          status: 409,
          code: "CONFLICT",
          message: "Draft changed.",
        });
      }),
    };
    const store = new AttachmentDraftStore(client);
    const loaded = await store.load(workspaceOwner);
    await expect(
      store.save(workspaceOwner, loaded.revision, { text: "stale", artifactIds: [] }),
    ).rejects.toThrow();
    expect(store.getSnapshot(workspaceOwner)).toMatchObject({ text: latest.text, revision: 7 });
  });

  it("reuses one submission id until draft content changes and clears by revision", async () => {
    let saved = emptyDraft(workspaceOwner);
    const client: AttachmentDraftClient = {
      getAttachmentDraft: vi.fn(async () => saved),
      saveAttachmentDraft: vi.fn(async (owner, input) => {
        saved = { owner, revision: input.expectedRevision + 1, ...input };
        return saved;
      }),
    };
    const store = new AttachmentDraftStore(client);
    const draft = await store.load(workspaceOwner);
    const prepared = await store.prepareSubmission(workspaceOwner, draft.revision);
    const repeated = await store.prepareSubmission(workspaceOwner, prepared.revision);
    expect(repeated.submissionId).toBe(prepared.submissionId);
    const edited = await store.save(workspaceOwner, repeated.revision, {
      text: "updated",
      artifactIds: [],
    });
    expect(edited.submissionId).toBeUndefined();
    await store.clear(workspaceOwner, edited.revision);
    expect(store.getSnapshot(workspaceOwner)).toMatchObject({ text: "", artifactIds: [] });
  });
});
