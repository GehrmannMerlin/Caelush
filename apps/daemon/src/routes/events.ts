import { EventStreamQuerySchema, type EventStreamQuery, type AgentEvent } from "@caelush/protocol";
import type { EventBus } from "@caelush/events";
import type { RunRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";
import type { FastifyInstance } from "fastify";
import { mapAgentEventToSse } from "../transport/sse-event-mapper.js";
import { InvalidEventCursorError } from "../transport/error-handler.js";

export interface ActiveStreamRegistry {
  readonly controllers: Set<AbortController>;
}

async function* mapEvents(events: AsyncIterable<AgentEvent>) {
  for await (const event of events) yield mapAgentEventToSse(event);
}

function parseCursor(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) return value;
    throw new InvalidEventCursorError();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new InvalidEventCursorError();
}

export function resolveEventCursor(
  lastEventId: string | undefined,
  queryAfterSequence: unknown,
): number {
  const headerCursor = parseCursor(lastEventId);
  const queryCursor = parseCursor(queryAfterSequence);
  if (headerCursor !== undefined && queryCursor !== undefined && headerCursor !== queryCursor) {
    throw new InvalidEventCursorError();
  }
  return headerCursor ?? queryCursor ?? 0;
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
      const header = request.headers["last-event-id"];
      const lastEventId = Array.isArray(header) ? header[0] : header;
      const afterSequence = resolveEventCursor(lastEventId, query.afterSequence);
      const controller = new AbortController();
      dependencies.activeStreams.controllers.add(controller);
      reply.sse.onClose(() => controller.abort());

      try {
        await reply.sse.send(
          mapEvents(
            dependencies.eventBus.watch(runId as never, {
              afterSequence,
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
