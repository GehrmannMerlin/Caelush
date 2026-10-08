import { dirname, join } from "node:path";
import type { AIProviderBinding, ApiAdapter, ModelDescriptorSourcePort } from "@caelush/ai";
import type { ContextContributionRegistration } from "@caelush/agent";
import type {
  BeforeToolDispatchRegistration,
  ToolFeedbackContributionBudget,
  ToolFeedbackContributionRegistration,
} from "@caelush/coding-agent";
import type { ClientModelSelection } from "@caelush/protocol";
import { openCaelushStorage, toHostToolEffectsPort } from "@caelush/storage";
import { createReplayProtection, type ReplayKeyProvider } from "@caelush/security";
import { LocalRuntime, type ProcessSandboxProvider } from "@caelush/runtime";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  effectsChangeAgentState,
  type GitToolAvailability,
} from "@caelush/coding-agent";
import { buildDaemonApp } from "./app.js";
import {
  assertLoopbackDaemonHost,
  createDaemonConfig,
  type DaemonConfig,
  type ProviderStreamPolicy,
} from "./config.js";
import {
  composeDaemon,
  defaultProcessSandboxProviders,
  type DaemonComposition,
} from "./daemon-composition.js";
import { daemonEntryPath } from "./entry.js";
import {
  resolveSandboxRunnerArtifact,
  type SandboxRunnerResolution,
} from "./sandbox-runner-host.js";
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
import { createHostReplayKeyProvider } from "./replay/replay-key-provider.js";

