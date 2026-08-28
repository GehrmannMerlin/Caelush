import { HealthResponseSchema, type HealthResponse } from "@caelush/protocol";
import type { FastifyInstance } from "fastify";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get(
    "/api/v1/health",
    { schema: { response: { 200: HealthResponseSchema } } },
    async (): Promise<HealthResponse> => ({
      service: "caelush-daemon",
      status: "ready",
      apiVersion: "v1",
      protocolVersion: 1,
    }),
  );
}
