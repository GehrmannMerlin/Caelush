import { EventBus } from "@caelush/events";
import type { AIProviderBinding, ApiAdapter, ModelDescriptorSourcePort } from "@caelush/ai";
import type { ClientModelSelection } from "@caelush/protocol";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import {
  applyToolEffectsToAgentState,
  createDefaultBuiltinToolRegistrations,
  createLegacyToolSettlementExtensionDecoder,
  effectsChangeAgentState,
  ToolRegistryBuilder,
  type ToolCallingDebugEvent,
} from "@caelush/tools";
import { createLocalRuntimeResolver, LocalRuntime } from "@caelush/runtime";
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
  readonly providerBindings?: readonly AIProviderBinding[];
  readonly modelSources?: readonly ModelDescriptorSourcePort[];
  readonly adapterOverrides?: readonly ApiAdapter[];
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
  /**
   * The default Coding Tool catalog, built before the composition root composes anything.
   *
   * The registry itself is a synchronous derivation; the Coding overlay is a separate artifact
   * produced by `@caelush/coding-agent`, reached through the declared dynamic compatibility import
   * that lets a legacy package consume a target one. Building it here — once, per daemon start, from
   * the same registration set the registry is built from — is what makes the catalog and the active
   * registry correspond instead of drifting.
   */
  const defaultToolRegistrations = createDefaultBuiltinToolRegistrations(
    createLocalRuntimeResolver(new LocalRuntime()),
  );
  const defaultToolBuilder = new ToolRegistryBuilder();
  for (const registration of defaultToolRegistrations) defaultToolBuilder.register(registration);
  await defaultToolBuilder.buildCodingCatalog();

  /**
   * The Tool settlement compatibility boundary, built once per daemon start.
   *
   * ```text
   * canonical ToolResultPipeline
   *   └── opaque ToolSettlementExtension          kind = "caelush.coding.effects.v1"
   *         └── this decoder
   *               └── the existing Coding ToolEffect[] projection
   *                     └── the invocation's own SQLite transaction
   * ```
   *
   * It is wired here rather than inside `@caelush/storage` because the Coding effect vocabulary belongs
   * to the Tool System, which Storage may not import. The Agent layer never sees it at all: it carries
   * the extension and passes it through.
   */
  const storage = await openCaelushStorage({
    path: options.databasePath,
    toolSettlementExtension: createLegacyToolSettlementExtensionDecoder({
      effects: toHostToolEffectsPort({
        changesState: effectsChangeAgentState,
        apply: applyToolEffectsToAgentState,
      }),
    }),
  });
  const eventBus = new EventBus(storage.events);
  let composition: DaemonComposition;
  try {
    composition = composeDaemon({
      storage,
      eventBus,
      ...(options.providers === undefined ? {} : { providers: options.providers }),
      ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
      ...(options.providerBindings === undefined
        ? {}
        : { providerBindings: options.providerBindings }),
      ...(options.modelSources === undefined ? {} : { modelSources: options.modelSources }),
      ...(options.adapterOverrides === undefined
        ? {}
        : { adapterOverrides: options.adapterOverrides }),
      ...(options.logger === true ? { logger: safeSupervisorLogger } : {}),
      toolRegistrations: defaultToolRegistrations,
      ...(process.env.CAELUSH_DEBUG_TOOL_CALLING === "1"
        ? { toolCallingDebugWriter: writeToolCallingDebugEvent }
        : {}),
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

function writeToolCallingDebugEvent(event: ToolCallingDebugEvent): void {
  console.error("[caelush:tool-calling]", JSON.stringify(event));
}

const safeSupervisorLogger = {
  error: (_error: unknown, context: { readonly operation: string; readonly runId: string }) => {
    console.error("Caelush background Run operation failed.", context);
  },
};
