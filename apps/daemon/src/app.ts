import fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { EventBus } from "@caelush/events";
import type { SessionRepository, RunRepository } from "@caelush/storage";
import type { DaemonConfig } from "./config.js";
import { registerErrorHandling } from "./transport/error-handler.js";
import { assertLoopbackRequest } from "./transport/local-request-guard.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { SessionService } from "./services/session-service.js";

export interface DaemonDependencies {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly eventBus: EventBus;
  readonly config: DaemonConfig;
}

export function buildDaemonApp(dependencies: DaemonDependencies): FastifyInstance {
  const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRequest", async (request) => assertLoopbackRequest(request));
  registerErrorHandling(app);
  registerHealthRoute(app);
  registerSessionRoutes(app, new SessionService({ repository: dependencies.sessions }));
  void dependencies;
  return app;
}
