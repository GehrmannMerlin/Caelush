import {
  AttachmentOwnerSchema,
  SubmissionIdSchema,
  type AttachmentDraft,
  type AttachmentId,
  type AttachmentOwner,
  type SubmissionId,
} from "@caelush/protocol";
import { CaelushClientHttpError, type AttachmentDraftWrite } from "@caelush/client";

export interface AttachmentDraftClient {
  getAttachmentDraft(owner: AttachmentOwner): Promise<AttachmentDraft | null>;
  saveAttachmentDraft(
    owner: AttachmentOwner,
    input: AttachmentDraftWrite,
  ): Promise<AttachmentDraft>;
}

export class AttachmentDraftConflictError extends Error {
  constructor(readonly latestDraft: AttachmentDraft) {
    super("The attachment draft changed in another window.");
    this.name = "AttachmentDraftConflictError";
  }
}

export class AttachmentDraftStore {
  private readonly snapshots = new Map<string, AttachmentDraft>();

  constructor(
    private readonly client: AttachmentDraftClient,
    private readonly createSubmissionId: () => SubmissionId = randomSubmissionId,
  ) {}

  getSnapshot(owner: AttachmentOwner): AttachmentDraft | undefined {
    const snapshot = this.snapshots.get(ownerKey(owner));
    return snapshot === undefined
      ? undefined
      : Object.freeze({ ...snapshot, artifactIds: [...snapshot.artifactIds] });
  }

  async load(owner: AttachmentOwner): Promise<AttachmentDraft> {
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const loaded = await this.client.getAttachmentDraft(parsedOwner);
    const snapshot = loaded ?? { owner: parsedOwner, revision: 0, text: "", artifactIds: [] };
    this.snapshots.set(ownerKey(parsedOwner), snapshot);
    return this.copy(snapshot);
  }

  async save(
    owner: AttachmentOwner,
    expectedRevision: number,
    draft: { readonly text: string; readonly artifactIds: readonly AttachmentId[] },
  ): Promise<AttachmentDraft> {
    return this.saveRevision(owner, expectedRevision, draft);
  }

  async prepareSubmission(
    owner: AttachmentOwner,
    expectedRevision: number,
  ): Promise<AttachmentDraft> {
    const current = await this.current(owner, expectedRevision);
    if (current.submissionId !== undefined) return this.copy(current);
    return this.saveRevision(owner, expectedRevision, {
      text: current.text,
      artifactIds: current.artifactIds,
      submissionId: this.createSubmissionId(),
    });
  }

  async transfer(
    sourceOwner: AttachmentOwner,
    expectedRevision: number,
    targetOwner: AttachmentOwner,
  ): Promise<AttachmentDraft> {
    const source = await this.current(sourceOwner, expectedRevision);
    const target = this.snapshots.get(ownerKey(targetOwner)) ?? (await this.load(targetOwner));
    return this.saveRevision(
      targetOwner,
      target.revision,
      {
        text: source.text,
        artifactIds: source.artifactIds,
        ...(source.submissionId === undefined ? {} : { submissionId: source.submissionId }),
      },
      true,
    );
  }

  async clear(owner: AttachmentOwner, expectedRevision: number): Promise<void> {
    await this.saveRevision(owner, expectedRevision, { text: "", artifactIds: [] }, true);
  }

  private async saveRevision(
    owner: AttachmentOwner,
    expectedRevision: number,
    input: {
      readonly text: string;
      readonly artifactIds: readonly AttachmentId[];
      readonly submissionId?: SubmissionId;
    },
    force = false,
  ): Promise<AttachmentDraft> {
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const current = await this.current(parsedOwner, expectedRevision);
    if (
      !force &&
      current.text === input.text &&
      current.artifactIds.length === input.artifactIds.length &&
      current.artifactIds.every((id, index) => id === input.artifactIds[index]) &&
      (input.submissionId === undefined || input.submissionId === current.submissionId)
    ) {
      return this.copy(current);
    }
    const request = {
      expectedRevision,
      text: input.text,
      artifactIds: [...input.artifactIds],
      ...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
    };
    try {
      const saved = await this.client.saveAttachmentDraft(parsedOwner, request);
      this.snapshots.set(ownerKey(parsedOwner), saved);
      return this.copy(saved);
    } catch (error) {
      if (!(error instanceof CaelushClientHttpError) || error.code !== "CONFLICT") throw error;
      const latest = (await this.client.getAttachmentDraft(parsedOwner)) ?? {
        owner: parsedOwner,
        revision: current.revision,
        text: current.text,
        artifactIds: current.artifactIds,
      };
      this.snapshots.set(ownerKey(parsedOwner), latest);
      throw new AttachmentDraftConflictError(this.copy(latest));
    }
  }

  private async current(
    owner: AttachmentOwner,
    expectedRevision: number,
  ): Promise<AttachmentDraft> {
    const key = ownerKey(owner);
    const current = this.snapshots.get(key) ?? (await this.load(owner));
    if (current.revision !== expectedRevision)
      throw new AttachmentDraftConflictError(this.copy(current));
    return current;
  }

  private copy(draft: AttachmentDraft): AttachmentDraft {
    return Object.freeze({ ...draft, artifactIds: [...draft.artifactIds] });
  }
}

function ownerKey(owner: AttachmentOwner): string {
  const parsed = AttachmentOwnerSchema.parse(owner);
  return parsed.kind === "SESSION"
    ? `session:${parsed.sessionId}`
    : `workspace:${parsed.workspaceId}`;
}

function randomSubmissionId(): SubmissionId {
  return SubmissionIdSchema.parse(crypto.randomUUID());
}
