import fastify, { type FastifyInstance } from "fastify";
import { fastifySSE } from "@fastify/sse";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { DaemonInfo } from "@caelush/protocol";
import type { SessionRepository, RunRepository, WorkspaceRepository } from "@caelush/storage";
import type { DaemonConfig } from "./config.js";
import type { DaemonModelCanonicalizer } from "./providers/model-canonicalizer.js";
import { registerErrorHandling } from "./transport/error-handler.js";
import { assertLoopbackRequest } from "./transport/local-request-guard.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { SessionService } from "./services/session-service.js";
import { SessionTranscriptService } from "./services/session-transcript-service.js";
import { SessionPresentationService } from "./services/session-presentation-service.js";
import { registerRunRoutes } from "./routes/runs.js";
import { RunService } from "./services/run-service.js";
import { registerEventStreamRoute } from "./routes/events.js";
import { registerExecutionRoutes, type DaemonExecutionSurface } from "./routes/execution.js";
import { registerInfoRoute } from "./routes/info.js";
import { registerWebStaticHost, type WebStaticHostOptions } from "./web/static-host.js";
import type { RunEventHub } from "./events/run-event-hub.js";
import { DefaultPublicEventProjector } from "./events/public-event-projector.js";
import type { PublicEventProjector } from "./events/public-event-projector.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { WorkspaceService } from "./workspaces/workspace-service.js";
import type { WorkspaceDirectoryPicker } from "./workspaces/workspace-picker.js";
import { registerAIRoutes } from "./routes/ai.js";
import { AIConfigurationService } from "./services/ai-configuration-service.js";

export interface DaemonDependencies {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly workspaces?: WorkspaceRepository;
  readonly workspaceService?: WorkspaceService;
  readonly workspacePicker?: WorkspaceDirectoryPicker;
  readonly eventHub: Pick<RunEventHub, "watch">;
  readonly publicEventProjector?: PublicEventProjector;
  readonly config: DaemonConfig;
  readonly activeStreams?: Set<AbortController>;
  readonly execution?: DaemonExecutionSurface;
  readonly info?: DaemonInfo;
  readonly modelCanonicalizer?: DaemonModelCanonicalizer;
  readonly transcript?: SessionTranscriptService;
  readonly presentation?: SessionPresentationService;
  readonly logger?: boolean;
  readonly web?: WebStaticHostOptions;
  readonly aiConfiguration?: AIConfigurationService;
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
  if (dependencies.workspaceService !== undefined) {
    registerWorkspaceRoutes(app, dependencies.workspaceService, {
      sessions: dependencies.sessions,
      runs: dependencies.runs,
      ...(dependencies.workspacePicker === undefined
        ? {}
        : { workspacePicker: dependencies.workspacePicker }),
    });
  }
  const sessionService = new SessionService({
    repository: dependencies.sessions,
    ...(dependencies.modelCanonicalizer === undefined
      ? {}
      : { modelCanonicalizer: dependencies.modelCanonicalizer }),
    ...(dependencies.workspaceService === undefined
      ? {}
      : { workspaceService: dependencies.workspaceService }),
    ...(dependencies.aiConfiguration === undefined
      ? {}
      : {
          defaultSelection: () => dependencies.aiConfiguration!.getNewSessionSelection(),
          validateSelection: (selection) =>
            dependencies.aiConfiguration!.validateSelection(selection),
        }),
  });
  registerSessionRoutes(app, sessionService, {
    ...(dependencies.transcript === undefined ? {} : { transcript: dependencies.transcript }),
    ...(dependencies.presentation === undefined ? {} : { presentation: dependencies.presentation }),
    ...(dependencies.aiConfiguration === undefined
      ? {}
      : { aiConfiguration: dependencies.aiConfiguration }),
  });
  registerRunRoutes(
    app,
    new RunService({
      sessions: dependencies.sessions,
      runs: dependencies.runs,
      ...(dependencies.modelCanonicalizer === undefined
        ? {}
        : { modelCanonicalizer: dependencies.modelCanonicalizer }),
      ...(dependencies.workspaceService === undefined
        ? {}
        : { workspaceService: dependencies.workspaceService }),
      ...(dependencies.aiConfiguration === undefined
        ? {}
        : {
            validateSelection: (selection, context) =>
              dependencies.aiConfiguration!.validateRunSelection(selection, context),
          }),
    }),
  );
  if (dependencies.aiConfiguration !== undefined) {
    registerAIRoutes(app, dependencies.aiConfiguration);
  }
  if (dependencies.execution !== undefined) registerExecutionRoutes(app, dependencies.execution);
  if (dependencies.web !== undefined) registerWebStaticHost(app, dependencies.web);
  app.after(() => {
    registerEventStreamRoute(app, {
      runs: dependencies.runs,
      activeStreams: { controllers: dependencies.activeStreams ?? new Set() },
      eventHub: dependencies.eventHub,
      publicEventProjector: dependencies.publicEventProjector ?? new DefaultPublicEventProjector(),
    });
  });
  return app;
}
