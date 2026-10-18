import { createHash, randomUUID } from "node:crypto";
import {
  AttachmentIdsSchema,
  AttachmentOwnerSchema,
  AttachmentProcessingManifestSchema,
  AttachmentReadRangeSchema,
  AttachmentIdSchema,
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  MAX_ATTACHMENT_BYTES,
  SessionIdSchema,
  createTimestampMs,
  type AttachmentDescriptor,
  type AttachmentDraft,
  type AttachmentId,
  type AttachmentOwner,
  type AttachmentProcessingManifest,
  type AttachmentReadRange,
  type AttachmentReadResult,
  type PendingAttachment,
  type SessionId,
  type VerifiedAttachmentMetadata,
} from "@caelush/protocol";
import type {
  AttachmentRepository,
  SessionRepository,
  WorkspaceRepository,
} from "@caelush/storage";
import { StorageConflictError, StorageNotFoundError } from "@caelush/storage";
import { ZodError } from "zod";
import {
  createDocumentProcessor,
  DocumentProcessorError,
  type DocumentProcessor,
} from "./document-processor.js";
import { AttachmentBlobStore, AttachmentBlobStoreError } from "./blob-store.js";
import { createAttachmentDraftService, type AttachmentDraftService } from "./draft-service.js";

export type AttachmentServiceErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RESOURCE_LIMIT"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_DOCUMENT"
  | "PASSWORD_REQUIRED"
  | "CONTENT_HASH_MISMATCH"
  | "PROCESSOR_TIMEOUT"
  | "PROCESSOR_CANCELLED"
  | "PROCESSOR_FAILED"
  | "UPLOAD_INTERRUPTED"
  | "BLOB_UNAVAILABLE";

export class AttachmentServiceError extends Error {
  constructor(readonly code: AttachmentServiceErrorCode) {
    super(`Attachment operation failed (${code}).`);
    this.name = "AttachmentServiceError";
  }
}

