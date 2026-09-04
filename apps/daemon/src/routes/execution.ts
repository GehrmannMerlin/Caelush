import {
  ApprovalListQuerySchema,
  ApprovalListResponseSchema,
  ApprovalResolutionRequestSchema,
  RunActionResponseSchema,
  ContextUsageResponseSchema,
  type ApprovalResolutionRequest,
  type RunId,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import { StorageNotFoundError, type RunRepository } from "@caelush/storage";
import type {
  RunExecutionSupervisor,
  RunExecutionSupervisorResult,
} from "../execution/run-execution-supervisor.js";
import { toClientAgentRun } from "../services/public-projection.js";

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
    getContextUsage(
      runId: RunId,
    ): Promise<import("@caelush/context").ContextUsageProjection | undefined>;
  };
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
