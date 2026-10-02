import type { AIProviderBinding, ApiAdapter, ModelDescriptorSourcePort } from "@caelush/ai";
import type { ContextContributionRegistration } from "@caelush/agent";
import type {
  BeforeToolDispatchRegistration,
  ToolFeedbackContributionBudget,
  ToolFeedbackContributionRegistration,
} from "@caelush/coding-agent";
import type { ClientModelSelection } from "@caelush/protocol";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import {
  createLocalRuntimeResolver,
  LocalRuntime,
  type ProcessSandboxProvider,
  type ResolvedSandboxRunnerArtifact,
} from "@caelush/runtime";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  effectsChangeAgentState,
  withoutGitTools,
  type DefaultCodingToolOperations,
  type GitToolAvailability,
} from "@caelush/coding-agent";
import { buildDaemonApp } from "./app.js";
import { assertLoopbackDaemonHost, createDaemonConfig, type DaemonConfig } from "./config.js";
import {
  composeDaemon,
  defaultProcessSandboxProviders,
  type DaemonComposition,
} from "./daemon-composition.js";
import {
  reconcileStaleRuns,
  type StartupReconciliationSummary,
} from "./execution/run-startup-reconciliation.js";
import { SessionTranscriptService } from "./services/session-transcript-service.js";
import { SessionPresentationService } from "./services/session-presentation-service.js";
import { AIConfigurationService } from "./services/ai-configuration-service.js";
import type { DaemonModelProviderConfig } from "./providers/model-canonicalizer.js";
import type { WebStaticHostOptions } from "./web/static-host.js";
import type { SubscriberQueuePolicy } from "./events/subscriber-queue.js";
import { DefaultPublicEventProjector } from "./events/public-event-projector.js";
import { WorkspaceService } from "./workspaces/workspace-service.js";
import type { WorkspacePreparationPort } from "./services/security-capability-service.js";
import type { SecurityFeatureGates } from "./services/security-feature-gates.js";
import { createWindowsSandboxHost } from "./services/windows-sandbox-host.js";
import {
  createNativeWorkspaceDirectoryPicker,
  type WorkspaceDirectoryPicker,
} from "./workspaces/workspace-picker.js";
import {
  backfillSessionWorkspaceOwnership,
  type WorkspaceBackfillSummary,
} from "./workspaces/workspace-backfill.js";

export interface DaemonOptions {
  readonly databasePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly sseHeartbeatIntervalMs?: number;
  readonly runEventQueuePolicy?: SubscriberQueuePolicy;
  readonly logger?: boolean;
  readonly providers?: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly providerBindings?: readonly AIProviderBinding[];
  readonly modelSources?: readonly ModelDescriptorSourcePort[];
  readonly adapterOverrides?: readonly ApiAdapter[];
  readonly web?: WebStaticHostOptions;
  /** Compatibility input for the first Workspace registry record. */
  readonly workspacePath?: string;
  /** Host adapter for opening a native directory picker. */
  readonly workspacePicker?: WorkspaceDirectoryPicker;
  /** Typed host/test seam for Context Contributions; no HTTP plugin registration is implied. */
  readonly contextContributionHooks?: readonly ContextContributionRegistration[];
  /** Typed host/test seam for pre-dispatch Tool Guard evaluation. */
  readonly beforeToolDispatchHooks?: readonly BeforeToolDispatchRegistration[];
  /** Typed host/test seam for observation-backed Tool feedback contributions. */
  readonly toolFeedbackContributionHooks?: readonly ToolFeedbackContributionRegistration[];
  readonly toolFeedbackContributionBudget?: Partial<ToolFeedbackContributionBudget>;
  readonly toolExposure?: GitToolAvailability;
  readonly processSandboxProviders?: readonly ProcessSandboxProvider[];
  /**
   * The verified Windows Runner artifact this daemon generation runs under, when one was resolved.
   *
   * A typed seam rather than an environment read: the startup path resolves the artifact exactly once
   * and hands the result here, so no lower layer re-reads `CAELUSH_SANDBOX_RUNNER_*` and a test can
   * inject an artifact without a packaged bundle. `undefined` is a real state — the daemon still
   * starts, and the restricted presets report a bounded unavailability reason.
   */
  readonly windowsSandboxArtifact?: ResolvedSandboxRunnerArtifact;
  readonly fullAccessAvailable?: boolean;
  readonly ttySupported?: boolean;
  readonly workspacePreparation?: WorkspacePreparationPort;
  readonly featureGates?: SecurityFeatureGates;
}