export interface DaemonOptions {
  /** Persistent trusted-host secret injection; never accepted over HTTP or placed in config JSON. */
  readonly replayKeyProvider?: ReplayKeyProvider;
  readonly databasePath: string;
  readonly host?: string;
  readonly port?: number;
  /** Finite managed-shutdown drain deadline; primarily injectable for lifecycle tests. */
  readonly shutdownTimeoutMs?: number;
  readonly sseHeartbeatIntervalMs?: number;
  readonly runEventQueuePolicy?: SubscriberQueuePolicy;
  readonly logger?: boolean;
  readonly providers?: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Finite Gateway watchdog overrides; omitted values retain production defaults. */
  readonly providerStreamPolicy?: Partial<ProviderStreamPolicy>;
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
   * The packaged-Runner resolution this daemon generation runs under, when already known.
   *
   * A typed seam rather than an environment read: the startup path resolves once and hands the whole
   * outcome here, so no lower layer re-reads `CAELUSH_SANDBOX_RUNNER_*`, a test can inject an outcome
   * without a packaged bundle, and the bounded failure reason survives all the way to the API.
   * `{ available: false }` is a real state — the daemon still starts and reports it.
   */
  readonly windowsSandboxResolution?: SandboxRunnerResolution;
  /** Bounded reason restricted execution is unavailable, when the caller already knows it. */
  readonly restrictedUnavailableReason?: string;
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
    ...(options.providerStreamPolicy === undefined
      ? {}
      : { providerStreamPolicy: options.providerStreamPolicy }),
  });
  assertLoopbackDaemonHost(config.host);
  return config;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const config = resolveConfig(options);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new RangeError("Daemon shutdownTimeoutMs must be a finite positive safe integer.");
  }
  /**
   * The one Runtime instance this daemon generation owns.
   *
   * ```text
   * Windows sandbox host + Provider probes
   *   → composeDaemon(...)
   *       → Runtime Operations authorization resolver
   *       → the default Coding Tool definitions
   * ```
   *
   * Tool construction must wait until `composeDaemon` owns the provider probe authority. Building the
   * definitions here would freeze process adapters without the restricted authorization resolver and
   * make capability reporting disagree with actual Tool execution.
   */
  const runtime = new LocalRuntime();

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
    replayProtection: createReplayProtection(
      createHostReplayKeyProvider({
        keyFile: join(dirname(options.databasePath), "private-replay-keys", "master.v1.json"),
        ...(options.replayKeyProvider === undefined ? {} : { injected: options.replayKeyProvider }),
      }),
    ),
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
   * The environment this daemon generation runs under.
   *
   * `process.env` for a direct start; a launcher forwards its own environment to the spawned child,
   * so both paths read the same keys and the same artifact is resolved either way.
   */
  const environment = options.environment ?? process.env;
  /**
   * Resolve the packaged Runner artifact **exactly once** per daemon generation.
   *
   * ```text
   * CAELUSH_SANDBOX_RUNNER_PATH / _MANIFEST     explicit development or diagnostic override
   *        ↓ otherwise
   * <bundle>/sandbox-runner/<exe> + manifest.json   the fixed release-relative layout, anchored on
   *                                                 this module's own path so the answer does not
   *                                                 depend on how the daemon was spawned
   * ```
   *
   * Resolution is bounded, is verified through the shared `@caelush/runtime` verifier, and never
   * prevents startup: an absent or invalid artifact is a real state the capability service reports.
   * The result is a typed option passed down, so no lower layer re-reads these keys.
   */
  const windowsSandboxResolution =
    options.windowsSandboxResolution ?? (await resolveWindowsSandboxRunner(environment));
  /**
   * The restricted-execution host, composed once — and only when the caller injected neither half.
   *
   * ```text
   * caller injected providers or preparation   → the host is not built; the injection wins
   * Windows, nothing injected                  → at most one Provider + one preparation port
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
          resolution: windowsSandboxResolution,
          workspaceService,
        })
      : undefined;
  const processSandboxProviders =
    options.processSandboxProviders ??
    windowsSandboxHost?.providers ??
    defaultProcessSandboxProviders();
  const workspacePreparation =
    options.workspacePreparation ?? windowsSandboxHost?.workspacePreparation;
  /**
   * The bounded reason restricted execution is unavailable, when the host knows one.
   *
   * Carried separately from the provider list because a `PROCESS_SANDBOX` capability with no
   * restricted Provider must still say *why* — `RUNNER_HASH_MISMATCH` and `RUNNER_ARTIFACT_MISSING`
   * are different operator problems, and the resolution above already distinguished them.
   */
  const restrictedUnavailableReason =
    options.restrictedUnavailableReason ?? windowsSandboxHost?.restrictedUnavailableReason;
  let composition: DaemonComposition;
  try {
    composition = await composeDaemon({
      storage,
      eventQueuePolicy: config.runEventQueuePolicy,
      providerStreamPolicy: config.providerStreamPolicy,
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
      ...(options.toolExposure === undefined ? {} : { toolExposure: options.toolExposure }),
      processSandboxProviders,
      ...(options.fullAccessAvailable === undefined
        ? {}
        : { fullAccessAvailable: options.fullAccessAvailable }),
      ...(options.ttySupported === undefined ? {} : { ttySupported: options.ttySupported }),
      ...(workspacePreparation === undefined ? {} : { workspacePreparation }),
      ...(restrictedUnavailableReason === undefined ? {} : { restrictedUnavailableReason }),
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
      if (closePromise === undefined) {
        closePromise = (async () => {
          composition.supervisor.beginDrain();
          const checkpoints = await composition.supervisor.checkpointActive();
          if (checkpoints.some(({ result }) => result === "UNSAFE_IN_FLIGHT")) {
            throw new Error(
              "Daemon shutdown is waiting for an in-flight Tool or verification effect to reach a safe boundary; storage remains open.",
            );
          }
          if (!(await composition.supervisor.drainWithin(shutdownTimeoutMs))) {
            throw new Error(
              "Daemon shutdown drain timed out; active execution and storage remain available for a later retry.",
            );
          }
          // Core has committed and notified every managed checkpoint before public streams close.
          for (const controller of activeStreams) controller.abort();
          await app.close();
          await composition.dispose();
          await storage.close();
        })().catch((error: unknown) => {
          // Do not leave a cached rejected close promise: callers may retry after an unsafe effect
          // reaches a durable boundary. No underlying storage is closed on these paths.
          closePromise = undefined;
          throw error;
        });
      }
      return closePromise;
    },
  };
}

/**
 * Resolve the packaged Runner outcome for the current host.
 *
 * Anchored on `daemonEntryPath` — this module's own `main.js` — rather than on `argv` or the working
 * directory, so a daemon started directly and a daemon spawned by the launcher resolve the same fixed
 * location. Only Windows composes a restricted Provider today, so other hosts skip the lookup
 * entirely and keep the platform default from `defaultProcessSandboxProviders()`.
 *
 * The **whole outcome** is returned, not just a successful artifact: the bounded reason for an absent
 * or invalid Runner is the fact the capability service must report.
 */
async function resolveWindowsSandboxRunner(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SandboxRunnerResolution> {
  if (process.platform !== "win32") {
    return { available: false, reasonCode: "RUNNER_PLATFORM_UNSUPPORTED" };
  }
  return resolveSandboxRunnerArtifact({ environment, daemonEntryPath });
}

const safeSupervisorLogger = {
  error: (_error: unknown, context: { readonly operation: string; readonly runId: string }) => {
    console.error("Caelush background Run operation failed.", context);
  },
};
