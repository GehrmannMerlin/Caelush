import {
  SecurityCapabilitiesResponseSchema,
  SecurityPreparationRequestSchema,
  SecurityPreparationResponseSchema,
  WorkspaceIdParamSchema,
  WorkspaceSecurityCapabilitiesResponseSchema,
  type PermissionPresetSelection,
  type WorkspaceId,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import type { SecurityCapabilityService } from "../services/security-capability-service.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";

export function registerSecurityRoutes(
  app: FastifyInstance,
  service: SecurityCapabilityService,
  dependencies: { readonly workspaceService?: WorkspaceService } = {},
): void {
  app.get(
    "/api/v1/security/capabilities",
    { schema: { response: { 200: SecurityCapabilitiesResponseSchema } } },
    async () => service.getGlobalCapabilities(),
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/security/capabilities",
    {
      schema: {
        params: WorkspaceIdParamSchema,
        response: { 200: WorkspaceSecurityCapabilitiesResponseSchema },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await dependencies.workspaceService?.requireWorkspace(workspaceId as WorkspaceId);
      return service.getWorkspaceCapabilities(workspaceId as WorkspaceId);
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/security/prepare",
    {
      schema: {
        params: WorkspaceIdParamSchema,
        body: SecurityPreparationRequestSchema,
        response: { 200: SecurityPreparationResponseSchema },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as { preset: PermissionPresetSelection };
      await dependencies.workspaceService?.requireWorkspace(workspaceId as WorkspaceId);
      return service.prepareWorkspace(workspaceId as WorkspaceId, body.preset);
    },
  );

  // Keep a narrow alias for hosts that describe the workspace capability resource without the
  // trailing collection segment. Both paths are the same capability authority.
  app.get(
    "/api/v1/workspaces/:workspaceId/security",
    {
      schema: {
        params: WorkspaceIdParamSchema,
        response: { 200: WorkspaceSecurityCapabilitiesResponseSchema },
      },
    },
    async (request) => {
      const { workspaceId } = request.params as { workspaceId: string };
      await dependencies.workspaceService?.requireWorkspace(workspaceId as WorkspaceId);
      return service.getWorkspaceCapabilities(workspaceId as WorkspaceId);
    },
  );
}
