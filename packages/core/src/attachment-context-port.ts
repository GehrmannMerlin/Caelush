import type {
  AttachmentDescriptor,
  AttachmentId,
  AttachmentOwner,
  AttachmentProcessingManifest,
  AttachmentReadRange,
  AttachmentReadResult,
} from "@caelush/protocol";

/** Scoped read capability for the verified content behind one immutable attachment. */
export interface AttachmentContentReference {
  readonly artifactId: AttachmentId;
  readonly sha256: string;
  read(input: {
    readonly range: AttachmentReadRange;
    readonly signal: AbortSignal;
  }): Promise<AttachmentReadResult>;
}

/** One authorized immutable attachment snapshot supplied by the daemon. */
export interface AttachmentContextSnapshot {
  readonly descriptor: AttachmentDescriptor;
  readonly manifest: AttachmentProcessingManifest;
  readonly contentReference: AttachmentContentReference;
}

/** Core's read-only authority for resolving user attachment references. */
export interface AttachmentContextPort {
  readSnapshot(input: {
    readonly artifactId: AttachmentId;
    readonly owner: AttachmentOwner;
    readonly signal: AbortSignal;
  }): Promise<AttachmentContextSnapshot>;
}
