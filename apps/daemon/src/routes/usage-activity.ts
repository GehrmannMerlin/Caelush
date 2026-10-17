import {
  UsageActivityQuerySchema,
  UsageActivityResponseSchema,
  type UsageActivityQuery,
  type UsageActivityResponse,
} from "@caelush/protocol";
import type { FastifyInstance } from "fastify";

export interface ProviderUsageActivityReader {
  getActivity(
    since: number,
    timezoneOffsetMinutes: number,
  ): Promise<readonly UsageActivityResponse["days"][number][]>;
}

export function registerUsageActivityRoute(
  app: FastifyInstance,
  reader: ProviderUsageActivityReader,
): void {
  app.get(
    "/api/v1/usage/activity",
    {
      schema: {
        querystring: UsageActivityQuerySchema,
        response: { 200: UsageActivityResponseSchema },
      },
    },
    async (request): Promise<UsageActivityResponse> => {
      const query = request.query as UsageActivityQuery;
      return {
        days: [...(await reader.getActivity(query.sinceMs, query.timezoneOffsetMinutes))],
      };
    },
  );
}
