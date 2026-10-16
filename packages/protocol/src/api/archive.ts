import { z } from "zod";
import { SessionIdSchema, WorkspaceIdSchema } from "../primitives/ids.js";
import { TimestampMsSchema } from "../primitives/time.js";
import { WorkspaceRecordSchema } from "../workspace.js";

const count = z.number().int().nonnegative().safe();
const archiveId = z.uuid();
const search = z.string().trim().max(200).optional();
const cursor = z.string().min(1).max(4096).optional();
const limit = z.coerce.number().int().min(1).max(100).default(50);

export const ArchiveTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SESSION"), sessionId: SessionIdSchema }).strict(),
  z.object({ type: z.literal("WORKSPACE"), workspaceId: WorkspaceIdSchema }).strict(),
]);
export type ArchiveTarget = z.infer<typeof ArchiveTargetSchema>;

export const ArchiveEpisodeSchema = z
  .object({
    archiveId,
    archivedAt: TimestampMsSchema.nullable(),
    reason: z.enum(["USER", "LEGACY_SESSION_MARKER", "LEGACY_FORGOTTEN_WORKSPACE"]),
  })
  .strict();
export type ArchiveEpisode = z.infer<typeof ArchiveEpisodeSchema>;

export const ArchiveStateSchema = z
  .object({
    target: ArchiveTargetSchema,
    archived: z.boolean(),
    ownArchive: ArchiveEpisodeSchema.optional(),
    parentWorkspace: z
      .object({
        workspaceId: WorkspaceIdSchema,
        archive: ArchiveEpisodeSchema.optional(),
      })
      .strict()
      .optional(),
    restoreDisposition: z.enum([
      "AVAILABLE",
      "PARENT_ARCHIVED",
      "WORKSPACE_UNAVAILABLE",
      "NOT_ARCHIVED",
    ]),
  })
  .strict()
  .superRefine((state, context) => {
    const inherited = state.parentWorkspace?.archive !== undefined;
    if (state.archived !== (state.ownArchive !== undefined || inherited)) {
      context.addIssue({ code: "custom", message: "Archive state must match its episodes" });
    }
    if (state.target.type === "WORKSPACE" && state.parentWorkspace !== undefined) {
      context.addIssue({ code: "custom", message: "A Workspace has no parent Workspace" });
    }
    if (
      (!state.archived && state.restoreDisposition !== "NOT_ARCHIVED") ||
      (state.archived && state.restoreDisposition === "NOT_ARCHIVED") ||
      (inherited && state.restoreDisposition !== "PARENT_ARCHIVED") ||
      (!inherited && state.restoreDisposition === "PARENT_ARCHIVED")
    ) {
      context.addIssue({ code: "custom", message: "Restore disposition must match archive state" });
    }
  });
export type ArchiveState = z.infer<typeof ArchiveStateSchema>;

function exclusiveWorkspace(value: { workspaceId?: unknown; unassociated?: unknown }): boolean {
  return value.workspaceId === undefined || value.unassociated !== true;
}
const sessionFilter = {
  query: search,
  workspaceId: WorkspaceIdSchema.optional(),
  unassociated: z.literal(true).optional(),
};
export const ArchiveSessionFilterSchema = z
  .object(sessionFilter)
  .strict()
  .refine(exclusiveWorkspace, "Workspace and unassociated filters are mutually exclusive");
export type ArchiveSessionFilter = z.infer<typeof ArchiveSessionFilterSchema>;
export const ArchiveWorkspaceFilterSchema = z.object({ query: search }).strict();
export type ArchiveWorkspaceFilter = z.infer<typeof ArchiveWorkspaceFilterSchema>;
export const ArchiveSessionListQuerySchema = z
  .object({
    ...sessionFilter,
    cursor,
    limit,
    unassociated: z.preprocess(
      (value) => (value === "true" ? true : value),
      z.literal(true).optional(),
    ),
  })
  .strict()
  .refine(exclusiveWorkspace, "Workspace and unassociated filters are mutually exclusive");
export type ArchiveSessionListQuery = z.infer<typeof ArchiveSessionListQuerySchema>;
export const ArchiveWorkspaceListQuerySchema = z.object({ query: search, cursor, limit }).strict();
export type ArchiveWorkspaceListQuery = z.infer<typeof ArchiveWorkspaceListQuerySchema>;