export interface DaemonHandle {
  readonly url: string;
  /**
   * What the fresh-daemon stale-Run reconciliation pass found and scheduled.
   *
   * A previous generation that died without settling its Runs leaves them non-terminal forever
   * unless the next generation asks. This is the evidence that it asked, and what happened.
   */
  readonly startupReconciliation?: StartupReconciliationSummary;
  readonly workspaceBackfill?: WorkspaceBackfillSummary;
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
   * Phase 4E made the Coding product layer the production source for the ten defaults. The legacy
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
  const exposedToolRegistrations =
    options.toolExposure === undefined || options.toolExposure === "AVAILABLE"
      ? defaultToolRegistrations
      : withoutGitTools(defaultToolRegistrations);

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
  const workspaceService = new WorkspaceService({
    repository: storage.workspaces,
    sessions: storage.sessions,
    runs: storage.runs,
  });
  let workspaceBackfill: WorkspaceBackfillSummary;
  try {
    const compatibilityPath = options.workspacePath?.trim() || options.web?.workspace?.path;
    if (compatibilityPath !== undefined && compatibilityPath.length > 0) {
      await workspaceService.registerWorkspace({ path: compatibilityPath });
    }
    workspaceBackfill = await backfillSessionWorkspaceOwnership({
      sessions: storage.sessions,
      runs: storage.runs,
      workspaceService,
    });
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
  /**
   * The restricted-execution host, composed once — and only when the caller injected neither half.
   *
   * ```text
   * caller injected providers or preparation   → the host is not built; the injection wins
   * Windows, nothing injected                  → one Provider + one preparation port
   * every other host, nothing injected          → the platform defaults below
   * ```
   *
   * The host is built *after* the workspace registry exists because its preparation port resolves
   * every workspace ID through `WorkspaceService.requireWorkspace()` at call time.
   */
  const windowsSandboxHost =
    process.platform === "win32" &&
    options.processSandboxProviders === undefined &&
    options.workspacePreparation === undefined
      ? createWindowsSandboxHost({
          artifact: options.windowsSandboxArtifact,
          workspaceService,
        })
      : undefined;
  const processSandboxProviders =
    options.processSandboxProviders ??
    (windowsSandboxHost !== undefined && windowsSandboxHost.providers.length > 0
      ? windowsSandboxHost.providers
      : defaultProcessSandboxProviders());
  const workspacePreparation =
    options.workspacePreparation ?? windowsSandboxHost?.workspacePreparation;
  let composition: DaemonComposition;
  try {
    composition = await composeDaemon({
      storage,
      eventQueuePolicy: config.runEventQueuePolicy,
      runtime,
      ...(options.providers === undefined ? {} : { providers: options.providers }),
      ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.providerBindings === undefined
        ? {}
        : { providerBindings: options.providerBindings }),
      ...(options.modelSources === undefined ? {} : { modelSources: options.modelSources }),
      ...(options.adapterOverrides === undefined
        ? {}
        : { adapterOverrides: options.adapterOverrides }),
      ...(options.logger === true ? { logger: safeSupervisorLogger } : {}),
      toolRegistrations: exposedToolRegistrations,
      ...(options.toolExposure === undefined ? {} : { toolExposure: options.toolExposure }),
      processSandboxProviders,
      ...(options.fullAccessAvailable === undefined
        ? {}
        : { fullAccessAvailable: options.fullAccessAvailable }),
      ...(options.ttySupported === undefined ? {} : { ttySupported: options.ttySupported }),
      ...(workspacePreparation === undefined ? {} : { workspacePreparation }),
      ...(options.featureGates === undefined ? {} : { featureGates: options.featureGates }),
      ...(options.contextContributionHooks === undefined
        ? {}
        : { contextContributionHooks: options.contextContributionHooks }),
      ...(options.beforeToolDispatchHooks === undefined
        ? {}
        : { beforeToolDispatchHooks: options.beforeToolDispatchHooks }),
      ...(options.toolFeedbackContributionHooks === undefined
        ? {}
        : { toolFeedbackContributionHooks: options.toolFeedbackContributionHooks }),
      ...(options.toolFeedbackContributionBudget === undefined
        ? {}
        : { toolFeedbackContributionBudget: options.toolFeedbackContributionBudget }),
    });
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
  const activeStreams = new Set<AbortController>();
  const aiConfiguration = new AIConfigurationService({
    presets: composition.providerPresets,
    compatibilityProviderIds: new Set(options.providerBindings?.map((binding) => binding.id)),
    credentials: composition.credentialAuthority,
    directory: composition.modelDirectory,
    selections: storage.aiSelections,
    sessions: storage.sessions,
    modelCanonicalizer: composition.modelCanonicalizer,
  });
  // Migrate an explicitly configured legacy startup default into the durable
  // preference authority once. Runtime Web changes then read/write SQLite and
  // no longer depend on the DaemonInfo compatibility snapshot.
  if (
    options.defaultModel !== undefined &&
    (await storage.aiSelections.getDefault()) === undefined
  ) {
    await storage.aiSelections.setDefault(options.defaultModel);
  }
  let app: Awaited<ReturnType<typeof buildDaemonApp>>;
  try {
    if (composition.eventHub === undefined) {
      throw new Error("Production daemon composition did not create a RunEventHub.");
    }
    app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      workspaces: storage.workspaces,
      workspaceService,
      workspacePicker: options.workspacePicker ?? createNativeWorkspaceDirectoryPicker(),
      eventHub: composition.eventHub,
      eventNotifier: composition.events,
      publicEventProjector: new DefaultPublicEventProjector(),
      activeStreams,
      config,
      execution: composition,
      info: composition.info,
      modelCanonicalizer: composition.modelCanonicalizer,
      aiConfiguration,
      securityCapabilityService: composition.securityCapabilityService,
      transcript: new SessionTranscriptService({
        sessions: storage.sessions,
        runs: storage.runs,
        messageRecords: storage.messageRecords,
        codecs: composition.messages.codecs,
        transcriptProjectors: composition.transcriptProjectors,
      }),
      presentation: new SessionPresentationService({
        sessions: storage.sessions,
        runs: storage.runs,
        messageRecords: storage.messageRecords,
        codecs: composition.messages.codecs,
        toolInvocations: storage.toolInvocations,
        observations: storage.observations,
        eventReader: storage.eventReader,
        toolPresentation: composition.toolPresentation,
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

  /**
   * Reconcile whatever the previous daemon generation left non-terminal.
   *
   * ```text
   * storage/runtime/controller/supervisor composed  →  done above
   * control plane listening                         →  done above
   * enumerate stale non-terminal Runs               →  listRecoverable
   * hand each to the existing recovery authority     →  supervisor.recover
   * ```
   *
   * It runs *after* the control plane is up so a recovery that needs the daemon to be observable has
   * one, and it is fully failure-isolated: a storage read that fails, or one Run that cannot be
   * scheduled, is reported and never prevents the daemon from serving. Reconciliation schedules
   * background work and returns; it never awaits a Run to completion here.
   */
  let startupReconciliation: StartupReconciliationSummary | undefined;
  try {
    startupReconciliation = await reconcileStaleRuns({
      runs: storage.runs,
      supervisor: composition.supervisor,
      ...(options.logger === true ? { logger: safeSupervisorLogger } : {}),
    });
  } catch (error) {
    if (options.logger === true) {
      console.error("Caelush startup Run reconciliation could not be enumerated.", error);
    }
  }

  return {
    url,
    workspaceBackfill,
    ...(startupReconciliation === undefined ? {} : { startupReconciliation }),
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
