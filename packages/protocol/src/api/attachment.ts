import { z } from "zod";
import {
  AttachmentDescriptorSchema,
  AttachmentDraftItemSchema,
  AttachmentDraftSchema,
  AttachmentIdsSchema,
  AttachmentMediaTypeSchema,
  AttachmentNameSchema,
  AttachmentOwnerSchema,
  AttachmentSha256Schema,
  MAX_ATTACHMENT_BYTES,
  SubmissionIdSchema,
} from "../attachment.js";

export const AttachmentUploadBeginRequestSchema = z
  .object({
    owner: AttachmentOwnerSchema,
    name: AttachmentNameSchema,
    declaredMediaType: AttachmentMediaTypeSchema,
    /** Advisory size from the client; the daemon always enforces the streamed byte count. */
    declaredByteLength: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export type AttachmentUploadBeginRequest = z.infer<typeof AttachmentUploadBeginRequestSchema>;

export const AttachmentUploadFinishRequestSchema = z
  .object({
    artifactId: AttachmentDescriptorSchema.shape.artifactId,
    byteLength: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    sha256: AttachmentSha256Schema,
  })
  .strict();
export type AttachmentUploadFinishRequest = z.infer<typeof AttachmentUploadFinishRequestSchema>;

export const AttachmentUploadFinishResponseSchema = z
  .object({ attachment: AttachmentDescriptorSchema })
  .strict();
export type AttachmentUploadFinishResponse = z.infer<typeof AttachmentUploadFinishResponseSchema>;

export const AttachmentDraftReadRequestSchema = z.object({ owner: AttachmentOwnerSchema }).strict();
export type AttachmentDraftReadRequest = z.infer<typeof AttachmentDraftReadRequestSchema>;

export const AttachmentDraftWriteRequestSchema = z
  .object({
    owner: AttachmentOwnerSchema,
    expectedRevision: z.number().int().min(0),
    text: z.string().max(200_000),
    artifactIds: AttachmentDraftSchema.shape.artifactIds,
    submissionId: SubmissionIdSchema.optional(),
  })
  .strict();
export type AttachmentDraftWriteRequest = z.infer<typeof AttachmentDraftWriteRequestSchema>;

export const AttachmentDraftResponseSchema = z
  .object({ draft: AttachmentDraftSchema.nullable() })
  .strict();
export type AttachmentDraftResponse = z.infer<typeof AttachmentDraftResponseSchema>;

export const AttachmentDownloadQuerySchema = z
  .object({ artifactId: AttachmentDescriptorSchema.shape.artifactId })
  .strict();
export type AttachmentDownloadQuery = z.infer<typeof AttachmentDownloadQuerySchema>;

export const AttachmentMetadataResponseSchema = z
  .object({ attachment: AttachmentDraftItemSchema.nullable() })
  .strict();
export type AttachmentMetadataResponse = z.infer<typeof AttachmentMetadataResponseSchema>;

export const AttachmentSubmissionSchema = z
  .object({
    submissionId: SubmissionIdSchema,
    attachmentIds: AttachmentIdsSchema,
  })
  .strict();
export type AttachmentSubmission = z.infer<typeof AttachmentSubmissionSchema>;
