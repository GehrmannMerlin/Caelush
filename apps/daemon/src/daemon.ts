import { EventBus } from "@caelush/events";
import type { LLMProvider } from "@caelush/llm";
import type { ClientModelSelection } from "@caelush/protocol";
import { openCaelushStorage } from "@caelush/storage";
import { buildDaemonApp } from "./app.js";
import { assertLoopbackDaemonHost, createDaemonConfig, type DaemonConfig } from "./config.js";
import { composeDaemon, type DaemonComposition } from "./daemon-composition.js";
import type { DaemonModelProviderConfig } from "./providers/model-canonicalizer.js";
import type { WebStaticHostOptions } from "./web/static-host.js";

export interface DaemonOptions {
  readonly databasePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly sseHeartbeatIntervalMs?: number;
  readonly logger?: boolean;
  readonly providers?: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
  readonly providerOverrides?: readonly LLMProvider[];
  readonly web?: WebStaticHostOptions;
}

export interface DaemonHandle {
  readonly url: string;
  close(): Promise<void>;
}

function resolveConfig(options: DaemonOptions): DaemonConfig {
  const config = createDaemonConfig({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.sseHeartbeatIntervalMs === undefined
      ? {}
      : { sseHeartbeatIntervalMs: options.sseHeartbeatIntervalMs }),
  });
  assertLoopbackDaemonHost(config.host);
  return config;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const config = resolveConfig(options);
  const storage = await openCaelushStorage({ path: options.databasePath });
  const eventBus = new EventBus(storage.events);
  let composition: DaemonComposition;
  try {
    composition = composeDaemon({
      storage,
      eventBus,
      ...(options.providers === undefined ? {} : { providers: options.providers }),
      ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
      ...(options.providerOverrides === undefined
        ? {}
        : { providerOverrides: options.providerOverrides }),
      ...(options.logger === true ? { logger: safeSupervisorLogger } : {}),
    });
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
  const activeStreams = new Set<AbortController>();
  let app: Awaited<ReturnType<typeof buildDaemonApp>>;
  try {
    app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      eventBus,
      activeStreams,
      config,
      execution: composition,
      info: composition.info,
      modelCanonicalizer: composition.modelCanonicalizer,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.web === undefined ? {} : { web: options.web }),
    });
  } catch (error) {
    await composition.dispose().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => undefined);
    await composition.dispose().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }

  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close().catch(() => undefined);
    await composition.dispose().catch(() => undefined);
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
        await composition.dispose();
        await storage.close();
      })();
      return closePromise;
    },
  };
}

const safeSupervisorLogger = {
  error: (_error: unknown, context: { readonly operation: string; readonly runId: string }) => {
    console.error("Caelush background Run operation failed.", context);
  },
};
