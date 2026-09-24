import { EventStreamQuerySchema, type EventStreamQuery, type AgentEvent } from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";
import type { FastifyInstance } from "fastify";
import { mapAgentEventToSse } from "../transport/sse-event-mapper.js";
import { InvalidEventCursorError } from "../transport/error-handler.js";
import type { RunEventHub } from "../events/run-event-hub.js";

export interface ActiveStreamRegistry {
  readonly controllers: Set<AbortController>;
}

async function* mapEvents(events: AsyncIterable<AgentEvent>) {
  for await (const event of events) yield mapAgentEventToSse(event);
}

function parseCursor(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new InvalidEventCursorError();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
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
    readonly eventHub?: Pick<RunEventHub, "watch">;
    /** @deprecated Compatibility watch port for legacy test hosts. */
    readonly eventBus?: Pick<RunEventHub, "watch">;
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
        const eventSource = dependencies.eventHub ?? dependencies.eventBus;
        if (eventSource === undefined) throw new Error("RunEventHub is not composed.");
        await reply.sse.send(
          mapEvents(
            eventSource.watch(runId as never, {
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
