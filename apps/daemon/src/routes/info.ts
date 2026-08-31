import { DaemonInfoSchema, type DaemonInfo } from "@caelush/protocol";
import type { FastifyInstance } from "fastify";

export function registerInfoRoute(app: FastifyInstance, info: DaemonInfo): void {
  app.get("/api/v1/info", { schema: { response: { 200: DaemonInfoSchema } } }, async () =>
    DaemonInfoSchema.parse(info),
  );
}
