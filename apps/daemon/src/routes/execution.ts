import {
  ApprovalListQuerySchema,
  ApprovalListResponseSchema,
  ApprovalResolutionRequestSchema,
  RunActionResponseSchema,
  ContextUsageResponseSchema,
  HistoryLookupQuerySchema,
  HistoryLookupResponseSchema,
  type ApprovalResolutionRequest,
  type RunId,
  type ContextUsageProjection,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { StorageNotFoundError, type RunRepository } from "@caelush/storage";
import type {
  RunExecutionSupervisor,
  RunExecutionSupervisorResult,
} from "../execution/run-execution-supervisor.js";
import type { HistoryLookupOperations } from "@caelush/agent";
import { toClientAgentRun } from "../services/public-projection.js";
import { registerRunInputRoutes } from "./run-inputs.js";
import type { RunInputService } from "../services/run-input-intake.js";

export interface DaemonExecutionSurface {
  readonly runs: Pick<RunRepository, "get">;
  readonly supervisor: Pick<
    RunExecutionSupervisor,
    "start" | "recover" | "cancel" | "resolveApproval" | "continueResourceGuard"
  >;
  readonly approvals: {
    listPendingByRun(runId: RunId): Promise<readonly import("@caelush/protocol").ApprovalRequest[]>;
  };
  readonly contextUsage?: {
    getContextUsage(runId: RunId): Promise<ContextUsageProjection | undefined>;
  };
  readonly historyLookup?: HistoryLookupOperations;
  /**
   * Present only when the durable intake → canonical USER → next model step path is composed.
   * A daemon without it must not advertise `runInputV1`.
   */
  readonly runInputs?: Pick<RunInputService, "submit" | "list"> | undefined;
}

function toActionResponse(result: RunExecutionSupervisorResult) {
  return RunActionResponseSchema.parse({
    runId: result.runId,
    action: result.action,
    disposition: result.disposition,
    run: toClientAgentRun(result.run),
  });
}

export function registerExecutionRoutes(
  app: FastifyInstance,
  surface: DaemonExecutionSurface,
): void {
  if (surface.runInputs !== undefined) {
    registerRunInputRoutes(app, { runInputs: surface.runInputs });
  }

  app.post(
    "/api/v1/runs/:runId/start",
    { schema: { response: { 200: RunActionResponseSchema, 202: RunActionResponseSchema } } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const result = toActionResponse(await surface.supervisor.start(runId as RunId));
      return reply.code(result.disposition === "NOOP_TERMINAL" ? 200 : 202).send(result);
    },
  );

  app.post(
    "/api/v1/runs/:runId/recover",
    { schema: { response: { 200: RunActionResponseSchema, 202: RunActionResponseSchema } } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const result = toActionResponse(await surface.supervisor.recover(runId as RunId));
      return reply.code(result.disposition === "NOOP_TERMINAL" ? 200 : 202).send(result);
    },
  );

  app.post(
    "/api/v1/runs/:runId/cancel",
    { schema: { response: { 200: RunActionResponseSchema } } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      return reply
        .code(200)
        .send(toActionResponse(await surface.supervisor.cancel(runId as RunId)));
    },
  );

  app.post(
    "/api/v1/runs/:runId/continue-resource",
    { schema: { response: { 200: RunActionResponseSchema, 202: RunActionResponseSchema } } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const result = toActionResponse(
        await surface.supervisor.continueResourceGuard(runId as RunId),
      );
      return reply.code(result.disposition === "NOOP_TERMINAL" ? 200 : 202).send(result);
    },
  );

  app.get(
    "/api/v1/runs/:runId/approvals",
    {
      schema: {
        querystring: ApprovalListQuerySchema,
        response: { 200: ApprovalListResponseSchema },
      },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      if ((await surface.runs.get(runId as RunId)) === null) {
        throw new StorageNotFoundError("AgentRun", runId);
      }
      return { items: await surface.approvals.listPendingByRun(runId as RunId) };
    },
  );

  app.get(
    "/api/v1/runs/:runId/context-usage",
    { schema: { response: { 200: ContextUsageResponseSchema } } },
    async (request) => {
      const { runId } = request.params as { runId: string };
      if ((await surface.runs.get(runId as RunId)) === null) {
        throw new StorageNotFoundError("AgentRun", runId);
      }
      return (await surface.contextUsage?.getContextUsage(runId as RunId)) ?? null;
    },
  );

  app.get(
    "/api/v1/runs/:runId/history",
    {
      schema: {
        querystring: HistoryLookupQuerySchema,
        response: { 200: HistoryLookupResponseSchema },
      },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const run = await surface.runs.get(runId as RunId);
      if (run === null) throw new StorageNotFoundError("AgentRun", runId);
      if (surface.historyLookup === undefined) {
        return { kind: "UNAVAILABLE", reason: "SOURCE_UNAVAILABLE" } as const;
      }
      const query = request.query as import("@caelush/protocol").HistoryLookupQuery;
      return surface.historyLookup.read(
        {
          sourceRef: query.sourceRef,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.maxBytes === undefined ? {} : { maxBytes: query.maxBytes }),
        },
        { runId: run.id, sessionId: run.sessionId },
        new AbortController().signal,
      );
    },
  );

  app.post(
    "/api/v1/runs/:runId/approvals/:approvalId/resolve",
    {
      schema: {
        body: ApprovalResolutionRequestSchema,
        response: { 200: RunActionResponseSchema, 202: RunActionResponseSchema },
      },
    },
    async (request, reply) => {
      const { runId, approvalId } = request.params as { runId: string; approvalId: string };
      const resolution = request.body as ApprovalResolutionRequest;
      const result = toActionResponse(
        await surface.supervisor.resolveApproval(runId as RunId, approvalId as never, resolution),
      );
      return reply.code(result.disposition === "NOOP_TERMINAL" ? 200 : 202).send(result);
    },
  );
}
