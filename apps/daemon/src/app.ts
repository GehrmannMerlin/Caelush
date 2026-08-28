import fastify, { type FastifyInstance } from "fastify";
import { fastifySSE } from "@fastify/sse";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { EventBus } from "@caelush/events";
import type { SessionRepository, RunRepository } from "@caelush/storage";
import type { DaemonConfig } from "./config.js";
import { registerErrorHandling } from "./transport/error-handler.js";
import { assertLoopbackRequest } from "./transport/local-request-guard.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { SessionService } from "./services/session-service.js";
import { registerRunRoutes } from "./routes/runs.js";
import { RunService } from "./services/run-service.js";
import { registerEventStreamRoute } from "./routes/events.js";

export interface DaemonDependencies {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly eventBus: EventBus;
  readonly config: DaemonConfig;
  readonly activeStreams?: Set<AbortController>;
}

export function buildDaemonApp(dependencies: DaemonDependencies): FastifyInstance {
  const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(fastifySSE, { heartbeatInterval: dependencies.config.sseHeartbeatIntervalMs });
  app.addHook("onRequest", async (request) => assertLoopbackRequest(request));
  registerErrorHandling(app);
  registerHealthRoute(app);
  registerSessionRoutes(app, new SessionService({ repository: dependencies.sessions }));
  registerRunRoutes(
    app,
    new RunService({ sessions: dependencies.sessions, runs: dependencies.runs }),
  );
  app.after(() => {
    registerEventStreamRoute(app, {
      runs: dependencies.runs,
      eventBus: dependencies.eventBus,
      activeStreams: { controllers: dependencies.activeStreams ?? new Set() },
    });
  });
  void dependencies;
  return app;
}
