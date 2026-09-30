import {
  AIDefaultSelectionResponseSchema,
  AIModelDirectoryResponseSchema,
  AIProviderConnectionResponseSchema,
  AIProvidersResponseSchema,
  ConnectProviderRequestSchema,
  UpdateAISelectionRequestSchema,
  type ConnectProviderRequest,
  type UpdateAISelectionRequest,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { AIConfigurationService } from "../services/ai-configuration-service.js";
import { z } from "zod";

const modelDirectoryQuerySchema = z.object({ provider: z.string().min(1).optional() }).strict();

export function registerAIRoutes(app: FastifyInstance, service: AIConfigurationService): void {
  app.get(
    "/api/v1/ai/providers",
    { schema: { response: { 200: AIProvidersResponseSchema } } },
    async () => service.listProviders(),
  );

  app.post(
    "/api/v1/ai/providers/:providerId/connect",
    {
      schema: {
        body: ConnectProviderRequestSchema,
        response: { 200: AIProviderConnectionResponseSchema },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params as { providerId: string };
      const body = request.body as ConnectProviderRequest;
      return reply.code(200).send(await service.connect(providerId, body));
    },
  );

  app.delete("/api/v1/ai/providers/:providerId/credential", async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    await service.disconnect(providerId);
    return reply.code(204).send();
  });

  app.get(
    "/api/v1/ai/models",
    {
      schema: {
        querystring: modelDirectoryQuerySchema,
        response: { 200: AIModelDirectoryResponseSchema },
      },
    },
    async (request) => {
      const query = request.query as { provider?: string };
      return service.getDirectory(query.provider);
    },
  );

  app.get(
    "/api/v1/ai/providers/:providerId/models",
    { schema: { response: { 200: AIModelDirectoryResponseSchema } } },
    async (request) => {
      const { providerId } = request.params as { providerId: string };
      return service.getDirectory(providerId);
    },
  );

  app.get(
    "/api/v1/ai/default-selection",
    { schema: { response: { 200: AIDefaultSelectionResponseSchema } } },
    async () => service.getDefaultSelection(),
  );

  app.put(
    "/api/v1/ai/default-selection",
    {
      schema: {
        body: UpdateAISelectionRequestSchema,
        response: { 200: AIDefaultSelectionResponseSchema },
      },
    },
    async (request) => service.setDefaultSelection(request.body as UpdateAISelectionRequest),
  );
}