export const ArchiveSessionItemSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z.string().min(1),
    state: ArchiveStateSchema,
    archivedAt: TimestampMsSchema.nullable(),
    group: z
      .object({
        key: z.string().min(1),
        displayName: z.string().min(1),
        matchedCount: count,
        workspaceId: WorkspaceIdSchema.optional(),
        canonicalPath: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export type ArchiveSessionItem = z.infer<typeof ArchiveSessionItemSchema>;
export const ArchiveWorkspaceItemSchema = z
  .object({
    workspace: WorkspaceRecordSchema,
    state: ArchiveStateSchema,
    archivedAt: TimestampMsSchema.nullable(),
    sessionCount: count,
  })
  .strict();
export type ArchiveWorkspaceItem = z.infer<typeof ArchiveWorkspaceItemSchema>;
const listMetadata = {
  matchedCount: count,
  totalCounts: z.object({ sessions: count, workspaces: count }).strict(),
  catalogRevision: count,
  nextCursor: cursor,
};
export const ArchiveSessionListResponseSchema = z
  .object({ items: z.array(ArchiveSessionItemSchema).max(100), ...listMetadata })
  .strict();
export type ArchiveSessionListResponse = z.infer<typeof ArchiveSessionListResponseSchema>;
export const ArchiveWorkspaceListResponseSchema = z
  .object({ items: z.array(ArchiveWorkspaceItemSchema).max(100), ...listMetadata })
  .strict();
export type ArchiveWorkspaceListResponse = z.infer<typeof ArchiveWorkspaceListResponseSchema>;
export const ArchiveMutationResponseSchema = z
  .object({ state: ArchiveStateSchema, changed: z.boolean(), catalogRevision: count })
  .strict();
export type ArchiveMutationResponse = z.infer<typeof ArchiveMutationResponseSchema>;
export const RestoreArchiveRequestSchema = z.object({ archiveId }).strict();
export type RestoreArchiveRequest = z.infer<typeof RestoreArchiveRequestSchema>;

export const ArchiveDeletionSelectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SESSION"), sessionId: SessionIdSchema }).strict(),
  z.object({ type: z.literal("WORKSPACE"), workspaceId: WorkspaceIdSchema }).strict(),
  z.object({ type: z.literal("SESSION_FILTER"), filter: ArchiveSessionFilterSchema }).strict(),
  z.object({ type: z.literal("WORKSPACE_FILTER"), filter: ArchiveWorkspaceFilterSchema }).strict(),
]);
export type ArchiveDeletionSelection = z.infer<typeof ArchiveDeletionSelectionSchema>;
export const ArchiveDeletionCountsSchema = z
  .object({ workspaces: count, sessions: count, runs: count })
  .strict();
export type ArchiveDeletionCounts = z.infer<typeof ArchiveDeletionCountsSchema>;
const samples = z
  .array(
    z
      .object({
        type: z.enum(["SESSION", "WORKSPACE"]),
        label: z.string().min(1),
        canonicalPath: z.string().min(1).optional(),
      })
      .strict(),
  )
  .max(3);
export const PermanentDeletionRequestSchema = z
  .object({ confirmationToken: z.string().min(1).max(8192) })
  .strict();
export type PermanentDeletionRequest = z.infer<typeof PermanentDeletionRequestSchema>;
export const ArchiveDeletionPreviewResponseSchema = z
  .object({
    counts: ArchiveDeletionCountsSchema,
    samples,
    confirmationToken: z.string().min(1).max(8192),
    expiresAt: TimestampMsSchema,
  })
  .strict();
export type ArchiveDeletionPreviewResponse = z.infer<typeof ArchiveDeletionPreviewResponseSchema>;
export const PermanentDeletionResponseSchema = z
  .object({ counts: ArchiveDeletionCountsSchema, catalogRevision: count })
  .strict();
export type PermanentDeletionResponse = z.infer<typeof PermanentDeletionResponseSchema>;
export const ArchiveDeletionSnapshotSchema = z
  .object({
    selection: ArchiveDeletionSelectionSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    counts: ArchiveDeletionCountsSchema,
    samples,
  })
  .strict();
export type ArchiveDeletionSnapshot = z.infer<typeof ArchiveDeletionSnapshotSchema>;

export const LegacyArchiveImportRequestSchema = z
  .object({
    markers: z
      .array(
        z.object({ sessionId: SessionIdSchema, archivedAt: TimestampMsSchema.nullable() }).strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type LegacyArchiveImportRequest = z.infer<typeof LegacyArchiveImportRequestSchema>;
export const LegacyArchiveImportResponseSchema = z
  .object({
    importedSessionIds: z.array(SessionIdSchema).max(100),
    alreadyArchivedSessionIds: z.array(SessionIdSchema).max(100),
    rejected: z
      .array(
        z
          .object({
            sessionId: SessionIdSchema,
            reason: z.enum(["NOT_OWNED", "ACTIVE_RUN_CONFLICT"]),
          })
          .strict(),
      )
      .max(100),
    catalogRevision: count,
  })
  .strict();
export type LegacyArchiveImportResponse = z.infer<typeof LegacyArchiveImportResponseSchema>;
