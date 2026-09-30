import {
  ClientAgentSessionSchema,
  CreateSessionRequestSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionTranscriptQuerySchema,
  SessionTranscriptResponseSchema,
  UpdateSessionModelSelectionRequestSchema,
  type CreateSessionRequest,
  type SessionListQuery,
  type SessionTranscriptQuery,
  type UpdateSessionModelSelectionRequest,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { SessionService } from "../services/session-service.js";
import { SessionTranscriptService } from "../services/session-transcript-service.js";
import { toClientAgentSession } from "../services/public-projection.js";
import { AIConfigurationService } from "../services/ai-configuration-service.js";

export function registerSessionRoutes(
  app: FastifyInstance,
  service: SessionService,
  dependencies: {
    readonly transcript?: SessionTranscriptService;
    readonly aiConfiguration?: AIConfigurationService;
  } = {},
): void {
  app.post(
    "/api/v1/sessions",
    { schema: { body: CreateSessionRequestSchema, response: { 201: ClientAgentSessionSchema } } },
    async (request, reply) => {
      const session = await service.createSession(request.body as CreateSessionRequest);
      return reply.code(201).send(toClientAgentSession(session));
    },
  );

  app.get(
    "/api/v1/sessions",
    {
      schema: { querystring: SessionListQuerySchema, response: { 200: SessionListResponseSchema } },
    },
    async (request) => {
      const query = request.query as SessionListQuery;
      return { items: (await service.listSessions(query.limit)).map(toClientAgentSession) };
    },
  );

  if (dependencies.aiConfiguration !== undefined) {
    app.put(
      "/api/v1/sessions/:sessionId/model-selection",
      {
        schema: {
          body: UpdateSessionModelSelectionRequestSchema,
          response: { 200: ClientAgentSessionSchema },
        },
      },
      async (request) => {
        const { sessionId } = request.params as { sessionId: string };
        const updated = await dependencies.aiConfiguration!.updateSessionSelection(
          sessionId as never,
          request.body as UpdateSessionModelSelectionRequest,
        );
        return toClientAgentSession(updated);
      },
    );
  }

  app.get(
    "/api/v1/sessions/:sessionId",
    { schema: { response: { 200: ClientAgentSessionSchema } } },
    async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      return toClientAgentSession(await service.getSession(sessionId as never));
    },
  );

  if (dependencies.transcript !== undefined) {
    app.get(
      "/api/v1/sessions/:sessionId/transcript",
      {
        schema: {
          querystring: SessionTranscriptQuerySchema,
          response: { 200: SessionTranscriptResponseSchema },
        },
      },
      async (request) => {
        const { sessionId } = request.params as { sessionId: string };
        const query = request.query as SessionTranscriptQuery;
        return dependencies.transcript!.getTranscript(sessionId as never, query);
      },
    );
  }
}
