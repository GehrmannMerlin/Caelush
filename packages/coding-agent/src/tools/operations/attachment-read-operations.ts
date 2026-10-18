import type {
  AttachmentId,
  AttachmentReadRange,
  AttachmentReadResult,
  SessionId,
} from "@caelush/protocol";

/** Read one bounded attachment range for the exact Session executing the Tool. */
export interface AttachmentReadOperations {
  read(input: {
    readonly sessionId: SessionId;
    readonly artifactId: AttachmentId;
    readonly range: AttachmentReadRange;
    readonly signal: AbortSignal;
  }): Promise<AttachmentReadResult>;
}

export type AttachmentReadOperationErrorCode =
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_DOCUMENT"
  | "PASSWORD_REQUIRED"
  | "PROCESSOR_TIMEOUT"
  | "PROCESSOR_CANCELLED"
  | "PROCESSOR_FAILED";

/** Stable operation failure; never carries document bytes or parser exception text. */
export class AttachmentReadOperationError extends Error {
  constructor(readonly code: AttachmentReadOperationErrorCode) {
    super(`Attachment read failed (${code}).`);
    this.name = "AttachmentReadOperationError";
  }
}
