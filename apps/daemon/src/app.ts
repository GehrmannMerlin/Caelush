import fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { EventBus } from "@caelush/events";
import type { SessionRepository, RunRepository } from "@caelush/storage";
import type { DaemonConfig } from "./config.js";

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
  void dependencies;
  return app;
}
