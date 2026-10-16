import { z } from "zod";
import {
  ArchiveSessionListQuerySchema,
  ArchiveSessionListResponseSchema,
  ArchiveWorkspaceListQuerySchema,
  ArchiveWorkspaceListResponseSchema,
  ArchiveTargetSchema,
  ArchiveStateSchema,
  ArchiveMutationResponseSchema,
  RestoreArchiveRequestSchema,
  ArchiveDeletionSelectionSchema,
  ArchiveDeletionPreviewResponseSchema,
  PermanentDeletionRequestSchema,
  PermanentDeletionResponseSchema,
  SessionIdSchema,
  SessionTranscriptQuerySchema,
  SessionTranscriptResponseSchema,
} from "@caelush/protocol";
import type { DesktopArchiveController } from "../archive/controller.js";

export const ARCHIVE_IPC_CHANNELS = Object.freeze({
  listSessions: "caelush:archive:list-sessions",
  listWorkspaces: "caelush:archive:list-workspaces",
  getState: "caelush:archive:get-state",
  archive: "caelush:archive:archive",
  restore: "caelush:archive:restore",
  previewDeletion: "caelush:archive:preview-deletion",
  permanentlyDelete: "caelush:archive:permanently-delete",
  readTranscript: "caelush:archive:read-transcript",
});
export type DesktopArchiveIpcRegistrar = <TInput, TOutput>(
  channel: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  action: (input: TInput, signal: AbortSignal) => unknown | Promise<unknown>,
  allowedStates?: ReadonlySet<string>,
  timeoutMs?: number,
  callerPolicy?: "LOGIN" | "AGENT" | "LOGIN_OR_AGENT",
  maxInputBytes?: number,
) => void;
const authorized = new Set(["AUTHENTICATED_ONLINE", "AUTHORIZED_OFFLINE"]);
export function registerArchiveHandlers(
  register: DesktopArchiveIpcRegistrar,
  controller: DesktopArchiveController,
): void {
  register(
    ARCHIVE_IPC_CHANNELS.listSessions,
    ArchiveSessionListQuerySchema,
    ArchiveSessionListResponseSchema,
    (input, signal) => controller.listSessions(input, signal),
    authorized,
  );
  register(
    ARCHIVE_IPC_CHANNELS.listWorkspaces,
    ArchiveWorkspaceListQuerySchema,
    ArchiveWorkspaceListResponseSchema,
    (input, signal) => controller.listWorkspaces(input, signal),
    authorized,
  );
  register(
    ARCHIVE_IPC_CHANNELS.getState,
    ArchiveTargetSchema,
    ArchiveStateSchema,
    (input, signal) => controller.getState(input, signal),
    authorized,
  );
  register(
    ARCHIVE_IPC_CHANNELS.archive,
    ArchiveTargetSchema,
    ArchiveMutationResponseSchema,
    (input, signal) => controller.archive(input, signal),
    authorized,
  );
  register(
    ARCHIVE_IPC_CHANNELS.restore,
    z
      .object({
        target: ArchiveTargetSchema,
        archiveId: RestoreArchiveRequestSchema.shape.archiveId,
      })
      .strict(),
    ArchiveMutationResponseSchema,
    (input, signal) => controller.restore(input, signal),
    authorized,
  );
  register(
    ARCHIVE_IPC_CHANNELS.previewDeletion,
    ArchiveDeletionSelectionSchema,
    ArchiveDeletionPreviewResponseSchema,
    (input, signal) => controller.previewDeletion(input, signal),
    authorized,
  );
  register(
    ARCHIVE_IPC_CHANNELS.permanentlyDelete,
    PermanentDeletionRequestSchema,
    PermanentDeletionResponseSchema,
    (input, signal) => controller.permanentlyDelete(input, signal),
    authorized,
    60000,
  );
  register(
    ARCHIVE_IPC_CHANNELS.readTranscript,
    z
      .object({ sessionId: SessionIdSchema, query: SessionTranscriptQuerySchema.optional() })
      .strict(),
    SessionTranscriptResponseSchema,
    (input, signal) => controller.readTranscript(input, signal),
    authorized,
  );
}
