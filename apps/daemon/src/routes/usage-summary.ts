import {
  UsageSummaryQuerySchema,
  UsageSummaryResponseSchema,
  type UsageSummaryQuery,
} from "@caelush/protocol";
import type { ProviderInvocationUsageSummary } from "@caelush/storage";
import type { FastifyInstance } from "fastify";

export interface ProviderUsageSummaryReader {
  getSummary(since: number): Promise<ProviderInvocationUsageSummary>;
}

export function registerUsageSummaryRoute(
  app: FastifyInstance,
  reader: ProviderUsageSummaryReader,
): void {
  app.get(
    "/api/v1/usage/summary",
    {
      schema: {
        querystring: UsageSummaryQuerySchema,
        response: { 200: UsageSummaryResponseSchema },
      },
    },
    async (request) => reader.getSummary((request.query as UsageSummaryQuery).sinceMs),
  );
}
