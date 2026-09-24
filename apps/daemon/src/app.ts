import fastify, { type FastifyInstance } from "fastify";
import { fastifySSE } from "@fastify/sse";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { DaemonInfo } from "@caelush/protocol";
import type { SessionRepository, RunRepository } from "@caelush/storage";
import type { DaemonConfig } from "./config.js";
import type { DaemonModelCanonicalizer } from "./providers/model-canonicalizer.js";
import { registerErrorHandling } from "./transport/error-handler.js";
import { assertLoopbackRequest } from "./transport/local-request-guard.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { SessionService } from "./services/session-service.js";
import { SessionTranscriptService } from "./services/session-transcript-service.js";
import { registerRunRoutes } from "./routes/runs.js";
import { RunService } from "./services/run-service.js";
import { registerEventStreamRoute } from "./routes/events.js";
import { registerExecutionRoutes, type DaemonExecutionSurface } from "./routes/execution.js";
import { registerInfoRoute } from "./routes/info.js";
import { registerWebStaticHost, type WebStaticHostOptions } from "./web/static-host.js";
import type { RunEventHub } from "./events/run-event-hub.js";
import { DefaultPublicEventProjector } from "./events/public-event-projector.js";
import type { PublicEventProjector } from "./events/public-event-projector.js";
import type { RunEvent } from "@caelush/protocol";

export interface DaemonDependencies {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly eventHub?: Pick<RunEventHub, "watch">;
  readonly publicEventProjector?: PublicEventProjector;
  readonly config: DaemonConfig;
  readonly activeStreams?: Set<AbortController>;
  readonly execution?: DaemonExecutionSurface;
  readonly info?: DaemonInfo;
  readonly modelCanonicalizer?: DaemonModelCanonicalizer;
  readonly transcript?: SessionTranscriptService;
  readonly logger?: boolean;
  readonly web?: WebStaticHostOptions;
}

export function buildDaemonApp(dependencies: DaemonDependencies): FastifyInstance {
  const app = fastify({ logger: dependencies.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(fastifySSE, { heartbeatInterval: dependencies.config.sseHeartbeatIntervalMs });
  app.addHook("onRequest", async (request) => assertLoopbackRequest(request));
  registerErrorHandling(app);
  registerHealthRoute(app);
  if (dependencies.info !== undefined) registerInfoRoute(app, dependencies.info);
  registerSessionRoutes(
    app,
    new SessionService({
      repository: dependencies.sessions,
      ...(dependencies.modelCanonicalizer === undefined
        ? {}
        : { modelCanonicalizer: dependencies.modelCanonicalizer }),
    }),
    dependencies.transcript === undefined ? {} : { transcript: dependencies.transcript },
  );
  registerRunRoutes(
    app,
    new RunService({
      sessions: dependencies.sessions,
      runs: dependencies.runs,
      ...(dependencies.modelCanonicalizer === undefined
        ? {}
        : { modelCanonicalizer: dependencies.modelCanonicalizer }),
    }),
  );
  if (dependencies.execution !== undefined) registerExecutionRoutes(app, dependencies.execution);
  if (dependencies.web !== undefined) registerWebStaticHost(app, dependencies.web);
  app.after(() => {
    const eventHub = dependencies.eventHub ?? {
      async *watch(): AsyncIterable<RunEvent> {
        throw new Error("RunEventHub is not composed.");
      },
    };
    registerEventStreamRoute(app, {
      runs: dependencies.runs,
      activeStreams: { controllers: dependencies.activeStreams ?? new Set() },
      eventHub,
      publicEventProjector: dependencies.publicEventProjector ?? new DefaultPublicEventProjector(),
    });
  });
  return app;
}
