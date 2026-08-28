import { EventStreamQuerySchema, type EventStreamQuery, type AgentEvent } from "@caelush/protocol";
import type { EventBus } from "@caelush/events";
import type { RunRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";
import type { FastifyInstance } from "fastify";
import { mapAgentEventToSse } from "../transport/sse-event-mapper.js";

export interface ActiveStreamRegistry {
  readonly controllers: Set<AbortController>;
}

async function* mapEvents(events: AsyncIterable<AgentEvent>) {
  for await (const event of events) yield mapAgentEventToSse(event);
}

export function registerEventStreamRoute(
  app: FastifyInstance,
  dependencies: {
    readonly runs: RunRepository;
    readonly eventBus: EventBus;
    readonly activeStreams: ActiveStreamRegistry;
  },
): void {
  app.get(
    "/api/v1/runs/:runId/events",
    {
      sse: "only",
      schema: { querystring: EventStreamQuerySchema },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = await dependencies.runs.get(runId as never);
      if (!run) throw new StorageNotFoundError("AgentRun", runId);

      const query = request.query as EventStreamQuery;
      const controller = new AbortController();
      dependencies.activeStreams.controllers.add(controller);
      reply.sse.onClose(() => controller.abort());

      try {
        await reply.sse.send(
          mapEvents(
            dependencies.eventBus.watch(runId as never, {
              afterSequence: query.afterSequence ?? 0,
              signal: controller.signal,
            }),
          ),
        );
      } finally {
        dependencies.activeStreams.controllers.delete(controller);
        controller.abort();
      }
    },
  );
}
