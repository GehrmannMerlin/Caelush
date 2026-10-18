import { z } from "zod";
import { RunIdSchema, SessionIdSchema, WorkspaceIdSchema } from "./primitives/ids.js";
import { TimestampMsSchema } from "./primitives/time.js";

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Attachment IDs are opaque, URL-safe identifiers issued by the daemon. */
export const AttachmentIdSchema = z
  .string()
  .regex(/^att_[A-Za-z0-9_-]{12,128}$/)
  .brand<"AttachmentId">();
export type AttachmentId = z.infer<typeof AttachmentIdSchema>;

export const SubmissionIdSchema = z.string().uuid().brand<"SubmissionId">();
export type SubmissionId = z.infer<typeof SubmissionIdSchema>;

export const AttachmentNameSchema = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex -- filenames must reject C0/DEL controls
  .refine((name) => name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(name));

export const AttachmentMediaTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);

export const AttachmentSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AttachmentStatusSchema = z.enum([
  "VALIDATING",
  "UPLOADING",
  "PREPROCESSING",
  "READY",
  "FAILED",
  "UNAVAILABLE",
]);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

/** Minimal safe record used by daemon startup to reconcile attachment metadata with blob files. */
export const AttachmentRecoveryRecordSchema = z
  .object({
    artifactId: AttachmentIdSchema,
    status: AttachmentStatusSchema,
    byteLength: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES).optional(),
    sha256: AttachmentSha256Schema.optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.status !== "READY" || (record.byteLength !== undefined && record.sha256 !== undefined),
    "Ready attachment recovery records require verified size and hash.",
  );
export type AttachmentRecoveryRecord = z.infer<typeof AttachmentRecoveryRecordSchema>;

export const AttachmentVisualRequirementSchema = z.enum([
  "NOT_REQUIRED",
  "POSSIBLE",
  "REQUIRED",
  "UNKNOWN",
]);
export type AttachmentVisualRequirement = z.infer<typeof AttachmentVisualRequirementSchema>;

export const AttachmentOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("WORKSPACE"), workspaceId: WorkspaceIdSchema }).strict(),
  z.object({ kind: z.literal("SESSION"), sessionId: SessionIdSchema }).strict(),
]);
export type AttachmentOwner = z.infer<typeof AttachmentOwnerSchema>;

export const AttachmentIdsSchema = z
  .array(AttachmentIdSchema)
  .min(1)
  .max(MAX_ATTACHMENT_COUNT)
  .refine((ids) => new Set(ids).size === ids.length, "Attachment IDs must be unique.");

export const AttachmentDescriptorSchema = z
  .object({
    artifactId: AttachmentIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: AttachmentNameSchema,
    mediaType: AttachmentMediaTypeSchema,
    byteLength: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    sha256: AttachmentSha256Schema,
    status: AttachmentStatusSchema,
    visualRequirement: AttachmentVisualRequirementSchema,
    processorVersion: z.string().min(1).max(128),
  })
  .strict();
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;

/** Safe metadata for displaying an attachment restored from a durable draft. */
export const AttachmentDraftItemSchema = z
  .object({
    artifactId: AttachmentIdSchema,
    name: AttachmentNameSchema,
    mediaType: AttachmentMediaTypeSchema,
    byteLength: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    visualRequirement: AttachmentVisualRequirementSchema,
  })
  .strict();
export type AttachmentDraftItem = z.infer<typeof AttachmentDraftItemSchema>;

export const PendingAttachmentSchema = z
  .object({
    artifactId: AttachmentIdSchema,
    workspaceId: WorkspaceIdSchema,
    owner: AttachmentOwnerSchema,
    name: AttachmentNameSchema,
    declaredMediaType: AttachmentMediaTypeSchema,
    createdAt: TimestampMsSchema,
  })
  .strict();
export type PendingAttachment = z.infer<typeof PendingAttachmentSchema>;

export const VerifiedAttachmentMetadataSchema = z
  .object({
    mediaType: AttachmentMediaTypeSchema,
    byteLength: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    sha256: AttachmentSha256Schema,
    visualRequirement: AttachmentVisualRequirementSchema,
    processorVersion: z.string().min(1).max(128),
  })
  .strict();
export type VerifiedAttachmentMetadata = z.infer<typeof VerifiedAttachmentMetadataSchema>;

export const AttachmentDraftSchema = z
  .object({
    owner: AttachmentOwnerSchema,
    revision: z.number().int().min(0),
    text: z.string().max(200_000),
    artifactIds: z
      .array(AttachmentIdSchema)
      .max(MAX_ATTACHMENT_COUNT)
      .refine((ids) => new Set(ids).size === ids.length, "Attachment IDs must be unique."),
    submissionId: SubmissionIdSchema.optional(),
  })
  .strict();
export type AttachmentDraft = z.infer<typeof AttachmentDraftSchema>;

export const SubmissionRecordSchema = z
  .object({
    submissionId: SubmissionIdSchema,
    payloadHash: AttachmentSha256Schema,
    sessionId: SessionIdSchema.optional(),
    runId: RunIdSchema.optional(),
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  })
  .strict();
export type SubmissionRecord = z.infer<typeof SubmissionRecordSchema>;

/** Internal Run goal used when a user submits attachments without prompt text. */
export const ATTACHMENT_ONLY_RUN_GOAL =
  "Inspect the attached materials and ask what the user wants to know.";
