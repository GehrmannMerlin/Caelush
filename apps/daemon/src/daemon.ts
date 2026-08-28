import { EventBus } from "@caelush/events";
import { openCaelushStorage } from "@caelush/storage";
import { buildDaemonApp } from "./app.js";
import { createDaemonConfig, type DaemonConfig } from "./config.js";

export interface DaemonOptions {
  readonly databasePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly sseHeartbeatIntervalMs?: number;
  readonly logger?: boolean;
}

export interface DaemonHandle {
  readonly url: string;
  close(): Promise<void>;
}

function resolveConfig(options: DaemonOptions): DaemonConfig {
  return createDaemonConfig({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.sseHeartbeatIntervalMs === undefined
      ? {}
      : { sseHeartbeatIntervalMs: options.sseHeartbeatIntervalMs }),
  });
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const config = resolveConfig(options);
  const storage = await openCaelushStorage({ path: options.databasePath });
  const eventBus = new EventBus(storage.events);
  const activeStreams = new Set<AbortController>();
  const app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventBus,
    activeStreams,
    config,
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }

  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close();
    await storage.close();
    throw new Error("Daemon did not expose a TCP address");
  }
  const url = `http://${config.host}:${address.port}`;
  let closePromise: Promise<void> | undefined;

  return {
    url,
    close: () => {
      closePromise ??= (async () => {
        for (const controller of activeStreams) controller.abort();
        await app.close();
        await storage.close();
      })();
      return closePromise;
    },
  };
}
