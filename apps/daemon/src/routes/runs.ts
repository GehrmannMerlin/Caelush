import {
  ClientAgentRunSchema,
  CreateRunRequestSchema,
  RunListQuerySchema,
  RunListResponseSchema,
  type CreateRunRequest,
  type RunListQuery,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { RunService } from "../services/run-service.js";
import { toClientAgentRun } from "../services/public-projection.js";

export function registerRunRoutes(app: FastifyInstance, service: RunService): void {
  app.post(
    "/api/v1/sessions/:sessionId/runs",
    { schema: { body: CreateRunRequestSchema, response: { 201: ClientAgentRunSchema } } },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const abortController = new AbortController();
      const onAborted = () => abortController.abort();
      request.raw.once("aborted", onAborted);
      try {
        const run = await service.createRun(
          sessionId as never,
          request.body as CreateRunRequest,
          abortController.signal,
        );
        return reply.code(201).send(toClientAgentRun(run));
      } finally {
        request.raw.removeListener("aborted", onAborted);
      }
    },
  );

  app.get(
    "/api/v1/sessions/:sessionId/runs",
    { schema: { querystring: RunListQuerySchema, response: { 200: RunListResponseSchema } } },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      return {
        items: (await service.listRuns(sessionId as never, request.query as RunListQuery)).map(
          toClientAgentRun,
        ),
      };
    },
  );

  app.get(
    "/api/v1/runs/:runId",
    { schema: { response: { 200: ClientAgentRunSchema } } },
    async (request) => {
      const { runId } = request.params as { runId: string };
      return toClientAgentRun(await service.getRun(runId as never));
    },
  );
}
