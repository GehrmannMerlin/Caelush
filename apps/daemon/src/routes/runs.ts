import {
  AgentRunSchema,
  CreateRunRequestSchema,
  RunListQuerySchema,
  RunListResponseSchema,
  type CreateRunRequest,
  type RunListQuery,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { RunService } from "../services/run-service.js";

export function registerRunRoutes(app: FastifyInstance, service: RunService): void {
  app.post(
    "/api/v1/sessions/:sessionId/runs",
    { schema: { body: CreateRunRequestSchema, response: { 201: AgentRunSchema } } },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const run = await service.createRun(sessionId as never, request.body as CreateRunRequest);
      return reply.code(201).send(run);
    },
  );

  app.get(
    "/api/v1/sessions/:sessionId/runs",
    { schema: { querystring: RunListQuerySchema, response: { 200: RunListResponseSchema } } },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      return {
        items: await service.listRuns(sessionId as never, request.query as RunListQuery),
      };
    },
  );

  app.get(
    "/api/v1/runs/:runId",
    { schema: { response: { 200: AgentRunSchema } } },
    async (request) => {
      const { runId } = request.params as { runId: string };
      return service.getRun(runId as never);
    },
  );
}
