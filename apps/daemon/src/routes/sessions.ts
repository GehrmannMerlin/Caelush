import {
  AgentSessionSchema,
  CreateSessionRequestSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  type CreateSessionRequest,
  type SessionListQuery,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { SessionService } from "../services/session-service.js";

export function registerSessionRoutes(app: FastifyInstance, service: SessionService): void {
  app.post(
    "/api/v1/sessions",
    { schema: { body: CreateSessionRequestSchema, response: { 201: AgentSessionSchema } } },
    async (request, reply) => {
      const session = await service.createSession(request.body as CreateSessionRequest);
      return reply.code(201).send(session);
    },
  );

  app.get(
    "/api/v1/sessions",
    {
      schema: { querystring: SessionListQuerySchema, response: { 200: SessionListResponseSchema } },
    },
    async (request) => {
      const query = request.query as SessionListQuery;
      return { items: await service.listSessions(query.limit) };
    },
  );

  app.get(
    "/api/v1/sessions/:sessionId",
    { schema: { response: { 200: AgentSessionSchema } } },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      return service.getSession(sessionId as never);
    },
  );
}
