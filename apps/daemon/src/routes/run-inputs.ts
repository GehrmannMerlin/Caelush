import {
  RunInputListQuerySchema,
  RunInputListResponseSchema,
  RunInputReceiptSchema,
  SubmitRunInputRequestSchema,
  type RunId,
  type RunInputListQuery,
  type SubmitRunInputRequest,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";
import type { RunInputService } from "../services/run-input-intake.js";

export interface DaemonRunInputSurface {
  readonly runInputs: Pick<RunInputService, "submit" | "list">;
}

/**
 * The Run input intake endpoints.
 *
 * ```text
 * POST /api/v1/runs/:runId/inputs   accept one stable-identity text input
 * GET  /api/v1/runs/:runId/inputs   a bounded, stably ordered page of receipts
 * ```
 *
 * The route binds the target from the path and the identity from the body; it never lets a body
 * field redirect the write to another Run or session. Accepting here is not executing: the Run's
 * single driver applies the input at its next safe boundary.
 */
export function registerRunInputRoutes(app: FastifyInstance, surface: DaemonRunInputSurface): void {
  app.post(
    "/api/v1/runs/:runId/inputs",
    {
      schema: {
        body: SubmitRunInputRequestSchema,
        response: { 200: RunInputReceiptSchema, 202: RunInputReceiptSchema },
      },
    },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const body = request.body as SubmitRunInputRequest;
      const receipt = await surface.runInputs.submit(runId as RunId, body);
      // The acceptance is durable before this response exists, so 202 describes scheduling, not an
      // uncertain write. A retry of the same identity answers 200 with the same fact.
      return reply.code(202).send(receipt);
    },
  );

  app.get(
    "/api/v1/runs/:runId/inputs",
    {
      schema: {
        querystring: RunInputListQuerySchema,
        response: { 200: RunInputListResponseSchema },
      },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const query = request.query as RunInputListQuery;
      return surface.runInputs.list(runId as RunId, query);
    },
  );
}
