import type { AIProviderBinding, ApiAdapter, ModelDescriptorSourcePort } from "@caelush/ai";
import type { ClientModelSelection } from "@caelush/protocol";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import { createLocalRuntimeResolver, LocalRuntime } from "@caelush/runtime";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  effectsChangeAgentState,
  type DefaultCodingToolOperations,
} from "@caelush/coding-agent";
import { buildDaemonApp } from "./app.js";
import { assertLoopbackDaemonHost, createDaemonConfig, type DaemonConfig } from "./config.js";
import { composeDaemon, type DaemonComposition } from "./daemon-composition.js";
import { SessionTranscriptService } from "./services/session-transcript-service.js";
import type { DaemonModelProviderConfig } from "./providers/model-canonicalizer.js";
import type { WebStaticHostOptions } from "./web/static-host.js";
import type { SubscriberQueuePolicy } from "./events/subscriber-queue.js";

export interface DaemonOptions {
  readonly databasePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly sseHeartbeatIntervalMs?: number;
  readonly runEventQueuePolicy?: SubscriberQueuePolicy;
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
    ...(options.runEventQueuePolicy === undefined
      ? {}
      : { runEventQueuePolicy: options.runEventQueuePolicy }),
  });
  assertLoopbackDaemonHost(config.host);
  return config;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const config = resolveConfig(options);
  /**
   * The default Coding Tool set, built before the composition root composes anything.
   *
   * ```text
   * RuntimeResolver
   *   → the Runtime Operations adapters
   *   → createDefaultCodingTools(...)   @caelush/coding-agent
   * ```
   *
   * Phase 4E made the Coding product layer the production source for the nine defaults. The legacy
   * `createDefaultBuiltinToolRegistrations` — which this function used to call — is no longer part of
   * the production path: it survives as a compatibility facade over the same Coding factories until
   * Phase 4F, and the composition root registers these definitions directly.
   *
   * The set is built here, once per daemon start, and the same value reaches `composeDaemon`, so the
   * registry, the Coding catalog and the model catalog are three views of one derivation.
   */
  const runtime = new LocalRuntime();
  const runtimeResolver = createLocalRuntimeResolver(runtime);
  const defaultToolRegistrations = createDefaultCodingTools(
    daemonCodingOperations(runtimeResolver),
  );

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
    toolSettlementExtension: createCodingToolSettlementExtensionDecoder({
      effects: toHostToolEffectsPort({
        changesState: effectsChangeAgentState,
        apply: applyToolEffectsToAgentState,
      }),
    }),
  });
  let composition: DaemonComposition;
  try {
    composition = await composeDaemon({
      storage,
      eventQueuePolicy: config.runEventQueuePolicy,
      runtime,
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
    });
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
  const activeStreams = new Set<AbortController>();
  let app: Awaited<ReturnType<typeof buildDaemonApp>>;
  try {
    if (composition.eventHub === undefined) {
      throw new Error("Production daemon composition did not create a RunEventHub.");
    }
    app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      eventHub: composition.eventHub,
      activeStreams,
      config,
      execution: composition,
      info: composition.info,
      modelCanonicalizer: composition.modelCanonicalizer,
      transcript: new SessionTranscriptService({
        sessions: storage.sessions,
        runs: storage.runs,
        messageRecords: storage.messageRecords,
        codecs: composition.messages.codecs,
        transcriptProjectors: composition.transcriptProjectors,
      }),
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

/**
 * The four Runtime Operations adapters, as the one bundle `createDefaultCodingTools` expects.
 *
 * Built here rather than in the composition root because the daemon must hand `composeDaemon` the
 * *definitions* it built this set from — one derivation, three views (the registry, the Coding catalog
 * and the model catalog) rather than three independent constructions.
 */
function daemonCodingOperations(
  runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>,
): DefaultCodingToolOperations {
  const readOnly = createRuntimeReadOnlyOperations(runtimeResolver);
  return {
    readFile: readOnly,
    readOnly,
    patch: createRuntimePatchOperations(runtimeResolver),
    exec: createRuntimeProcessOperations(runtimeResolver),
    process: createRuntimeProcessOperations(runtimeResolver),
    git: createRuntimeGitOperations(runtimeResolver),
  };
}

const safeSupervisorLogger = {
  error: (_error: unknown, context: { readonly operation: string; readonly runId: string }) => {
    console.error("Caelush background Run operation failed.", context);
  },
};
