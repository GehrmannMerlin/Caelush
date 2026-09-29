import {
  CreateWorkspaceRequestSchema,
  WorkspaceIdParamSchema,
  WorkspaceDirectoryPickerResponseSchema,
  WorkspaceListQuerySchema,
  WorkspaceListResponseSchema,
  WorkspaceRecordSchema,
  WorkspaceSessionListResponseSchema,
  type WorkspaceId,
  type CreateWorkspaceRequest,
  type WorkspaceListQuery,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import type { RunRepository, SessionRepository } from "@caelush/storage";
import { WorkspaceService } from "../workspaces/workspace-service.js";
import type { WorkspaceDirectoryPicker } from "../workspaces/workspace-picker.js";
import { WorkspaceSessionService } from "../services/workspace-session-service.js";

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  service: WorkspaceService,
  dependencies: {
    readonly sessions?: SessionRepository;
    readonly runs?: RunRepository;
    readonly workspacePicker?: WorkspaceDirectoryPicker;
  } = {},
): void {
  if (dependencies.workspacePicker !== undefined) {
    app.post(
      "/api/v1/workspaces/pick",
      { schema: { response: { 200: WorkspaceDirectoryPickerResponseSchema } } },
      async () => dependencies.workspacePicker!.pick(),
    );
  }

  app.post(
    "/api/v1/workspaces",
    {
      schema: {
        body: CreateWorkspaceRequestSchema,
        response: { 200: WorkspaceRecordSchema, 201: WorkspaceRecordSchema },
      },
    },
    async (request, reply) => {
      const registration = await service.registerWorkspace(request.body as CreateWorkspaceRequest);
      return reply.code(registration.created ? 201 : 200).send(registration.workspace);
    },
  );

  app.get(
    "/api/v1/workspaces",
    {
      schema: {
        querystring: WorkspaceListQuerySchema,
        response: { 200: WorkspaceListResponseSchema },
      },
    },
    async (request) => {
      const query = request.query as WorkspaceListQuery;
      return { items: await service.listWorkspaces(query.limit) };
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId",
    {
      schema: {
        params: WorkspaceIdParamSchema,
        response: { 200: WorkspaceRecordSchema },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      return service.requireWorkspace(workspaceId as never);
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId",
    { schema: { params: WorkspaceIdParamSchema } },
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await service.removeWorkspace(workspaceId as never);
      return reply.code(204).send(null);
    },
  );

  if (dependencies.sessions !== undefined && dependencies.runs !== undefined) {
    const sessionService = new WorkspaceSessionService({
      sessions: dependencies.sessions,
      runs: dependencies.runs,
      workspaceService: service,
    });
    app.get(
      "/api/v1/workspaces/:workspaceId/sessions",
      {
        schema: {
          params: WorkspaceIdParamSchema,
          querystring: WorkspaceListQuerySchema,
          response: { 200: WorkspaceSessionListResponseSchema },
        },
      },
      async (request) => {
        const { workspaceId } = request.params as { workspaceId: string };
        const query = request.query as WorkspaceListQuery;
        return {
          items: await sessionService.listSessions(workspaceId as WorkspaceId, query.limit),
        };
      },
    );
  }
}