export interface AttachmentUploadInput {
  readonly owner: AttachmentOwner;
  readonly name: string;
  readonly declaredMediaType: string;
  /** Advisory only. The daemon enforces the byte count observed from the stream. */
  readonly declaredByteLength?: number;
  readonly stream: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface AttachmentServiceOptions {
  readonly rootDirectory: string;
  readonly attachments: AttachmentRepository;
  readonly sessions: SessionRepository;
  readonly workspaces: WorkspaceRepository;
  readonly processor?: DocumentProcessor;
  readonly draftService?: AttachmentDraftService;
  readonly now?: () => number;
  readonly createId?: () => AttachmentId;
}

export interface AttachmentService {
  upload(input: AttachmentUploadInput): Promise<AttachmentDescriptor>;
  getReadyForOwner(
    ids: readonly AttachmentId[],
    owner: AttachmentOwner,
  ): Promise<AttachmentDescriptor[]>;
  getReadyForRun(
    ids: readonly AttachmentId[],
    sessionId: SessionId,
  ): Promise<AttachmentDescriptor[]>;
  read(input: {
    readonly artifactId: AttachmentId;
    readonly owner: AttachmentOwner;
    readonly range: AttachmentReadRange;
    readonly signal?: AbortSignal;
  }): Promise<AttachmentReadResult>;
  download(input: {
    readonly artifactId: AttachmentId;
    readonly owner: AttachmentOwner;
  }): Promise<Buffer>;
  saveDraft(
    owner: AttachmentOwner,
    expectedRevision: number,
    draft: Pick<AttachmentDraft, "text" | "artifactIds" | "submissionId">,
  ): Promise<AttachmentDraft>;
  getDraft(owner: AttachmentOwner): Promise<AttachmentDraft | null>;
  recover(): Promise<void>;
}

export function createAttachmentService(options: AttachmentServiceOptions): AttachmentService {
  const blobs = new AttachmentBlobStore(options.rootDirectory);
  const processor = options.processor ?? createDocumentProcessor();
  const draftService = options.draftService ?? createAttachmentDraftService(options.attachments);
  const now = options.now ?? Date.now;
  const createId =
    options.createId ?? (() => AttachmentIdSchema.parse(`att_${randomUUID().replaceAll("-", "")}`));
  const getAuthorizedReady = async (
    artifactId: AttachmentId,
    owner: AttachmentOwner,
  ): Promise<{ readonly descriptor: AttachmentDescriptor; readonly bytes: Buffer }> => {
    const descriptor = await options.attachments.getAuthorized(artifactId, owner);
    if (descriptor === null) throw new AttachmentServiceError("NOT_FOUND");
    try {
      return { descriptor, bytes: await verifyBlob(descriptor, blobs) };
    } catch (error) {
      if (error instanceof AttachmentServiceError && error.code === "BLOB_UNAVAILABLE") {
        await options.attachments.markUnavailable(artifactId).catch(() => undefined);
      }
      throw error;
    }
  };

  return Object.freeze({
    async upload(input: AttachmentUploadInput): Promise<AttachmentDescriptor> {
      let owner: AttachmentOwner;
      let name: PendingAttachment["name"];
      let declaredMediaType: PendingAttachment["declaredMediaType"];
      try {
        owner = AttachmentOwnerSchema.parse(input.owner);
        name = AttachmentNameSchema.parse(input.name);
        declaredMediaType = AttachmentMediaTypeSchema.parse(input.declaredMediaType);
      } catch {
        throw new AttachmentServiceError("INVALID_REQUEST");
      }
      if (
        input.declaredByteLength !== undefined &&
        (!Number.isSafeInteger(input.declaredByteLength) || input.declaredByteLength < 0)
      ) {
        throw new AttachmentServiceError("INVALID_REQUEST");
      }
      if (
        input.declaredByteLength !== undefined &&
        input.declaredByteLength > MAX_ATTACHMENT_BYTES
      ) {
        throw new AttachmentServiceError("RESOURCE_LIMIT");
      }

      const workspaceId = await resolveOwnerWorkspace(owner, options);
      let artifactId: AttachmentId;
      for (;;) {
        artifactId = createId();
        if ((await blobs.inspect(artifactId)) === null) break;
      }
      const pending: PendingAttachment = {
        artifactId,
        workspaceId,
        owner,
        name,
        declaredMediaType,
        createdAt: createTimestampMs(now()),
      };
      try {
        await options.attachments.createPending(pending);
      } catch (error) {
        throw toAttachmentServiceError(error);
      }

      let uploadComplete = false;
      try {
        const written = await blobs.write(artifactId, input.stream, input.signal);
        uploadComplete = true;
        await options.attachments.markPreprocessing(artifactId);
        const bytes = await blobs.read(artifactId);
        if (bytes.byteLength !== written.byteLength || sha256(bytes) !== written.sha256) {
          throw new AttachmentServiceError("CONTENT_HASH_MISMATCH");
        }
        const manifest = await processor.inspect({
          artifactId,
          bytes,
          name,
          detectedMediaType: declaredMediaType,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (
          manifest.artifactId !== artifactId ||
          manifest.sha256 !== written.sha256 ||
          manifest.processorVersion.length === 0
        ) {
          throw new AttachmentServiceError("CONTENT_HASH_MISMATCH");
        }
        const verified: VerifiedAttachmentMetadata = {
          mediaType: manifest.mediaType,
          byteLength: written.byteLength,
          sha256: written.sha256,
          visualRequirement: manifest.visualRequirement,
          processorVersion: manifest.processorVersion,
        };
        return await options.attachments.markReady(artifactId, verified);
      } catch (error) {
        await blobs.remove(artifactId).catch(() => undefined);
        await options.attachments.markFailed(artifactId).catch(() => undefined);
        throw toAttachmentServiceError(error, input.signal?.aborted === true || !uploadComplete);
      }
    },

    async getReadyForOwner(
      ids: readonly AttachmentId[],
      owner: AttachmentOwner,
    ): Promise<AttachmentDescriptor[]> {
      let artifactIds: AttachmentId[];
      let parsedOwner: AttachmentOwner;
      try {
        artifactIds = AttachmentIdsSchema.parse(ids);
        parsedOwner = AttachmentOwnerSchema.parse(owner);
      } catch {
        throw new AttachmentServiceError("INVALID_REQUEST");
      }
      const descriptors = await Promise.all(
        artifactIds.map(async (artifactId) => {
          const ready = await getAuthorizedReady(artifactId, parsedOwner);
          return ready.descriptor;
        }),
      );
      return descriptors;
    },

    async getReadyForRun(ids, sessionId): Promise<AttachmentDescriptor[]> {
      let artifactIds: AttachmentId[];
      let parsedSessionId: SessionId;
      try {
        artifactIds = AttachmentIdsSchema.parse(ids);
        parsedSessionId = SessionIdSchema.parse(sessionId);
      } catch {
        throw new AttachmentServiceError("INVALID_REQUEST");
      }
      const workspaceId = await resolveOwnerWorkspace(
        { kind: "SESSION", sessionId: parsedSessionId },
        options,
      );
      return Promise.all(
        artifactIds.map(async (artifactId) => {
          try {
            return (
              await getAuthorizedReady(artifactId, {
                kind: "SESSION",
                sessionId: parsedSessionId,
              })
            ).descriptor;
          } catch (error) {
            if (!(error instanceof AttachmentServiceError) || error.code !== "NOT_FOUND") {
              throw error;
            }
            return (await getAuthorizedReady(artifactId, { kind: "WORKSPACE", workspaceId }))
              .descriptor;
          }
        }),
      );
    },

    async read({ artifactId, owner, range, signal }): Promise<AttachmentReadResult> {
      const parsedId = parseId(artifactId);
      const parsedOwner = parseOwner(owner);
      const parsedRange = parseRange(range);
      const { descriptor, bytes } = await getAuthorizedReady(parsedId, parsedOwner);
      const manifest = await inspectStored(processor, descriptor, bytes, signal);
      return processor.read({
        bytes,
        manifest,
        range: parsedRange,
        ...(signal === undefined ? {} : { signal }),
      });
    },

    async download({ artifactId, owner }): Promise<Buffer> {
      const parsedId = parseId(artifactId);
      const parsedOwner = parseOwner(owner);
      const { bytes } = await getAuthorizedReady(parsedId, parsedOwner);
      return bytes;
    },

    async saveDraft(owner, expectedRevision, draft): Promise<AttachmentDraft> {
      try {
        return await draftService.saveDraft(parseOwner(owner), expectedRevision, {
          text: draft.text,
          artifactIds: draft.artifactIds,
          ...(draft.submissionId === undefined ? {} : { submissionId: draft.submissionId }),
        });
      } catch (error) {
        throw toAttachmentServiceError(error);
      }
    },

    async getDraft(owner): Promise<AttachmentDraft | null> {
      try {
        const parsedOwner = parseOwner(owner);
        await resolveOwnerWorkspace(parsedOwner, options);
        return await draftService.getDraft(parsedOwner);
      } catch (error) {
        throw toAttachmentServiceError(error);
      }
    },

    async recover(): Promise<void> {
      await blobs.cleanupTemporaryFiles();
      const records = await options.attachments.listForRecovery();
      const knownArtifactIds = new Set(records.map((record) => record.artifactId));
      for (const record of records) {
        if (record.status === "FAILED" || record.status === "UNAVAILABLE") {
          await blobs.remove(record.artifactId).catch(() => undefined);
          continue;
        }
        if (record.status === "UPLOADING" || record.status === "PREPROCESSING") {
          await blobs.remove(record.artifactId).catch(() => undefined);
          await options.attachments.markUnavailable(record.artifactId).catch(() => undefined);
          continue;
        }

        let blobIsAvailable = false;
        try {
          const file = await blobs.inspect(record.artifactId);
          if (file !== null && file.byteLength === record.byteLength) {
            const bytes = await blobs.read(record.artifactId);
            blobIsAvailable = sha256(bytes) === record.sha256;
          }
        } catch {
          // A single missing or unreadable blob must not prevent unrelated attachments from
          // being reconciled or keep the daemon from starting.
        }
        if (!blobIsAvailable) {
          await options.attachments.markUnavailable(record.artifactId).catch(() => undefined);
          await blobs.remove(record.artifactId).catch(() => undefined);
        }
      }
      for (const artifactId of await blobs.listBlobIds()) {
        if (!knownArtifactIds.has(artifactId))
          await blobs.remove(artifactId).catch(() => undefined);
      }
    },
  } satisfies AttachmentService);
}

async function resolveOwnerWorkspace(
  owner: AttachmentOwner,
  options: Pick<AttachmentServiceOptions, "sessions" | "workspaces">,
) {
  if (owner.kind === "WORKSPACE") {
    if ((await options.workspaces.getById(owner.workspaceId)) === null) {
      throw new AttachmentServiceError("NOT_FOUND");
    }
    return owner.workspaceId;
  }
  const session = await options.sessions.get(owner.sessionId);
  if (session?.workspaceId === undefined) throw new AttachmentServiceError("NOT_FOUND");
  if ((await options.workspaces.getById(session.workspaceId)) === null) {
    throw new AttachmentServiceError("NOT_FOUND");
  }
  return session.workspaceId;
}

async function verifyBlob(
  descriptor: AttachmentDescriptor,
  blobs: AttachmentBlobStore,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await blobs.read(descriptor.artifactId);
  } catch {
    throw new AttachmentServiceError("BLOB_UNAVAILABLE");
  }
  if (bytes.byteLength !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) {
    throw new AttachmentServiceError("BLOB_UNAVAILABLE");
  }
  return bytes;
}

async function inspectStored(
  processor: DocumentProcessor,
  descriptor: AttachmentDescriptor,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<AttachmentProcessingManifest> {
  const manifest = await processor.inspect({
    artifactId: descriptor.artifactId,
    bytes,
    name: descriptor.name,
    detectedMediaType: descriptor.mediaType,
    ...(signal === undefined ? {} : { signal }),
  });
  if (manifest.sha256 !== descriptor.sha256) throw new AttachmentServiceError("BLOB_UNAVAILABLE");
  return AttachmentProcessingManifestSchema.parse(manifest);
}

function parseId(id: AttachmentId): AttachmentId {
  try {
    return AttachmentIdSchema.parse(id);
  } catch {
    throw new AttachmentServiceError("INVALID_REQUEST");
  }
}

function parseOwner(owner: AttachmentOwner): AttachmentOwner {
  try {
    return AttachmentOwnerSchema.parse(owner);
  } catch {
    throw new AttachmentServiceError("INVALID_REQUEST");
  }
}

function parseRange(range: AttachmentReadRange): AttachmentReadRange {
  try {
    return AttachmentReadRangeSchema.parse(range);
  } catch {
    throw new AttachmentServiceError("INVALID_REQUEST");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toAttachmentServiceError(error: unknown, interrupted = false): AttachmentServiceError {
  if (error instanceof AttachmentServiceError) return error;
  if (error instanceof DocumentProcessorError) return new AttachmentServiceError(error.code);
  if (error instanceof AttachmentBlobStoreError) {
    return new AttachmentServiceError(
      error.code === "EMPTY_UPLOAD" ? "INVALID_DOCUMENT" : error.code,
    );
  }
  if (error instanceof StorageNotFoundError) return new AttachmentServiceError("NOT_FOUND");
  if (error instanceof StorageConflictError) return new AttachmentServiceError("CONFLICT");
  if (error instanceof ZodError) return new AttachmentServiceError("INVALID_REQUEST");
  if (interrupted) return new AttachmentServiceError("UPLOAD_INTERRUPTED");
  return new AttachmentServiceError("PROCESSOR_FAILED");
}
