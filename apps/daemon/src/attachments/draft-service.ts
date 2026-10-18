import {
  AttachmentDraftSchema,
  AttachmentOwnerSchema,
  type AttachmentDraft,
  type AttachmentId,
  type AttachmentOwner,
  type SubmissionId,
} from "@caelush/protocol";
import type { AttachmentRepository } from "@caelush/storage";

export interface AttachmentDraftService {
  getDraft(owner: AttachmentOwner): Promise<AttachmentDraft | null>;
  saveDraft(
    owner: AttachmentOwner,
    expectedRevision: number,
    draft: {
      readonly text: string;
      readonly artifactIds: readonly AttachmentId[];
      readonly submissionId?: SubmissionId;
    },
  ): Promise<AttachmentDraft>;
}

export function createAttachmentDraftService(
  attachments: Pick<AttachmentRepository, "getDraft" | "saveDraft">,
): AttachmentDraftService {
  return Object.freeze({
    async getDraft(owner: AttachmentOwner): Promise<AttachmentDraft | null> {
      return attachments.getDraft(AttachmentOwnerSchema.parse(owner));
    },
    async saveDraft(
      owner: AttachmentOwner,
      expectedRevision: number,
      draft: {
        readonly text: string;
        readonly artifactIds: readonly AttachmentId[];
        readonly submissionId?: SubmissionId;
      },
    ): Promise<AttachmentDraft> {
      const parsedOwner = AttachmentOwnerSchema.parse(owner);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError("Attachment draft revision is invalid.");
      }
      const parsed = AttachmentDraftSchema.parse({
        owner: parsedOwner,
        revision: expectedRevision + 1,
        ...draft,
      });
      return attachments.saveDraft(parsedOwner, expectedRevision, {
        text: parsed.text,
        artifactIds: parsed.artifactIds,
        ...(parsed.submissionId === undefined ? {} : { submissionId: parsed.submissionId }),
      });
    },
  });
}
