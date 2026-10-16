import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ArchiveTargetSchema,
  ArchiveSessionListQuerySchema,
  ArchiveSessionListResponseSchema,
  ArchiveWorkspaceListQuerySchema,
  ArchiveWorkspaceListResponseSchema,
  ArchiveStateSchema,
  ArchiveMutationResponseSchema,
  RestoreArchiveRequestSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  ArchiveDeletionSelectionSchema,
  ArchiveDeletionPreviewResponseSchema,
  PermanentDeletionRequestSchema,
  PermanentDeletionResponseSchema,
  LegacyArchiveImportRequestSchema,
  LegacyArchiveImportResponseSchema,
  type ArchiveSessionListQuery,
  type ArchiveWorkspaceListQuery,
  type ArchiveTarget,
  type ArchiveDeletionSelection,
  type LegacyArchiveImportRequest,
  type RestoreArchiveRequest,
  type SessionId,
  type WorkspaceId,
} from "@caelush/protocol";
import type { ArchiveService } from "../services/archive-service.js";

export function registerArchiveRoutes(app: FastifyInstance, service: ArchiveService): void {
  app.get(
    "/api/v1/archives/sessions",
    {
      schema: {
        querystring: ArchiveSessionListQuerySchema,
        response: { 200: ArchiveSessionListResponseSchema },
      },
    },
    async (request) => service.listSessions(request.query as ArchiveSessionListQuery),
  );
  app.get(
    "/api/v1/archives/workspaces",
    {
      schema: {
        querystring: ArchiveWorkspaceListQuerySchema,
        response: { 200: ArchiveWorkspaceListResponseSchema },
      },
    },
    async (request) => service.listWorkspaces(request.query as ArchiveWorkspaceListQuery),
  );
  app.get(
    "/api/v1/archives/state",
    { schema: { querystring: ArchiveTargetSchema, response: { 200: ArchiveStateSchema } } },
    async (request) => service.getState(request.query as ArchiveTarget),
  );
  for (const kind of ["sessions", "workspaces"] as const) {
    const paramName = kind === "sessions" ? "sessionId" : "workspaceId";
    const params =
      kind === "sessions"
        ? z.object({ sessionId: SessionIdSchema }).strict()
        : z.object({ workspaceId: WorkspaceIdSchema }).strict();
    const target = (value: unknown): ArchiveTarget => {
      const ids = value as { sessionId: SessionId; workspaceId: WorkspaceId };
      return kind === "sessions"
        ? { type: "SESSION", sessionId: ids.sessionId }
        : { type: "WORKSPACE", workspaceId: ids.workspaceId };
    };
    app.post(
      `/api/v1/${kind}/:${paramName}/archive`,
      {
        schema: {
          params,
          body: z.object({}).strict(),
          response: { 200: ArchiveMutationResponseSchema },
        },
      },
      async (request) => service.archive(target(request.params)),
    );
    app.post(
      `/api/v1/${kind}/:${paramName}/restore`,
      {
        schema: {
          params,
          body: RestoreArchiveRequestSchema,
          response: { 200: ArchiveMutationResponseSchema },
        },
      },
      async (request) =>
        service.restore(target(request.params), (request.body as RestoreArchiveRequest).archiveId),
    );
  }
  app.post(
    "/api/v1/archives/deletion-preview",
    {
      schema: {
        body: ArchiveDeletionSelectionSchema,
        response: { 200: ArchiveDeletionPreviewResponseSchema },
      },
    },
    async (request) => service.previewDeletion(request.body as ArchiveDeletionSelection),
  );
  app.post(
    "/api/v1/archives/permanent-deletions",
    {
      schema: {
        body: PermanentDeletionRequestSchema,
        response: { 200: PermanentDeletionResponseSchema },
      },
    },
    async (request) =>
      service.permanentlyDelete((request.body as { confirmationToken: string }).confirmationToken),
  );
  app.post(
    "/api/v1/archives/legacy-import",
    {
      schema: {
        body: LegacyArchiveImportRequestSchema,
        response: { 200: LegacyArchiveImportResponseSchema },
      },
    },
    async (request) => service.importLegacyMarkers(request.body as LegacyArchiveImportRequest),
  );
}
