import { createHash } from "node:crypto";
import {
  RunController,
  RunDeadlineRegistry,
  RunExecutionScopeRegistry,
  RunRetryRegistry,
  createCodingCompletionAssembly,
  createProjectProfileProvider,
  createRunAgentExecutionContext,
  toContextObservationProjection,
  type RunAgentExecutionContextFactory,
  type VerificationModelClient,
  type RunExecutionConfigResolver,
  type ToolTurnPipeline,
  type ToolFeedbackContributionApplier,
  type RunMessageAuthority,
} from "@caelush/core";
import { createLocalProjectInspector } from "@caelush/coding-agent";
import { createAIError, createAISubsystem, createCacheResolver, isJsonObject } from "@caelush/ai";
import type { ProviderStreamPolicy } from "./config.js";
import { createModelTransportRecoveryPort } from "./providers/model-transport-recovery.js";
import {
  createDaemonApiAdapters,
  toModelDescriptorSources,
} from "./providers/legacy-ai-configuration.js";
import {
  createRuntimeProviderCredentialAuthority,
  type RuntimeProviderCredentialAuthority,
} from "./providers/credential-authority.js";
import {
  createProviderPresetRegistry,
  toProviderPresetBinding,
  type ProviderPresetRegistry,
} from "./providers/provider-presets.js";
import { createCuratedModelDescriptorSources } from "./providers/curated-model-metadata.js";
import { RuntimeModelDirectoryService } from "./providers/model-directory.js";
import { CatalogModelCanonicalizer } from "./providers/model-canonicalizer.js";
import {
  createModelWireDiagnostic,
  createSafeModelWireDiagnostic,
  type ModelWireDiagnostic,
  type ModelWireDiagnosticEvent,
} from "./providers/model-wire-diagnostic.js";
import {
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createAgentConversationRepository,
  createAgentConversationValidator,
  createDeterministicConversationTurnIdFactory,
  createAgentMessageCodecRegistry,
  createAgentMessageProjectorRegistry,
  createAgentMessageTranscriptProjectorRegistry,
  createControlHookRegistryBuilder,
  createControlHookRunner,
  createContextContributionPipeline,
  createModelTurnExecutor,
  STANDARD_AGENT_MESSAGE_CODECS,
  STANDARD_AGENT_MESSAGE_PROJECTORS,
  STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS,
} from "@caelush/agent";
import type {
  AgentMessageRecord,
  AgentExecutionIdentity,
  ContextContributionHook,
  ContextContributionPipeline,
  ContextContributionRegistration,
  ContextUsageSnapshot,
  RunEventNotifierPort,
  ToolPresentationPort,
} from "@caelush/agent";
import type {
  AICacheRequest,
  AISubsystem,
  AIGateway,
  AIModelRequest,
  AIStream,
  ModelUsage,
  ModelCatalog,
  ModelDescriptor,
  ModelDescriptorSourcePort,
  AIInvocationAccountingObserver,
} from "@caelush/ai";
import {
  DaemonInfoSchema,
  createApprovalRequestId,
  createEventId,
  LLMCallIdSchema,
  createObservationId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type AgentRun,
  type ClientModelSelection,
  type DaemonInfo,
  type DefaultRunConfiguration,
  type RunId,
  type TimestampMs,
  type ContextUsageProjection,
  type CacheMetricsV2,
  type PromptCachePurposeUsage,
  type PromptCacheRequestPurpose,
  type PromptCacheStatus,
  type PromptCacheUsage,
} from "@caelush/protocol";
import {
  LocalRuntime,
  createAuthorizedRuntimeExecution,
  createLocalRuntimeResolver,
  createLinuxBubblewrapProvider,
  createLinuxLandlockProvider,
  createMacSeatbeltProvider,
  createWindowsAclRestrictedTokenProvider,
  createRuntimeProcessPolicy,
  sanitizeTerminalOutput,
  type ProcessSandboxProvider,
} from "@caelush/runtime";
import {
  DefaultVerificationPlanner,
  ProjectCheckResolverRegistry,
  VerificationRunner,
  createVerificationRepairPolicy,
  type VerificationGitPort,
  type VerificationToolObservationInput,
  type WorkspaceVerificationPort,
} from "@caelush/verification";
import {
  boundToolResultContent,
  createDurableToolExecutionCoordinator,
  createModelToolFeedbackProjector,
  createToolAdmissionCoordinator,
  createToolBatchCoordinator,
  createToolCallPreparer,
  createToolFailureSettlement,
  createToolInvocationExecutor,
  createToolResultBatchNormalizer,
  createToolResultPipeline,
  DefaultAgentToolRegistryBuilder,
  type AgentToolRegistry,
  type DurableInvocationExecutorFactory,
  type DurableResultPipelineFactory,
  type DurableToolExecutionCoordinator,
  type ToolExecutionUpdateSanitizerPort,
  type ProjectedToolFeedback,
} from "@caelush/agent";
import {
  createCodingToolAdmissionPort,
  CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1,
  CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1,
  CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR,
  createCodingToolDurableMetadataPort,
  createCodingToolSettlementExtensionProjector,
  createDefaultCodingTools,
  createDurableInvocationGatePort,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProgressSignalProjector,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  createLegacyNumericArgumentNormalization,
  createToolGuardPipeline,
  createToolFeedbackContributionPipeline,
  GIT_TOOL_NAMES,
  CodingToolCatalogBuilder,
  type CodingToolCatalog,
  type CodingToolDefinition,
  type DefaultCodingToolOperations,
  type GitToolAvailability,
  type BeforeToolDispatchRegistration,
  type ToolGuardPipeline,
  type ToolFeedbackContributionBudget,
  type ToolFeedbackContributionPipeline,
  type ToolFeedbackContributionRegistration,
} from "@caelush/coding-agent";
import {
  assertDefaultBuiltinSecurityCoverage,
  createDefaultV1ToolExecutionSecurity,
  createV1ToolApprovalRequestFactory,
  CaelushToolExecutionUpdateSanitizer,
  redactText,
  verificationCommandSecurityPort,
  verificationEvidenceSanitizer,
} from "@caelush/security";
import {
  createSqliteToolBudgetAdmission,
  type BudgetLedgerEntry,
  type ProviderInvocationUsageRecord,
  type CaelushStorage,
} from "@caelush/storage";
import {
  SecurityCapabilityService,
  type WorkspacePreparationPort,
} from "./services/security-capability-service.js";
import { RunSecurityPromptProjector } from "./services/run-security-prompt-projector.js";
import {
  resolveSecurityFeatureGates,
  type SecurityFeatureGates,
} from "./services/security-feature-gates.js";

import {
  createRunBoundVerificationExecution,
  createRuntimeGitVerificationPort,
  createRuntimeWorkspaceVerificationPort,
} from "./verification-runtime-adapters.js";
import {
  type DaemonModelCanonicalizer,
  type DaemonModelProviderConfig,
} from "./providers/model-canonicalizer.js";
import {
  RunExecutionSupervisor,
  type RunExecutionSupervisorLogger,
} from "./execution/run-execution-supervisor.js";
import { DAEMON_VERSION } from "./version.js";
import { RunEventHub, type SubscriberQueuePolicy } from "./events/index.js";
import { createDaemonV2ContextEngine } from "./context/v2-context-composition.js";
import { createDaemonPrivateReplayResolver } from "./replay/private-replay-resolver.js";

/**
 * Project durable invocation state back onto the canonical prepared call.
 *
 * Nothing is resolved, normalized or validated here. The canonical registry resolved the Tool at
 * registration, preparation validated the arguments before the `REQUESTED` row was written, and the
 * arguments come from the durable invocation itself. This is durable state projected onto the canonical
 * call type, not a second preparation path.
 */
function preparedCallFromDurableState(
  registry: AgentToolRegistry,
  invocation: import("@caelush/protocol").ToolInvocation,
  externalCallId: string,
): import("@caelush/agent").PreparedToolCall {
  const resolved = registry.resolve(invocation.toolName);
  if (resolved === undefined) {
    throw new Error(
      `The canonical Tool entry "${invocation.toolName}" is unavailable for execution.`,
    );
  }
  return Object.freeze({
    request: Object.freeze({
      externalCallId,
      toolName: invocation.toolName,
      args: invocation.args,
    }),
    resolved,
    args: invocation.args,
  });
}

export const DEFAULT_CORE_AGENT_POLICY = [
  "You are Caelush, a careful workspace agent.",
  "Use the active workspace as the only path root; use '.' when referring to its root.",
  "Inspect relevant files and gather evidence before making claims or changes.",
  "Use the native tool that matches the task; do not use mutation tools for read-only work.",
  "Tool selection: use list_directory for immediate children, find_files for unknown paths, search_text for content search, read_file for known text files, git_status and git_diff for Git evidence, apply_patch for requested file changes, exec_command for tests/build/install/service commands, write_stdin only for a session returned by exec_command, and stop_process to end a long-running session by its exact session_id.",
  "Do not use exec_command to read files, list directories, or search code when a native Tool is sufficient, and never use it to terminate a process with taskkill, Stop-Process, pkill, killall or kill.",
  "Treat Tool errors as observations: correct recoverable inputs, avoid repeating an unchanged failure, and do not call an inapplicable tool.",
  "After a mutation, inspect the resulting files and relevant diff before claiming success.",
  "Stop when the requested evidence is sufficient; report blockers and uncertainty plainly.",
  "Never reveal hidden chain-of-thought, raw provider reasoning, credentials, or facts you have not observed. Give useful user-visible progress updates at meaningful decision points: before substantial tool work, after evidence changes the picture, when the approach changes or is blocked, before requested edits, and after verification. For non-trivial work, explain in a few specific sentences what you checked, what the evidence establishes, what remains uncertain, and why the next action follows; simple actions may need only one sentence. Prefer concrete file names, command outcomes, counts, and limitations when actually observed. Distinguish facts from inference, and state when something has not been checked. If bounded Work Update State is present in Context, use it only to notice new committed observations since the last committed update; obtain specific facts from conversation evidence, do not repeat an unchanged update, and never treat a Tool observation as verification or quote opaque record IDs. Do not pad to meet a length target, narrate every routine tool call, repeat earlier updates, imply verification that did not happen, or use repetitive headings such as '工作说明'. Keep the explanation and any required tool requests in the same turn; a normal assistant answer without tool requests remains subject to the existing completion and verification rules.",
].join(" ");

export const DEFAULT_BASE_SYSTEM_PROMPT = DEFAULT_CORE_AGENT_POLICY;

export const DEFAULT_ADAPTIVE_RESOURCE_POLICY = Object.freeze({
  mode: "ADAPTIVE",
  operationalLease: Object.freeze({ maxAgentTurns: 24, maxToolOperations: 64 }),
  batch: Object.freeze({ maxToolCallsPerTurn: 16 }),
  progress: Object.freeze({
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  }),
  hardLimits: Object.freeze({}),
  inactivity: Object.freeze({}),
});

export const DEFAULT_RUN_CONFIGURATION = Object.freeze({
  runtime: Object.freeze({ id: "local", kind: "local" }),
  defaultPreset: "WORKSPACE_WRITE",
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  resourcePolicy: DEFAULT_ADAPTIVE_RESOURCE_POLICY,
}) satisfies DefaultRunConfiguration;

export interface DaemonClock {
  now(): TimestampMs;
}

/**
 * The Run identity a model turn executes for.
 *
 * Phase 3A made identity an explicit input of the frozen `ModelTurnExecutor`, because the
 * durable model turn boundary commits against a Run and a Session. The daemon owns the
 * current Run context and publishes it here, so a legacy turn always carries a real Run
 * rather than a synthesized one.
 */
export type DaemonTurnIdentity = AgentExecutionIdentity;

export interface DaemonCompositionOptions {
  readonly storage: CaelushStorage;
  /** Canonical daemon observation notifier. Production composition creates the RunEventHub when omitted. */
  readonly notifier?: RunEventNotifierPort;
  readonly eventQueuePolicy?: SubscriberQueuePolicy;
  readonly providers?: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
  /** Finite Gateway watchdog overrides; omitted values use production defaults. */
  readonly providerStreamPolicy?: Partial<ProviderStreamPolicy>;
  /** Environment is read on every credential resolution; it is never serialized. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Optional host/test authority; production composes the SQLite-backed authority below. */
  readonly credentialAuthority?: RuntimeProviderCredentialAuthority;
  /** AI-native composition seams for tests and hosts. */
  readonly providerBindings?: readonly import("@caelush/ai").AIProviderBinding[];
  readonly modelSources?: readonly ModelDescriptorSourcePort[];
  readonly adapterOverrides?: readonly import("@caelush/ai").ApiAdapter[];
  /** Capability discovered for the selected workspace; unknown hides Git tools. */
  readonly toolExposure?: GitToolAvailability;
  readonly runtime?: LocalRuntime;
  readonly processSandboxProviders?: readonly ProcessSandboxProvider[];
  readonly fullAccessAvailable?: boolean;
  readonly ttySupported?: boolean;
  readonly workspacePreparation?: WorkspacePreparationPort;
  /** Bounded reason restricted execution is unavailable, decided once at startup. */
  readonly restrictedUnavailableReason?: string;
  readonly featureGates?: SecurityFeatureGates;
  readonly clock?: DaemonClock;
  readonly logger?: RunExecutionSupervisorLogger;
  readonly configResolver?: RunExecutionConfigResolver;
  readonly wireDiagnosticWriter?: (
    event: import("./providers/model-wire-diagnostic.js").ModelWireDiagnosticEvent,
  ) => void;
  /**
   * The Coding Tool definitions this host composed, when it does not want the default ten.
   *
   * The same value reaches the registry and the Coding catalog, so the executable Tool set and its
   * overlay are always two views of one derivation. Phase 4F narrowed this from the legacy
   * `ToolRegistration | CodingToolDefinition` union to the Coding product layer's own type: a host that
   * wants a different Tool set builds it with `createDefaultCodingTools`-style factories, and there is no
   * second registration shape to translate.
   */
  readonly toolRegistrations?: readonly CodingToolDefinition[] | undefined;
  /** Typed host/test seam for Context Contributions; production has no HTTP plugin registration. */
  readonly contextContributionHooks?: readonly ContextContributionRegistration[];
  /** Optional fully composed pipeline for a host that owns the registry construction. */
  readonly contextContributionPipeline?: ContextContributionPipeline;
  /** Typed host/test seam for pre-dispatch Tool Guard evaluation. */
  readonly beforeToolDispatchHooks?: readonly BeforeToolDispatchRegistration[];
  /** Optional fully composed Tool Guard pipeline for a host that owns the registry construction. */
  readonly beforeToolDispatchPipeline?: ToolGuardPipeline;
  /** Typed host/test seam for observation-backed Tool feedback contributions. */
  readonly toolFeedbackContributionHooks?: readonly ToolFeedbackContributionRegistration[];
  /** Optional fully composed feedback contribution pipeline for a host that owns the registry. */
  readonly toolFeedbackContributionPipeline?: ToolFeedbackContributionPipeline;
  readonly toolFeedbackContributionBudget?: Partial<ToolFeedbackContributionBudget>;
}

export interface DaemonComposition {
  readonly eventHub: RunEventHub | undefined;
  readonly events: RunEventNotifierPort;
  readonly runs: Pick<CaelushStorage["runs"], "get">;
  readonly runtime: LocalRuntime;
  readonly runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>;
  /** The V2 AI subsystem: the single model invocation authority. */
  readonly ai: AISubsystem;
  readonly credentialAuthority: RuntimeProviderCredentialAuthority;
  readonly providerPresets: ProviderPresetRegistry;
  readonly modelDirectory: RuntimeModelDirectoryService;
  /** The frozen V2 model turn executor. One gateway invocation per `execute()`. */
  readonly modelTurnExecutor: ReturnType<typeof createModelTurnExecutor>;
  /**
   * The explicit-identity model turn authority a host-driven model turn executes through.
   *
   * Phase 3E retired the throw-based legacy facade from production composition: verification is the
   * last host action that drives a model turn outside the Run Layer, and it now names the Run it
   * reviews per call. What still asks for a host-driven turn is a verification review, a wire
   * diagnostic, and a test — and each of them names the Run it means. There is deliberately no second
   * provider runtime, and no mutable global for one Run's review to be attributed to another Run's
   * execution through.
   */
  readonly verificationModelTurns: VerificationModelClient;
  readonly toolRegistry: AgentToolRegistry;
  /**
   * The one canonical Tool turn pipeline this host composes.
   *
   * ```text
   * ToolBatchCoordinator        the canonical batch scheduler
   * ModelToolFeedbackProjector  the canonical model-facing exit
   * ToolResultBatchNormalizer   the canonical batch integrity defense
   * ```
   *
   * Phase 4D replaced the legacy batch coordinator construction with these three. They are one
   * value because they are one pipeline, and exactly one of each exists per daemon.
   */
  readonly toolTurn: ToolTurnPipeline;
  /** Safe Chinese presentation shared by durable and live Tool surfaces. */
  readonly toolPresentation: ToolPresentationPort;
  readonly messages: RunMessageAuthority;
  readonly transcriptProjectors: import("@caelush/agent").AgentMessageTranscriptProjectorRegistry;
  readonly contextUsage: {
    getContextUsage(runId: string): Promise<ContextUsageProjection | undefined>;
  };
  readonly controller: RunController;
  readonly supervisor: RunExecutionSupervisor;
  /**
   * Publish the Run identity a host-driven model turn executes for.
   *
   * A production Agent Reason no longer needs this: the Run Layer projects the identity from the
   * durable `AgentRun` and hands it to the frozen loop, so nothing is published before a turn for
   * that turn to commit against a real Run. What still asks for it is a caller that drives a model
   * turn *outside* the Run Layer — the verification reviewer, a wire diagnostic, a test.
   */
  readonly resolveTurnIdentity: (
    run: Pick<AgentRun, "id" | "sessionId" | "goal">,
  ) => DaemonTurnIdentity;
  readonly approvals: Pick<CaelushStorage["approvals"], "listPendingByRun">;
  readonly modelCanonicalizer: DaemonModelCanonicalizer;
  readonly securityCapabilityService: SecurityCapabilityService;
  readonly runSecurityPromptProjector: RunSecurityPromptProjector;
  readonly info: DaemonInfo;
  dispose(): Promise<void>;
}

export async function composeDaemon(options: DaemonCompositionOptions): Promise<DaemonComposition> {
  const eventHub =
    options.notifier === undefined
      ? new RunEventHub(options.storage.eventReader, {
          ...(options.eventQueuePolicy === undefined
            ? {}
            : { queuePolicy: options.eventQueuePolicy }),
        })
      : undefined;
  const eventNotifier = options.notifier ?? eventHub;
  if (eventNotifier === undefined) {
    throw new Error("Daemon composition requires a RunEventNotifierPort.");
  }
  const providers = [...(options.providers ?? [])];
  const startupCredentials = new Map(
    providers.flatMap((provider) =>
      provider.apiKey === undefined ? [] : [[provider.provider, provider.apiKey] as const],
    ),
  );
  const credentialAuthority =
    options.credentialAuthority ??
    createRuntimeProviderCredentialAuthority({
      repository: options.storage.providerCredentials,
      environment: options.environment ?? process.env,
      startupCredentials,
    });
  const providerPresets = createProviderPresetRegistry(providers);
  const curatedSources = createCuratedModelDescriptorSources(providerPresets.list());
  const clock = options.clock ?? { now: () => createTimestampMs(Date.now()) };
  const contextContributionPipelineId = "context-contribution";
  const contributionPipeline =
    options.contextContributionPipeline ??
    (() => {
      const registryBuilder = createControlHookRegistryBuilder<ContextContributionHook>();
      for (const registration of options.contextContributionHooks ?? []) {
        const hook = registration.hook;
        registryBuilder.register({
          ...registration,
          hook:
            "contribute" in hook
              ? hook
              : {
                  contribute: (input, context) => hook.invoke(input, context),
                },
        });
      }
      const registry = registryBuilder.build();
      return createContextContributionPipeline({
        registry,
        runner: createControlHookRunner({
          pipelineId: contextContributionPipelineId,
          clock,
        }),
        pipelineId: contextContributionPipelineId,
        clock,
      });
    })();
  const toolGuardPipeline =
    options.beforeToolDispatchPipeline ??
    createToolGuardPipeline({
      registrations: options.beforeToolDispatchHooks ?? [],
      clock,
      sanitizeReason: (reason) => sanitizeTerminalOutput(redactText(reason)),
    });
  const toolFeedbackContributionPipeline =
    options.toolFeedbackContributionPipeline ??
    createToolFeedbackContributionPipeline({
      registrations: options.toolFeedbackContributionHooks ?? [],
      ...(options.toolFeedbackContributionBudget === undefined
        ? {}
        : { budget: options.toolFeedbackContributionBudget }),
      clock,
      textSanitizer: (text) => sanitizeTerminalOutput(redactText(text)),
    });
  const runtime = options.runtime ?? new LocalRuntime();
  const runtimeResolver = createLocalRuntimeResolver(runtime);
  const securityCapabilityService = new SecurityCapabilityService({
    processSandboxProviders: options.processSandboxProviders ?? defaultProcessSandboxProviders(),
    ...(options.fullAccessAvailable === undefined
      ? {}
      : { fullAccessAvailable: options.fullAccessAvailable }),
    ...(options.ttySupported === undefined ? {} : { ttySupported: options.ttySupported }),
    ...(options.workspacePreparation === undefined
      ? {}
      : { workspacePreparation: options.workspacePreparation }),
    ...(options.restrictedUnavailableReason === undefined
      ? {}
      : { restrictedUnavailableReason: options.restrictedUnavailableReason }),
    featureGates: options.featureGates ?? resolveSecurityFeatureGates(options.environment),
  });
  const runSecurityPromptProjector = new RunSecurityPromptProjector();
  const ai = createAISubsystem({
    modelSources: [
      curatedSources.curated,
      ...providers.flatMap(toModelDescriptorSources),
      curatedSources.fallback,
      ...(options.modelSources ?? []),
    ],
    providers: [
      ...providerPresets
        .list()
        .map((preset) => toProviderPresetBinding(preset, credentialAuthority)),
      ...(options.providerBindings ?? []),
    ],
    adapters: [...createDaemonApiAdapters(), ...(options.adapterOverrides ?? [])],
    ...(options.providerStreamPolicy?.nudgeAfterMs === undefined
      ? {}
      : { defaultNudgeAfterMs: options.providerStreamPolicy.nudgeAfterMs }),
    ...(options.providerStreamPolicy?.idleTimeoutMs === undefined
      ? {}
      : { defaultIdleTimeoutMs: options.providerStreamPolicy.idleTimeoutMs }),
    ...(options.providerStreamPolicy?.teardownGraceMs === undefined
      ? {}
      : { defaultTeardownGraceMs: options.providerStreamPolicy.teardownGraceMs }),
  });
  const modelTransportRecovery = createModelTransportRecoveryPort(
    ai.providers,
    ({ providerId, modelId }) => ai.models.resolve({ provider: providerId, model: modelId }).api,
  );
  const modelDirectory = new RuntimeModelDirectoryService({
    presets: providerPresets,
    credentials: credentialAuthority,
    models: ai.models,
  });
  // The diagnostic is a transparent decorator over the frozen gateway: the AI core
  // contract gains no debug callback, and nothing here can observe an endpoint, a
  // credential, a header, a prompt or a tool argument.
  const wireDiagnostic =
    options.wireDiagnosticWriter === undefined
      ? createSafeModelWireDiagnostic()
      : createModelWireDiagnostic({ writer: options.wireDiagnosticWriter });
  const gateway = createDiagnosedGateway(ai.gateway, wireDiagnostic, ai.models);
  const modelTurnExecutor = createModelTurnExecutor({
    gateway,
    invocationObserverFactory: (input) =>
      createProviderInvocationAccountingObserver({
        storage: options.storage,
        runId: input.identity.runId as RunId,
        purpose: "MAIN_AGENT",
        clock,
      }),
    privateReplayResolverFactory: (scope) =>
      createDaemonPrivateReplayResolver(options.storage.privateReplay, scope),
    notifier: eventNotifier,
    eventIdFactory: { create: createEventId },
    clock,
  });
  const verificationModelTurnExecutor = createModelTurnExecutor({
    gateway,
    invocationObserverFactory: (input) =>
      createProviderInvocationAccountingObserver({
        storage: options.storage,
        runId: input.identity.runId as RunId,
        purpose: "VERIFICATION_LLM",
        clock,
      }),
  });
  /**
   * The Run identity a *host-driven* model turn executes for.
   *
   * A pure projection, and nothing more. Phase 3E removed the mutable "active turn" this used to
   * write: a verification review now carries the identity of the Run it belongs to as an explicit
   * argument, so there is no global for one Run's review to be attributed to another Run's
   * execution through, and no ordering requirement for an Agent turn to have run first.
   *
   * What still asks for it is a caller that drives a model turn *outside* the Run Layer — a wire
   * diagnostic, a test — and it asks by naming the Run it means.
   */
  const resolveTurnIdentity = (
    run: Pick<AgentRun, "id" | "sessionId" | "goal">,
  ): DaemonTurnIdentity => ({
    runId: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
  });
  /**
   * The explicit-identity model turn authority a verification review executes through.
   *
   * It is the same AI subsystem, gateway and provider registry an ordinary Agent turn uses, and it
   * takes the identity per call. A review is a host action about a Run rather than an Agent Reason,
   * so it names the Run it reviews instead of borrowing a globally published turn.
   */
  const verificationModelTurns: VerificationModelClient = {
    async execute({ identity, request, signal }) {
      const result = await verificationModelTurnExecutor.execute({
        identity,
        turn: { stepId: createStepId(), sequence: 1 },
        request,
        signal,
      });
      if (result.kind === "COMPLETED") return result.result;
      if (result.kind === "CANCELLED")
        throw createAIError("AI_ABORTED", "The model turn was cancelled.");
      throw createAIError("AI_PROVIDER_ERROR", "The model turn failed.");
    },
  };

  const inspector = createLocalProjectInspector(runtime);
  const messageProjectors = createAgentMessageProjectorRegistry({
    projectors: [
      ...STANDARD_AGENT_MESSAGE_PROJECTORS,
      CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1,
    ],
  });
  const messageCodecs = createAgentMessageCodecRegistry({
    codecs: [...STANDARD_AGENT_MESSAGE_CODECS, CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1],
    projectionVersionOf: (type) => messageProjectors.currentVersion(type),
  });
  const transcriptProjectors = createAgentMessageTranscriptProjectorRegistry({
    projectors: [
      ...STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS,
      CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR,
    ],
  });
  const messageTurns = createDeterministicConversationTurnIdFactory();
  const conversation = createAgentConversationRepository({
    codecs: messageCodecs,
    store: options.storage.messageRecords,
    turns: messageTurns,
    runMetadata: {
      async read(runId) {
        const run = await options.storage.runs.get(runId);
        if (run === null) return undefined;
        const terminal =
          run.status === "COMPLETED" ||
          run.status === "FAILED" ||
          run.status === "CANCELLED" ||
          run.status === "TIMEOUT" ||
          run.status === "MAX_STEPS_REACHED" ||
          run.status === "BUDGET_EXCEEDED";
        return {
          runId: run.id,
          sessionId: run.sessionId,
          createdAt: run.createdAt,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          terminal,
        };
      },
    },
    validator: createAgentConversationValidator(),
  });
  const messages: RunMessageAuthority = {
    codecs: messageCodecs,
    projectors: messageProjectors,
    conversation,
    factory: createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => clock.now(),
      turns: messageTurns,
    }),
    turns: messageTurns,
    userOrigin: async (run) => {
      const sessionRuns = await options.storage.runs.listBySession(run.sessionId);
      const hasEarlierRun = sessionRuns.some(
        (candidate) =>
          candidate.id !== run.id &&
          (candidate.createdAt < run.createdAt ||
            (candidate.createdAt === run.createdAt && candidate.id < run.id)),
      );
      return hasEarlierRun ? "FOLLOW_UP" : "GOAL";
    },
  };
  /**
   * The Phase 4E production Tool composition.
   *
   * ```text
   * RuntimeResolver
   *   → the four Runtime Operations adapters     @caelush/coding-agent
   *   → createDefaultCodingTools(...)            the ten Coding Tool definitions
   *   → ToolRegistryBuilder                      the canonical AgentToolRegistry
   * ```
   *
   * The default ten Tools now **originate in `@caelush/coding-agent`**. The legacy package's
   * `createDefaultBuiltinToolRegistrations` is no longer called here: it survives as a compatibility
   * facade for its own callers and for its tests, and every registration it builds delegates to these
   * same Coding factories. Production does not go through it, so there is exactly one place the
   * default Tool set is declared and exactly one implementation behind each Tool.
   *
   * Git exposure still fails closed. A host whose Git capability is not `AVAILABLE` builds the default
   * set *without* the Git Tools rather than filtering a built registry, which is what keeps the
   * registry, the Coding catalog, the model-visible specs and the prompt guidance block describing the
   * same active set.
   */
  const defaultCodingTools = defaultCodingToolSet(
    defaultCodingOperations(runtimeResolver, securityCapabilityService),
    options.toolExposure ?? "AVAILABLE",
  );
  const activeToolRegistry = buildToolRegistry(options.toolRegistrations ?? defaultCodingTools);
  const activeToolNames = activeToolRegistry.names();
  /**
   * The Coding Tool catalog for the Tools this host registered.
   *
   * ```text
   * the Coding Tool definitions this host built   →  CodingToolCatalog
   *        └── forRegistry(activeToolRegistry)     refuses a DANGLING overlay
   * ```
   *
   * `CodingToolCatalogBuilder.forRegistry()` is what refuses a *dangling* overlay — a catalog entry
   * whose Tool the active registry cannot execute — so building it against the registry is what keeps
   * Coding metadata and executable Tools describing one set. The catalog is retained because the
   * composition root is the layer that reads it: the durable `riskLevel`, the security-facts projector
   * and the effect projector all come from it rather than from a second derivation.
   *
   * Phase 4F replaced the legacy `ToolRegistryBuilder.buildCodingCatalog()` with the canonical builder.
   * The check is the same check, performed by the package that owns the catalog.
   */
  const codingCatalog = createActiveCodingCatalog(
    activeToolRegistry,
    options.toolRegistrations ?? defaultCodingTools,
  );
  /**
   * The production Tool assembly.
   *
   * ```text
   * ToolAdmissionPort              the Coding/Security admission adapter over the real gate
   * ToolDurableMetadataPort        the Coding catalog's risk level, for the durable invocation row
   * ToolApprovalRequestFactory     the real approval card, from redacted security facts
   * ToolBudgetAdmissionPort        the canonical view over the durable budget ledger
   * ToolExecutionStorePort         @caelush/storage, implementing the canonical port
   * ToolInvocationExecutor         @caelush/agent
   * ToolResultPipeline             @caelush/agent, with the Coding settlement extension
   * DurableToolExecutionCoordinator   ← the Tool Invocation Lifecycle Authority
   * ```
   *
   * Every dependency below is a *construction* dependency of the coordinator, never a field of a frozen
   * request: the durable request carries identity, the prepared call, the environment, the security
   * context and a signal, and nothing else.
   *
   * Phase 4F replaced the legacy `createToolExecutionDependencies` facade with the two canonical Agent
   * factories directly. Nothing was reimplemented: the facade assembled exactly these two values, and its
   * only remaining legacy-specific contribution was a settlement extension projector that read an effect
   * projector out of a compatibility registry view — which the Coding catalog now supplies.
   *
   * The composition root is also where the pieces that must not live in a canonical layer are wired:
   *
   * ```text
   * the settlement extension projector   the Coding effect vocabulary, from the catalog
   * the approval request factory         the Agent layer never learns what a safeAction is
   * the effects projection               AgentState belongs to the host, not to the Tool layer
   * ```
   */
  const toolSecurity = createDefaultV1ToolExecutionSecurity({
    terminalOutputSanitizer: sanitizeTerminalOutput,
  });
  const toolUpdateSanitizer: ToolExecutionUpdateSanitizerPort =
    new CaelushToolExecutionUpdateSanitizer();
  const toolInvocationExecutorFactory: DurableInvocationExecutorFactory = ({
    invocation,
    sessionId,
    updateSanitizer,
  }) => {
    const projector = createRuntimeProgressSignalProjector({
      eventIdFactory: { create: createEventId },
      clock,
    });
    return createToolInvocationExecutor({
      invocation,
      updateSanitizer,
      transientUpdates: {
        publish: ({ toolName, invocation: boundInvocation, update }) => {
          try {
            const projectInput = {
              sessionId,
              toolName,
              invocation: boundInvocation,
              update,
            };
            const events = projector.projectMany?.(projectInput) ?? [
              projector.project(projectInput),
            ];
            for (const event of events) {
              if (event !== null) eventNotifier.emitTransient(event);
            }
          } catch {
            // A live observer/projector failure cannot change Tool execution or settlement.
          }
        },
      },
    });
  };
  /**
   * The result pipeline for one invocation.
   *
   * ```text
   * the real Security sanitizer
   * the canonical durable content bound   64 KiB, the value the Tool System already enforced
   * the Coding settlement extension       effects + the host-domain events they imply
   * ```
   *
   * The extension is built per invocation because the Coding effect projector needs the durable
   * invocation and the environment the canonical call does not carry, and the coordinator is the layer
   * that knows them. The projector is still pure and synchronous and still settles inside the same single
   * commit, so atomicity is untouched.
   */
  const toolResultPipelineFactory: DurableResultPipelineFactory = ({
    invocation,
    environment,
    sessionId,
  }) =>
    createToolResultPipeline({
      sanitizer: toolSecurity.resultSanitizer,
      settlementExtension: createCodingToolSettlementExtensionProjector({
        catalog: codingCatalog,
        invocation: {
          invocation,
          ...(sessionId === undefined ? {} : { sessionId }),
          environment,
          // The same event identity factory the settlement uses, so an effect event and the terminal
          // event it accompanies are drawn from one durable sequence.
          nextEventId: () => createEventId(),
          presentation: toolSecurity.presentation,
        },
      }),
    });
  const toolApprovalRequests = createV1ToolApprovalRequestFactory({
    registry: activeToolRegistry,
    catalog: codingCatalog,
    gate: toolSecurity.gate,
    approvalIdFactory: { create: createApprovalRequestId },
  });
  assertDefaultBuiltinSecurityCoverage(
    activeToolRegistry,
    codingCatalog,
    (options.toolRegistrations ?? defaultCodingTools).map((definition) => definition.tool.name),
  );
  const toolBudgetAdmission = createSqliteToolBudgetAdmission(options.storage.budget);
  const toolAdmission = createToolAdmissionCoordinator({
    policy: createCodingToolAdmissionPort({
      gate: createDurableInvocationGatePort({
        gate: toolSecurity.gate,
        invocations: {
          resolve: async (request) =>
            (await options.storage.toolExecution.load(request.invocationId as never))?.invocation,
        },
      }),
      registry: activeToolRegistry,
      catalog: codingCatalog,
      approvalPresentation: (decision) => decision.safeAction,
      guard: toolGuardPipeline,
    }),
    approvals: options.storage.approvals,
    approvalRequests: toolApprovalRequests,
    budget: toolBudgetAdmission,
    clock,
    eventIdFactory: { create: createEventId },
  });
  const toolDurableCoordinator: DurableToolExecutionCoordinator =
    createDurableToolExecutionCoordinator({
      store: options.storage.toolExecution,
      admission: toolAdmission,
      metadata: createCodingToolDurableMetadataPort({
        registry: activeToolRegistry,
        catalog: codingCatalog,
      }),
      approvalRequests: toolApprovalRequests,
      approvalLookup: options.storage.approvals,
      invocationIdFactory: { create: createToolInvocationId },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      clock,
      invocationExecutorFactory: toolInvocationExecutorFactory,
      updateSanitizer: toolUpdateSanitizer,
      resultPipelineFactory: toolResultPipelineFactory,
      preparedCallFactory: ({ invocation, externalCallId }) =>
        preparedCallFromDurableState(activeToolRegistry, invocation, externalCallId),
      failureSettlement: createToolFailureSettlement({
        store: options.storage.toolExecution,
        clock,
        observationIdFactory: { create: createObservationId },
        eventIdFactory: { create: createEventId },
        presentation: toolSecurity.presentation,
        boundContent: (content) => boundToolResultContent(content),
        notifier: eventNotifier,
      }),
      budget: toolBudgetAdmission,
      presentation: toolSecurity.presentation,
      rawOutputStore: options.storage.contextArtifacts,
      notifier: eventNotifier,
      boundFailureContent: (content) => boundToolResultContent(content),
    });
  /**
   * The legacy `ToolDispatcher` is not composed here, and in Phase 4F it no longer exists.
   *
   * ```text
   * BEFORE 4D   ToolDispatcher → legacy ToolBatchCoordinator → RunController
   * AFTER  4D   ToolCallPreparer + ToolBudgetAdmissionPort + DurableToolExecutionCoordinator
   *                     → canonical ToolBatchCoordinator → RunController
   * AFTER  4F   the class itself is retired; the canonical four above are the whole Tool System
   * ```
   *
   * The dispatcher's only production consumer was the legacy batch coordinator. Phase 4D replaced that
   * with the canonical batch, which drives the same `toolDurableCoordinator` the facade was built around,
   * directly. A facade nothing production calls is dead weight rather than compatibility, so the
   * composition root never built one — and Phase 4F removed the surface entirely rather than leaving an
   * unreachable second lifecycle implementation in the repository.
   */
  /**
   * The canonical Tool turn pipeline.
   *
   * ```text
   * the canonical Preparer      resolve, normalize and validate a model Tool call      4A
   * ToolBudgetAdmissionPort     whole-segment preflight over the RAW requested calls    4C
   * DurableToolExecutionCoordinator  the durable invocation lifecycle                 4C
   *        ↓
   * ToolBatchCoordinator        the scheduler and the rejection/uncertainty barrier    4D
   * ```
   *
   * The legacy batch coordinator is deliberately **not** constructed here, and the canonical batch never
   * reaches a Dispatcher: production scheduling, pre-invocation rejection and the uncertain barrier are
   * the Agent package's.
   */
  const toolPreparer = createToolCallPreparer(activeToolRegistry, {
    normalization: createLegacyNumericArgumentNormalization(),
  });
  const toolBatch = createToolBatchCoordinator({
    preparer: toolPreparer,
    budget: toolBudgetAdmission,
    durable: toolDurableCoordinator,
    registry: activeToolRegistry,
  });
  const feedbackContributions: ToolFeedbackContributionApplier = {
    async apply(input) {
      if (input.items.length !== input.projected.length) {
        throw new Error("Tool feedback contribution input lost batch identity.");
      }
      const output: ProjectedToolFeedback[] = [];
      for (const [index, item] of input.items.entries()) {
        const projected = input.projected[index];
        if (projected === undefined) {
          throw new Error("Tool feedback contribution input lost a projected result.");
        }
        if (item.kind !== "OBSERVATION") {
          output.push(projected);
          continue;
        }
        const contribution = await toolFeedbackContributionPipeline.contribute(
          {
            runId: input.runId,
            sessionId: input.sessionId,
            sourceStepId: input.sourceStepId,
            toolCallId: projected.message.toolCallId,
            toolName: projected.message.toolName,
            observationId: item.observation.id,
            isError: item.observation.isError,
            builtInFeedback: projected.message.content,
          },
          {
            identity: { runId: input.runId, sessionId: input.sessionId },
            stepId: input.sourceStepId,
            mode: input.mode,
            signal: input.signal,
          },
        );
        if (contribution.content === projected.message.content) {
          output.push(projected);
          continue;
        }
        const message = Object.freeze({
          ...projected.message,
          content: contribution.content,
        });
        output.push(Object.freeze({ ...projected, message }));
      }
      return Object.freeze(output);
    },
  };
  const toolTurn = {
    batches: toolBatch,
    // The one place the Agent package's model feedback semantics and bounded observation projection are
    // joined. The composition root wires the canonical Agent Tool observation implementation into the
    // model-facing feedback pipeline.
    feedback: createModelToolFeedbackProjector({
      projection: toContextObservationProjection(),
    }),
    normalizer: createToolResultBatchNormalizer(),
    feedbackContributions,
    // The same registry the batch resolves and executes against: one catalog, never two, read in its
    // model-facing form rather than projected down to it.
    modelSpecs: () => activeToolRegistry.modelSpecs(),
  } satisfies ToolTurnPipeline;
  const scopes = new RunExecutionScopeRegistry();
  const deadlineRegistry = new RunDeadlineRegistry({ clock });
  const retryRegistry = new RunRetryRegistry({ clock });
  const defaultResolver = {
    resolve: async () => ({
      baseSystemPrompt: DEFAULT_BASE_SYSTEM_PROMPT,
    }),
  } satisfies RunExecutionConfigResolver;
  const baseResolver: RunExecutionConfigResolver = options.configResolver ?? defaultResolver;
  const executionConfigResolver = {
    resolve: (run) => baseResolver.resolve(run),
  } satisfies RunExecutionConfigResolver;
  const agentExecution: RunAgentExecutionContextFactory = {
    async resolve(run) {
      const config = await executionConfigResolver.resolve(run);
      const model = ai.models.resolve(run.model);
      const cacheRequest = resolveDefaultCacheRequest(model, config.modelSettings?.cache);
      const securityPrompt =
        run.securityPolicy === undefined
          ? undefined
          : runSecurityPromptProjector.project(
              run.securityPolicy,
              await securityCapabilityService.getRuntimeFacts(),
            );
      return createRunAgentExecutionContext({
        config: {
          baseSystemPrompt: [config.baseSystemPrompt, securityPrompt?.text]
            .filter((value): value is string => value !== undefined)
            .join("\n\n"),
          tools: activeToolRegistry.modelSpecs(),
          ...(config.modelSettings === undefined &&
          cacheRequest === undefined &&
          run.reasoningLevel === undefined
            ? {}
            : {
                modelSettings: {
                  ...(config.modelSettings === undefined ? {} : config.modelSettings),
                  ...(cacheRequest === undefined ? {} : { cache: cacheRequest }),
                  ...(run.reasoningLevel === undefined
                    ? {}
                    : { reasoning: { level: run.reasoningLevel } }),
                },
              }),
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          ...(config.explicitPaths === undefined ? {} : { explicitPaths: config.explicitPaths }),
        },
        models: ai.models,
        modelTurnExecutor,
        stepIds: { create: createStepId },
        // Production Run turns use the Agent-owned V2 Context Engine.
        createContextEngine: (input) =>
          createDaemonV2ContextEngine({
            input,
            storage: options.storage,
            promptSurfaceStore: options.storage.promptSurface,
            runtime,
            gateway,
            invocationObserverFactory: (runId) =>
              createProviderInvocationAccountingObserver({
                storage: options.storage,
                runId,
                purpose: "CONTEXT_COMPACTION",
                clock,
              }),
            messageProjectors,
            contributionPipeline,
            notifier: eventNotifier,
            clock,
            activeToolNames,
          }),
      });
    },
  };
  const verificationExecution = createRunBoundVerificationExecution(runtime, options.storage.runs);
  const verificationWorkspace = createRunBoundVerificationWorkspace(runtime);
  const verificationGit = createRunBoundVerificationGit(runtime);
  const controller = new RunController({
    agentExecution,
    modelTransportRecovery,
    executionStore: options.storage.execution,
    privateReplayStore: options.storage.privateReplay,
    completionStore: options.storage.execution,
    events: eventNotifier,
    configResolver: executionConfigResolver,
    messages,
    toolTurn,
    clock,
    eventIdFactory: { create: createEventId },
    approvals: options.storage.approvals,
    scopes,
    deadlineRegistry,
    retryRegistry,
    resources: { cancelOwnedResources: (runId) => runtime.cancelOwnedResources(runId) },
    budget: options.storage.budget,
    resourceGovernance: options.storage.resourceGovernance,
    /**
     * The Run Layer's completion collaborator, composed once.
     *
     * ```text
     * BEFORE  eighteen verification* fields, read and assembled by RunController itself
     * AFTER   one assembly the Run Layer names and asks three questions
     * ```
     *
     * Everything under this key is a property of the deployment rather than of one Run, so the daemon
     * composes it once: the planner, the identity factories, the project-check runner and resolver
     * registry, the run-bound workspace/Git/execution ports, the security admission, the evidence
     * sanitizer, the repair policy and the model-turn authority the reviewer is built from.
     *
     * The daemon still supplies one model-turn authority and never builds a reviewer of its own — the
     * assembly builds the reviewer from `modelTurns`, which is what keeps "one AI subsystem" true for a
     * review as much as for an Agent turn.
     */
    completion: createCodingCompletionAssembly({
      clock,
      configResolver: executionConfigResolver,
      planner: new DefaultVerificationPlanner(),
      planIdFactory: createVerificationPlanId,
      checkIdFactory: createVerificationCheckId,
      evidenceIdFactory: createVerificationEvidenceId,
      runner: new VerificationRunner(),
      profileProvider: createProjectProfileProvider(inspector),
      execution: verificationExecution,
      executionStore: options.storage.verificationExecution,
      executionRecovery: options.storage.verificationExecution,
      workspace: verificationWorkspace,
      git: verificationGit,
      security: verificationCommandSecurityPort,
      evidenceSanitizer: verificationEvidenceSanitizer,
      toolObservations: createDurableToolObservationPort(options.storage),
      resolverRegistry: new ProjectCheckResolverRegistry(),
      modelTurns: verificationModelTurns,
      budget: options.storage.budget,
      repairPolicy: createVerificationRepairPolicy(),
      planCount: (runId) =>
        options.storage.verificationExecution.countPlans?.(runId) ?? Promise.resolve(0),
    }),
    // Memory extraction is intentionally not composed here. The daemon has a bounded worker shell,
    // but no production extractor or lifecycle owner yet; creating durable jobs without a consumer
    // would leave completed Runs with permanently pending work.
  });
  const supervisor = new RunExecutionSupervisor({
    runs: options.storage.runs,
    controller,
    approvals: options.storage.approvals,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const modelCanonicalizer = new CatalogModelCanonicalizer(ai.models, ai.providers);
  const info = DaemonInfoSchema.parse({
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: DAEMON_VERSION,
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
      sessionTranscript: true,
      sessionContinuityPreflight: true,
      sessionTurnPresentation: true,
    },
    runtimeKinds: ["local"],
    // Compatibility snapshot only. Dynamic provider connection state belongs to
    // the AI control-plane service and is intentionally not inferred from this.
    configuredProviders: [
      ...providers.map((provider) => provider.provider),
      ...(options.providerBindings ?? []).map((provider) => provider.id),
    ].filter((provider, index, all) => all.indexOf(provider) === index),
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    defaultRunConfiguration: DEFAULT_RUN_CONFIGURATION,
  });

  let disposed = false;
  return {
    eventHub,
    events: eventNotifier,
    runs: options.storage.runs,
    runtime,
    runtimeResolver,
    ai,
    credentialAuthority,
    providerPresets,
    modelDirectory,
    modelTurnExecutor,
    verificationModelTurns,
    toolRegistry: activeToolRegistry,
    toolTurn,
    toolPresentation: toolSecurity.presentation,
    messages,
    transcriptProjectors,
    contextUsage: {
      getContextUsage: async (runId) => {
        const typedRunId = runId as RunId;
        const usage = await options.storage.contextUsage.getByRun(typedRunId);
        if (usage === undefined) return undefined;
        const [records, currentEpoch, budgetEntries, invocationEntries] = await Promise.all([
          options.storage.messageRecords.listByRun(typedRunId),
          options.storage.promptSurface.getCurrent(typedRunId),
          options.storage.budgetLedger.listByRun(typedRunId),
          options.storage.providerInvocationUsage.listByRun(typedRunId),
        ]);
        const currentSurface =
          currentEpoch === undefined
            ? undefined
            : await options.storage.promptSurface.readEpoch(typedRunId, currentEpoch.epochId);
        const projectedContextUsage = projectV2ContextUsage(usage);
        return {
          ...projectedContextUsage,
          promptCache: projectPromptCacheUsage(
            usage,
            promptCacheSamplesFromDurableMessages(records, budgetEntries, invocationEntries),
            currentEpoch,
            currentSurface === undefined || usage.promptSurface === undefined
              ? undefined
              : projectPromptCacheSegments({
                  epoch: currentSurface,
                  promptSurface: usage.promptSurface,
                  records,
                  recentTailTokens: projectedContextUsage.breakdown.recentTail,
                }),
            currentSurface?.records,
          ),
        };
      },
    },
    controller,
    supervisor,
    resolveTurnIdentity,
    approvals: options.storage.approvals,
    modelCanonicalizer,
    securityCapabilityService,
    runSecurityPromptProjector,
    info,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.all(supervisor.activeRunIds().map((runId) => controller.cancel(runId)));
      await supervisor.dispose();
      controller.dispose();
      deadlineRegistry.dispose();
      retryRegistry.dispose();
      await eventHub?.dispose();
      await runtime.dispose();
    },
  };
}

/**
 * The platform default restricted-provider set.
 *
 * Exported because the startup path (`apps/daemon/src/daemon.ts`) and the composition fallback must
 * agree on one platform switch. On Windows the startup path replaces this set with the verified
 * artifact host — `createWindowsSandboxHost` — and this function remains the authority for a host
 * where no packaged Runner applies.
 */
export function defaultProcessSandboxProviders(): readonly ProcessSandboxProvider[] {
  switch (process.platform) {
    case "win32":
      return [createWindowsAclRestrictedTokenProvider()];
    case "linux":
      return [createLinuxLandlockProvider(), createLinuxBubblewrapProvider()];
    case "darwin":
      return [createMacSeatbeltProvider()];
    default:
      return [];
  }
}

function projectV2ContextUsage(input: ContextUsageSnapshot) {
  const tokens = new Map(input.breakdown.map((item) => [item.sourceId, item.tokens]));
  const sourceTokens = (prefix: string): number =>
    [...tokens.entries()]
      .filter(([sourceId]) => sourceId === prefix || sourceId.startsWith(`${prefix}.`))
      .reduce((total, [, value]) => total + value, 0);
  const corePolicy = sourceTokens("agent.core-policy");
  const checkpoint = sourceTokens("agent.checkpoint");
  const conversation = sourceTokens("agent.conversation");
  const projectInstructions = sourceTokens("coding.project-instructions");
  const relevantFiles = sourceTokens("coding.relevant-files");
  const memory = sourceTokens("agent.memory");
  const project =
    projectInstructions +
    sourceTokens("coding.workspace") +
    sourceTokens("coding.runtime-facts") +
    sourceTokens("coding.project-metadata") +
    sourceTokens("coding.git-state");
  const effectiveInputLimitTokens = input.effectiveInputLimitTokens;
  const estimatedInputTokens = input.estimatedInputTokens;
  const usedRatio = Math.min(1, Math.max(0, estimatedInputTokens / effectiveInputLimitTokens));
  const remainingTokens = Math.max(0, effectiveInputLimitTokens - estimatedInputTokens);
  return {
    runId: input.runId,
    providerId: input.modelRef.provider,
    modelId: input.modelRef.model,
    profileSource: "CONFIGURATION",
    contextWindowTokens: input.contextWindowTokens,
    rawContextWindowTokens: input.contextWindowTokens,
    effectiveInputLimitTokens,
    estimatedInputTokens,
    usedRatio,
    remainingTokens,
    pressureState: input.pressureState,
    compactionCount: input.compactionCount,
    ...(input.lastCompactionAt === undefined ? {} : { lastCompactionAt: input.lastCompactionAt }),
    breakdown: {
      pinned: corePolicy + projectInstructions,
      checkpoint,
      recentTail: conversation,
      project,
      files: relevantFiles,
      toolObservations: 0,
      memory,
      systemTokens: corePolicy,
      goalTokens: 0,
      currentUserTokens: conversation,
      relevantFileTokens: relevantFiles,
      currentTurnTokens: conversation,
      mandatoryTokens: corePolicy + projectInstructions + checkpoint,
    },
    updatedAt: input.updatedAt,
    lastBuildAt: input.updatedAt,
    lastRecoveryStages: [...(input.lastRecoveryStages ?? [])],
    lastBuildStatus: input.lastBuildStatus,
  } satisfies ContextUsageProjection;
}

/** One bounded provider-usage sample used to aggregate public prompt-cache facts. */
export interface PromptCacheUsageSample {
  readonly purpose: PromptCacheRequestPurpose;
  readonly measuredAt: TimestampMs;
  /** Gateway-owned call identity. Budget owner ids and Step ids are never substituted here. */
  readonly invocationId?: string;
  readonly invocationStatus?: ProviderInvocationUsageRecord["status"];
  readonly source?: "GATEWAY" | "ASSISTANT_MESSAGE" | "BUDGET_LEDGER";
  /** Cache continuity accounting epoch, independent of Prompt Surface's semantic epoch. */
  readonly cacheEpochId?: string;
  /** Opaque compatibility group derived from provider/model/API/cache settings. */
  readonly continuityGroup?: string;
  /** Stable prompt-prefix fingerprint; contains no prompt text. */
  readonly prefixFingerprint?: string;
  readonly usage?: ModelUsage;
}

export function createProviderInvocationAccountingObserver(input: {
  readonly storage: CaelushStorage;
  readonly runId: RunId;
  readonly purpose: PromptCacheRequestPurpose;
  readonly clock: { now(): TimestampMs };
}): AIInvocationAccountingObserver {
  return {
    async onStarted(identity) {
      const context = await input.storage.contextUsage.getByRun(input.runId);
      const surface = context?.promptSurface;
      const prefixFingerprint =
        surface === undefined ? undefined : normalizeSha256(surface.prefixFingerprint);
      const cacheEpochId =
        surface === undefined
          ? undefined
          : fingerprint({
              runId: String(input.runId),
              continuityGroup: identity.continuityGroup,
              promptSurfaceEpochId: surface.epochId,
              resetReason: surface.resetReason,
            });
      await input.storage.providerInvocationUsage.observe({
        callId: LLMCallIdSchema.parse(String(identity.callId)),
        runId: input.runId,
        purpose: input.purpose,
        providerId: identity.providerId,
        modelId: identity.model.model,
        api: identity.api,
        continuityGroup: identity.continuityGroup,
        ...(cacheEpochId === undefined ? {} : { cacheEpochId }),
        ...(prefixFingerprint === undefined ? {} : { prefixFingerprint }),
        requestFingerprint: identity.requestFingerprint,
        observedAt: input.clock.now(),
      });
    },
    async onSettled(settlement) {
      await input.storage.providerInvocationUsage.settle({
        callId: LLMCallIdSchema.parse(String(settlement.callId)),
        status: settlement.status,
        settledAt: input.clock.now(),
        ...(settlement.usage?.totalTokens === undefined
          ? {}
          : { totalTokens: settlement.usage.totalTokens }),
        ...(settlement.usage?.inputTokens === undefined
          ? {}
          : { inputTokens: settlement.usage.inputTokens }),
        ...(settlement.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: settlement.usage.outputTokens }),
        ...(settlement.usage?.cachedInputTokens === undefined
          ? {}
          : { cacheHitInputTokens: settlement.usage.cachedInputTokens }),
        ...(settlement.usage?.cacheMissInputTokens === undefined
          ? {}
          : { cacheMissInputTokens: settlement.usage.cacheMissInputTokens }),
        ...(settlement.usage?.cacheWriteInputTokens === undefined
          ? {}
          : { cacheWriteInputTokens: settlement.usage.cacheWriteInputTokens }),
        ...(settlement.usage?.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: settlement.usage.reasoningTokens }),
      });
    },
  };
}

/** Safe, irreversible Prompt Surface and current recent-tail fingerprints. */
export function projectPromptCacheSegments(input: {
  readonly epoch: {
    readonly runId: RunId;
    readonly modelRef: { readonly provider: string; readonly model: string };
    readonly stableHeadFingerprint: string;
    readonly toolSchemaFingerprint: string;
    readonly cacheSettingsFingerprint: string;
    readonly snapshots: readonly {
      readonly ordinal: number;
      readonly anchor: {
        readonly messageId: string;
        readonly runId: RunId;
        readonly conversationTurnId: string;
        readonly sequence: number;
      };
      readonly sourceStepSequence: number;
      readonly content: string;
      readonly contentHash: string;
    }[];
  };
  readonly promptSurface: {
    readonly prefixFingerprint: string;
    readonly stableHeadTokens: number;
    readonly snapshotTokens: number;
  };
  readonly records: readonly AgentMessageRecord[];
  readonly recentTailTokens: number;
}): NonNullable<PromptCacheUsage["surfaceSegments"]> {
  const scopedSnapshots = input.epoch.snapshots.filter(
    (snapshot) => snapshot.anchor.runId === input.epoch.runId,
  );
  const lastAnchor = scopedSnapshots.at(-1)?.anchor.sequence ?? 0;
  const tailRecords = input.records
    .filter((record) => record.runId === input.epoch.runId && record.sequence > lastAnchor)
    .slice(-256);
  const tailProjection = tailRecords.map((record) => {
    const promptData = safePromptFingerprintValue(record.data);
    const encoded = canonicalJson(promptData);
    return {
      messageType: boundedFingerprintText(record.messageType, 64),
      sequence: record.sequence,
      bytes: Buffer.byteLength(encoded, "utf8"),
      promptData,
    };
  });
  const snapshotProjection = input.epoch.snapshots.map((snapshot) => ({
    ordinal: snapshot.ordinal,
    anchor: {
      messageId: snapshot.anchor.messageId,
      runId: snapshot.anchor.runId,
      conversationTurnId: snapshot.anchor.conversationTurnId,
      sequence: snapshot.anchor.sequence,
    },
    sourceStepSequence: snapshot.sourceStepSequence,
    contentHash: snapshot.contentHash,
    bytes: Buffer.byteLength(snapshot.content, "utf8"),
  }));
  return {
    prefixFingerprint: normalizeSha256(input.promptSurface.prefixFingerprint),
    modelFingerprint: fingerprint({
      provider: input.epoch.modelRef.provider,
      model: input.epoch.modelRef.model,
    }),
    stableHeadFingerprint: normalizeSha256(input.epoch.stableHeadFingerprint),
    toolCatalogFingerprint: normalizeSha256(input.epoch.toolSchemaFingerprint),
    cacheSettingsFingerprint: normalizeSha256(input.epoch.cacheSettingsFingerprint),
    checkpointFingerprint: fingerprint(snapshotProjection),
    recentTailFingerprint: fingerprint(
      tailProjection.map(({ messageType, sequence, promptData }) => ({
        messageType,
        sequence,
        promptData,
      })),
    ),
    roleSizeVectorFingerprint: fingerprint(
      tailProjection.map(({ messageType, bytes }) => ({ messageType, bytes })),
    ),
    stableHeadTokens: assertPromptCacheCount(input.promptSurface.stableHeadTokens),
    snapshotTokens: assertPromptCacheCount(input.promptSurface.snapshotTokens),
    recentTailTokens: assertPromptCacheCount(input.recentTailTokens),
    checkpointBytes: addPromptCacheCount(
      0,
      snapshotProjection.reduce((total, item) => total + item.bytes, 0),
    ),
    recentTailBytes: addPromptCacheCount(
      0,
      tailProjection.reduce((total, item) => total + item.bytes, 0),
    ),
    recentTailMessageCount: tailProjection.length,
  };
}

/**
 * Read only the provider-neutral usage tuple from durable assistant records.
 * No message content, provider state, call identity, or raw model payload leaves this function.
 */
export function promptCacheSamplesFromDurableMessages(
  records: readonly AgentMessageRecord[],
  budgetEntries: readonly BudgetLedgerEntry[] = [],
  invocationEntries: readonly ProviderInvocationUsageRecord[] = [],
): readonly PromptCacheUsageSample[] {
  const knownInvocationIds = new Set(invocationEntries.map((entry) => String(entry.callId)));
  const samples: PromptCacheUsageSample[] = invocationEntries.map((entry) => ({
    purpose: entry.purpose,
    measuredAt: entry.observedAt,
    invocationId: String(entry.callId),
    invocationStatus: entry.status,
    source: "GATEWAY",
    ...(entry.cacheEpochId === undefined ? {} : { cacheEpochId: entry.cacheEpochId }),
    continuityGroup: entry.continuityGroup,
    ...(entry.prefixFingerprint === undefined
      ? {}
      : { prefixFingerprint: entry.prefixFingerprint }),
    usage: {
      ...(entry.totalTokens === undefined ? {} : { totalTokens: entry.totalTokens }),
      ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
      ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
      ...(entry.cacheHitInputTokens === undefined
        ? {}
        : { cachedInputTokens: entry.cacheHitInputTokens }),
      ...(entry.cacheMissInputTokens === undefined
        ? {}
        : { cacheMissInputTokens: entry.cacheMissInputTokens }),
      ...(entry.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: entry.cacheWriteInputTokens }),
      ...(entry.reasoningTokens === undefined ? {} : { reasoningTokens: entry.reasoningTokens }),
    },
  }));
  const assistants = records.filter((record) => record.messageType === "ASSISTANT");
  const assistantStepIds = new Set(
    assistants.flatMap((record) =>
      record.sourceStepId === undefined ? [] : [String(record.sourceStepId)],
    ),
  );
  const assistantSamples = assistants.flatMap((record): PromptCacheUsageSample[] => {
    const usage = readDurableAssistantUsage(record);
    const invocationId = readDurableAssistantCallId(record);
    if (invocationId !== undefined && knownInvocationIds.has(invocationId)) return [];
    if (invocationId !== undefined) knownInvocationIds.add(invocationId);
    return [
      {
        purpose: "MAIN_AGENT",
        measuredAt: record.createdAt,
        ...(invocationId === undefined ? {} : { invocationId }),
        ...(invocationId === undefined ? {} : { invocationStatus: "COMPLETE" as const }),
        source: "ASSISTANT_MESSAGE",
        ...(usage === undefined ? {} : { usage }),
      },
    ];
  });
  const auxiliarySamples = budgetEntries.flatMap((entry): PromptCacheUsageSample[] => {
    if (entry.state === "RESERVED" || entry.state === "RELEASED") return [];
    let purpose: PromptCacheRequestPurpose;
    switch (entry.kind) {
      case "LLM_ATTEMPT":
        if (assistantStepIds.has(entry.ownerId)) return [];
        purpose = entry.providerCallId === undefined ? "OTHER" : "MAIN_AGENT";
        break;
      case "CONTEXT_COMPACTION":
        purpose = "CONTEXT_COMPACTION";
        break;
      case "VERIFICATION_LLM":
        purpose = "VERIFICATION_LLM";
        break;
      case "TOOL_INVOCATION":
        return [];
    }
    if (entry.providerCallId !== undefined && knownInvocationIds.has(entry.providerCallId)) {
      return [];
    }
    if (entry.providerCallId !== undefined) knownInvocationIds.add(entry.providerCallId);
    const usage: ModelUsage = {
      ...(entry.actualInputTokens === undefined ? {} : { inputTokens: entry.actualInputTokens }),
      ...(entry.actualOutputTokens === undefined ? {} : { outputTokens: entry.actualOutputTokens }),
      ...(entry.cacheHitInputTokens === undefined
        ? {}
        : { cachedInputTokens: entry.cacheHitInputTokens }),
      ...(entry.cacheMissInputTokens === undefined
        ? {}
        : { cacheMissInputTokens: entry.cacheMissInputTokens }),
      ...(entry.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: entry.cacheWriteInputTokens }),
      ...(entry.reasoningTokens === undefined ? {} : { reasoningTokens: entry.reasoningTokens }),
    };
    const measuredAt = entry.settledAt ?? entry.startedAt ?? entry.createdAt;
    return [
      {
        purpose,
        measuredAt,
        ...(entry.providerCallId === undefined ? {} : { invocationId: entry.providerCallId }),
        ...(entry.providerCallId === undefined ? {} : { invocationStatus: "COMPLETE" as const }),
        source: "BUDGET_LEDGER",
        ...(entry.cacheEpochId === undefined ? {} : { cacheEpochId: entry.cacheEpochId }),
        ...(entry.continuityGroup === undefined ? {} : { continuityGroup: entry.continuityGroup }),
        ...(entry.prefixFingerprint === undefined
          ? {}
          : { prefixFingerprint: entry.prefixFingerprint }),
        ...(Object.keys(usage).length === 0 ? {} : { usage }),
      },
    ];
  });
  samples.push(...assistantSamples, ...auxiliarySamples);
  return Object.freeze(samples.map((sample) => Object.freeze(sample)));
}

/** Build a safe Context Usage cache projection from durable usage and Prompt Surface metadata. */
export function projectPromptCacheUsage(
  contextUsage: Pick<ContextUsageSnapshot, "promptSurface" | "updatedAt">,
  samples: readonly PromptCacheUsageSample[],
  currentEpoch?: {
    readonly epochId: string;
    readonly resetReason: string;
    readonly createdStepSequence: number;
    readonly createdAt: TimestampMs;
  },
  surfaceSegments?: NonNullable<PromptCacheUsage["surfaceSegments"]>,
  surfaceRecords?: readonly {
    readonly kind: "BASELINE" | "DELTA" | "NOOP";
    readonly updates: readonly {
      readonly op: "SET" | "CLEAR";
      readonly stateKey: string;
      readonly contentHash?: string;
    }[];
    readonly byteLength: number;
  }[],
): PromptCacheUsage {
  const purposeTotals = new Map<
    PromptCacheRequestPurpose,
    {
      requestCount: number;
      inputTokens: number;
      outputTokens: number;
      hitTokens: number;
      missTokens: number;
      writeTokens: number;
      reasoningTokens: number;
      usageFieldCoverage: {
        inputTokens: number;
        outputTokens: number;
        hitTokens: number;
        missTokens: number;
        writeTokens: number;
        reasoningTokens: number;
      };
      unknownUsageCount: number;
    }
  >();
  const rateSamples: Array<{
    readonly measuredAt: TimestampMs;
    readonly hitTokens: number;
    readonly missTokens: number;
  }> = [];
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    hitTokens: 0,
    missTokens: 0,
    writeTokens: 0,
    unknownUsageCount: 0,
  };

  for (const sample of samples) {
    let purpose = purposeTotals.get(sample.purpose);
    if (purpose === undefined) {
      purpose = {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        hitTokens: 0,
        missTokens: 0,
        writeTokens: 0,
        reasoningTokens: 0,
        usageFieldCoverage: {
          inputTokens: 0,
          outputTokens: 0,
          hitTokens: 0,
          missTokens: 0,
          writeTokens: 0,
          reasoningTokens: 0,
        },
        unknownUsageCount: 0,
      };
      purposeTotals.set(sample.purpose, purpose);
    }
    purpose.requestCount = addPromptCacheCount(purpose.requestCount, 1);

    const usage = sample.usage;
    addOptionalPromptCacheCount(totals, purpose, usage, "inputTokens", "inputTokens");
    addOptionalPromptCacheCount(totals, purpose, usage, "outputTokens", "outputTokens");
    addOptionalPromptCacheCount(totals, purpose, usage, "cachedInputTokens", "hitTokens");
    addOptionalPromptCacheCount(totals, purpose, usage, "cacheMissInputTokens", "missTokens");
    addOptionalPromptCacheCount(totals, purpose, usage, "cacheWriteInputTokens", "writeTokens");
    const reasoningTokens = readUsageCount(usage?.reasoningTokens);
    if (reasoningTokens !== undefined) {
      purpose.reasoningTokens = addPromptCacheCount(purpose.reasoningTokens, reasoningTokens);
    }
    for (const [source, field] of [
      ["inputTokens", "inputTokens"],
      ["outputTokens", "outputTokens"],
      ["cachedInputTokens", "hitTokens"],
      ["cacheMissInputTokens", "missTokens"],
      ["cacheWriteInputTokens", "writeTokens"],
      ["reasoningTokens", "reasoningTokens"],
    ] as const) {
      if (readUsageCount(usage?.[source]) !== undefined) {
        purpose.usageFieldCoverage[field] = addPromptCacheCount(
          purpose.usageFieldCoverage[field],
          1,
        );
      }
    }

    const hitTokens = readUsageCount(usage?.cachedInputTokens);
    const missTokens = readUsageCount(usage?.cacheMissInputTokens);
    if (hitTokens === undefined || missTokens === undefined) {
      purpose.unknownUsageCount = addPromptCacheCount(purpose.unknownUsageCount, 1);
      totals.unknownUsageCount = addPromptCacheCount(totals.unknownUsageCount, 1);
      continue;
    }
    if (hitTokens + missTokens > 0) {
      rateSamples.push({ measuredAt: sample.measuredAt, hitTokens, missTokens });
    }
  }

  const promptSurface = contextUsage.promptSurface;
  const epochId = currentEpoch?.epochId ?? promptSurface?.epochId;
  const resetReason = isPromptCacheResetReason(currentEpoch?.resetReason)
    ? currentEpoch.resetReason
    : promptSurface?.resetReason;
  const expectedReusablePrefixTokens = promptSurface?.expectedReusablePrefixTokens ?? 0;
  const orderedRateSamples = [...rateSamples].sort(
    (left, right) => Number(left.measuredAt) - Number(right.measuredAt),
  );
  const latestRate = orderedRateSamples.at(-1);
  const resetBoundary = currentEpoch?.createdAt;
  const measuredAfterCurrentReset =
    latestRate !== undefined &&
    (resetBoundary === undefined || Number(latestRate.measuredAt) >= Number(resetBoundary));
  const resetPending =
    resetReason !== undefined &&
    resetReason !== "INITIAL" &&
    (resetBoundary === undefined
      ? latestRate === undefined || Number(latestRate.measuredAt) < Number(contextUsage.updatedAt)
      : !measuredAfterCurrentReset);
  const status: PromptCacheStatus = resetPending
    ? "RESET"
    : latestRate === undefined
      ? "UNREPORTED"
      : latestRate.hitTokens > 0
        ? "WARM"
        : "COLD_START";
  const ratesReported = latestRate !== undefined;
  const purposeOrder: readonly PromptCacheRequestPurpose[] = [
    "MAIN_AGENT",
    "VERIFICATION_LLM",
    "CONTEXT_COMPACTION",
    "WARMUP",
    "RETRY",
    "COMPACTION",
    "TITLE",
    "OTHER",
  ];
  const purposes: PromptCachePurposeUsage[] = purposeOrder.flatMap((purpose) => {
    const aggregate = purposeTotals.get(purpose);
    return aggregate === undefined
      ? []
      : [
          {
            purpose,
            ...aggregate,
          },
        ];
  });

  return {
    status,
    sampleCount: rateSamples.length,
    totalRequestCount: samples.length,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    hitTokens: totals.hitTokens,
    missTokens: totals.missTokens,
    writeTokens: totals.writeTokens,
    unknownUsageCount: totals.unknownUsageCount,
    ...(ratesReported
      ? { latestHitRate: latestRate!.hitTokens / (latestRate!.hitTokens + latestRate!.missTokens) }
      : {}),
    expectedReusablePrefixTokens,
    ...(epochId === undefined ? {} : { epochId }),
    ...(resetReason === undefined ? {} : { resetReason }),
    ...(currentEpoch === undefined || resetReason === undefined || resetReason === "INITIAL"
      ? {}
      : {
          resetStepSequence: currentEpoch.createdStepSequence,
          resetAt: currentEpoch.createdAt,
        }),
    ...(latestRate === undefined ? {} : { lastMeasuredAt: latestRate.measuredAt }),
    purposes,
    metricsV2: projectCacheMetricsV2(samples, surfaceRecords),
    ...(surfaceSegments === undefined ? {} : { surfaceSegments }),
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const CACHE_ROLLING_WINDOW = 10;

/**
 * One aggregation authority for provider-reported cache counters. Samples without the durable
 * Gateway call id remain visible in the legacy totals, but cannot enter V2 rates or the request
 * coverage denominator because they cannot be deduplicated safely.
 */
function projectCacheMetricsV2(
  samples: readonly PromptCacheUsageSample[],
  surfaceRecords: Parameters<typeof projectPromptCacheUsage>[4],
): CacheMetricsV2 {
  const identifiedByCall = new Map<string, PromptCacheUsageSample>();
  for (const sample of samples) {
    const id = sample.invocationId;
    if (id === undefined) continue;
    const previous = identifiedByCall.get(id);
    if (previous === undefined) {
      identifiedByCall.set(id, sample);
      continue;
    }
    if (canonicalJson(sample) !== canonicalJson(previous)) {
      throw new TypeError("One provider call identity has conflicting cache usage samples.");
    }
  }
  const observed = [...identifiedByCall.values()].sort((left, right) => {
    const byTime = Number(left.measuredAt) - Number(right.measuredAt);
    return byTime === 0
      ? (left.invocationId ?? "").localeCompare(right.invocationId ?? "")
      : byTime;
  });
  const complete = observed.filter((sample) => hasCompleteCacheUsage(sample));
  const main = observed.filter((sample) => sample.purpose === "MAIN_AGENT");
  const warmAll = warmSamples(observed);
  const warmMain = warmAll.filter((sample) => sample.purpose === "MAIN_AGENT");
  const rollingAll = complete
    .filter((sample) => hasPositiveCacheDenominator(sample))
    .slice(-CACHE_ROLLING_WINDOW);
  const rollingMain = complete
    .filter((sample) => sample.purpose === "MAIN_AGENT" && hasPositiveCacheDenominator(sample))
    .slice(-CACHE_ROLLING_WINDOW);
  const latest = observed.at(-1);
  const previousInputCoverage = previousInputCoverageProxy(main);
  const completeCount = complete.length;
  const observedCount = observed.length;
  const providerUsageUnreportedCount = observed.filter(
    (sample) => !hasAnyProviderUsage(sample),
  ).length;
  const providerUsageWithoutCacheBreakdownCount = observed.filter(
    (sample) => hasAnyProviderUsage(sample) && !hasCompleteCacheUsage(sample),
  ).length;
  const failedOrCancelledWithoutUsageCount = observed.filter(
    (sample) =>
      (sample.invocationStatus === "FAILED" || sample.invocationStatus === "CANCELLED") &&
      !hasAnyProviderUsage(sample),
  ).length;
  const inProgressInvocationCount = observed.filter(
    (sample) => sample.invocationStatus === "OBSERVED",
  ).length;
  const missingInvocationRecordCount = observed.filter(
    (sample) => sample.source !== undefined && sample.source !== "GATEWAY",
  ).length;
  const legacyWithoutCacheBreakdownCount = observed.filter(
    (sample) =>
      sample.source !== undefined && sample.source !== "GATEWAY" && !hasCompleteCacheUsage(sample),
  ).length;
  const surfaceDelta = projectSurfaceDeltaDiagnostics(surfaceRecords);

  return {
    fullRun: { mainAgent: cacheRate(main), allPurposes: cacheRate(observed) },
    warm: { mainAgent: cacheRate(warmMain), allPurposes: cacheRate(warmAll) },
    rolling: {
      windowSize: CACHE_ROLLING_WINDOW,
      mainAgent: cacheRate(rollingMain),
      allPurposes: cacheRate(rollingAll),
    },
    ...(latest === undefined
      ? {}
      : {
          latestRequest: {
            purpose: latest.purpose,
            ...(readUsageCount(latest.usage?.inputTokens) === undefined
              ? {}
              : { inputTokens: latest.usage!.inputTokens }),
            ...(readUsageCount(latest.usage?.cachedInputTokens) === undefined
              ? {}
              : { hitTokens: latest.usage!.cachedInputTokens }),
            ...(readUsageCount(latest.usage?.cacheMissInputTokens) === undefined
              ? {}
              : { missTokens: latest.usage!.cacheMissInputTokens }),
            ...(readUsageCount(latest.usage?.cacheWriteInputTokens) === undefined
              ? {}
              : { writeTokens: latest.usage!.cacheWriteInputTokens }),
            cacheUsageReported: hasCompleteCacheUsage(latest),
          },
        }),
    ...(previousInputCoverage === undefined ? {} : { previousInputCoverage }),
    usageCoverage: {
      observedRequestCount: observedCount,
      completeCacheUsageCount: completeCount,
      incompleteOrUnknownCount: observedCount - completeCount,
      providerUsageUnreportedCount,
      providerUsageWithoutCacheBreakdownCount,
      failedOrCancelledWithoutUsageCount,
      inProgressInvocationCount,
      missingInvocationRecordCount,
      legacyWithoutCacheBreakdownCount,
      unidentifiedLegacySampleCount: samples.filter((sample) => sample.invocationId === undefined)
        .length,
      ...(observedCount === 0 ? {} : { coverageRate: completeCount / observedCount }),
      status:
        observedCount === 0
          ? "UNREPORTED"
          : completeCount === observedCount
            ? "REPORTED"
            : completeCount === 0
              ? "UNREPORTED"
              : "PARTIAL",
    },
    surfaceDelta,
  };
}

function hasAnyProviderUsage(sample: PromptCacheUsageSample): boolean {
  const usage = sample.usage;
  if (usage === undefined) return false;
  return [
    usage.totalTokens,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheMissInputTokens,
    usage.cacheWriteInputTokens,
    usage.reasoningTokens,
  ].some((value) => readUsageCount(value) !== undefined);
}

function hasCompleteCacheUsage(sample: PromptCacheUsageSample): boolean {
  return (
    readUsageCount(sample.usage?.cachedInputTokens) !== undefined &&
    readUsageCount(sample.usage?.cacheMissInputTokens) !== undefined
  );
}

function hasPositiveCacheDenominator(sample: PromptCacheUsageSample): boolean {
  const hit = readUsageCount(sample.usage?.cachedInputTokens);
  const miss = readUsageCount(sample.usage?.cacheMissInputTokens);
  return hit !== undefined && miss !== undefined && hit + miss > 0;
}

function cacheRate(
  samples: readonly PromptCacheUsageSample[],
): CacheMetricsV2["fullRun"]["mainAgent"] {
  let requestCount = 0;
  let hitTokens = 0;
  let accountedTokens = 0;
  for (const sample of samples) {
    if (!hasCompleteCacheUsage(sample)) continue;
    const hit = sample.usage!.cachedInputTokens!;
    const miss = sample.usage!.cacheMissInputTokens!;
    requestCount = addPromptCacheCount(requestCount, 1);
    hitTokens = addPromptCacheCount(hitTokens, hit);
    accountedTokens = addPromptCacheCount(accountedTokens, addPromptCacheCount(hit, miss));
  }
  return {
    requestCount,
    hitTokens,
    accountedTokens,
    ...(accountedTokens === 0 ? {} : { hitRate: hitTokens / accountedTokens }),
  };
}

/** First MAIN_AGENT call in each explicitly identified Cache Epoch is the cold boundary. */
function warmSamples(samples: readonly PromptCacheUsageSample[]): PromptCacheUsageSample[] {
  const firstMainCallByEpoch = new Map<string, string>();
  for (const sample of samples) {
    if (sample.purpose !== "MAIN_AGENT" || sample.cacheEpochId === undefined) continue;
    const key = `${sample.continuityGroup ?? ""}\u0000${sample.cacheEpochId}`;
    if (!firstMainCallByEpoch.has(key)) firstMainCallByEpoch.set(key, sample.invocationId ?? "");
  }
  return samples.filter((sample) => {
    if (sample.cacheEpochId === undefined) return false;
    const key = `${sample.continuityGroup ?? ""}\u0000${sample.cacheEpochId}`;
    const first = firstMainCallByEpoch.get(key);
    return first !== undefined && sample.invocationId !== first;
  });
}

function previousInputCoverageProxy(
  samples: readonly PromptCacheUsageSample[],
): CacheMetricsV2["previousInputCoverage"] {
  for (let index = samples.length - 1; index > 0; index -= 1) {
    const current = samples[index]!;
    const previous = samples[index - 1]!;
    if (
      current.cacheEpochId === undefined ||
      current.cacheEpochId !== previous.cacheEpochId ||
      current.continuityGroup === undefined ||
      current.continuityGroup !== previous.continuityGroup ||
      current.prefixFingerprint === undefined ||
      current.prefixFingerprint !== previous.prefixFingerprint ||
      !hasCompleteCacheUsage(current)
    ) {
      return undefined;
    }
    const previousInput = readUsageCount(previous.usage?.inputTokens);
    if (previousInput === undefined || previousInput === 0) return undefined;
    const hit = current.usage!.cachedInputTokens!;
    const boundedHit = Math.min(hit, previousInput);
    return {
      classification: "DIAGNOSTIC_PROXY",
      hitTokens: boundedHit,
      previousInputTokens: previousInput,
      coverage: boundedHit / previousInput,
    };
  }
  return undefined;
}

function projectSurfaceDeltaDiagnostics(
  records: Parameters<typeof projectPromptCacheUsage>[4],
): CacheMetricsV2["surfaceDelta"] {
  if (records === undefined) return { availability: "NOT_AVAILABLE_FOR_V2" };
  let baselineCount = 0;
  let deltaCount = 0;
  let noopCount = 0;
  let setCount = 0;
  let clearCount = 0;
  let bytes = 0;
  let unchangedSectionReemissionCount = 0;
  const activeHashes = new Map<string, string>();
  for (const record of records) {
    if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0) {
      throw new RangeError("Prompt Surface record byte length is invalid.");
    }
    bytes = addPromptCacheCount(bytes, record.byteLength);
    if (record.kind === "BASELINE") baselineCount = addPromptCacheCount(baselineCount, 1);
    else if (record.kind === "DELTA") deltaCount = addPromptCacheCount(deltaCount, 1);
    else noopCount = addPromptCacheCount(noopCount, 1);
    if (record.kind === "NOOP" && record.byteLength !== 0) {
      throw new TypeError("Prompt Surface NOOP record must not add model-visible bytes.");
    }
    for (const update of record.updates) {
      if (update.op === "CLEAR") {
        clearCount = addPromptCacheCount(clearCount, 1);
        activeHashes.delete(update.stateKey);
      } else {
        setCount = addPromptCacheCount(setCount, 1);
        const priorHash = activeHashes.get(update.stateKey);
        if (priorHash !== undefined && priorHash === update.contentHash) {
          unchangedSectionReemissionCount = addPromptCacheCount(unchangedSectionReemissionCount, 1);
        }
        if (update.contentHash !== undefined) activeHashes.set(update.stateKey, update.contentHash);
      }
    }
  }
  return {
    availability: "AVAILABLE",
    baselineCount,
    deltaCount,
    noopCount,
    setCount,
    clearCount,
    newModelVisibleBytes: bytes,
    estimatedNewContextTokens: Math.ceil(bytes / 3),
    unchangedSectionReemissionCount,
    tokenEstimateKind: "ESTIMATED",
  };
}

function normalizeSha256(value: string): string {
  const normalized = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError("Prompt Surface fingerprint is invalid.");
  }
  return normalized;
}

function safePromptFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePromptFingerprintValue);
  if (value === null || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (
      /(?:provider.?state|reasoning|credential|api.?key|secret|endpoint|session.?id|run.?id|step.?id|message.?id)/i.test(
        key,
      )
    ) {
      continue;
    }
    safe[key] = safePromptFingerprintValue(member);
  }
  return safe;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    .join(",")}}`;
}

function boundedFingerprintText(value: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength) {
    throw new TypeError("Prompt Surface message role is invalid.");
  }
  return value;
}

function assertPromptCacheCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Prompt-cache segment count is outside the safe integer range.");
  }
  return value;
}

function readDurableAssistantUsage(record: AgentMessageRecord): ModelUsage | undefined {
  const model = record.data["model"];
  if (model === null || typeof model !== "object" || Array.isArray(model)) return undefined;
  const candidate = model as Record<string, unknown>;
  if (candidate["kind"] !== "MODEL_TURN") return undefined;
  const usage = candidate["usage"];
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const counters: Record<string, number | undefined> = {};
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "cacheMissInputTokens",
    "cacheWriteInputTokens",
  ] as const) {
    const value = (usage as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!isPromptCacheTokenCount(value)) return undefined;
    counters[field] = value;
  }
  return counters as ModelUsage;
}

function readDurableAssistantCallId(record: AgentMessageRecord): string | undefined {
  const model = record.data["model"];
  if (model === null || typeof model !== "object" || Array.isArray(model)) return undefined;
  const candidate = model as Record<string, unknown>;
  if (candidate["kind"] !== "MODEL_TURN") return undefined;
  const callId = candidate["callId"];
  return typeof callId === "string" && callId.length > 0 ? callId : undefined;
}

function addOptionalPromptCacheCount(
  totals: {
    inputTokens: number;
    outputTokens: number;
    hitTokens: number;
    missTokens: number;
    writeTokens: number;
  },
  purpose: {
    inputTokens: number;
    outputTokens: number;
    hitTokens: number;
    missTokens: number;
    writeTokens: number;
  },
  usage: ModelUsage | undefined,
  source:
    | "inputTokens"
    | "outputTokens"
    | "cachedInputTokens"
    | "cacheMissInputTokens"
    | "cacheWriteInputTokens",
  target: "inputTokens" | "outputTokens" | "hitTokens" | "missTokens" | "writeTokens",
): void {
  const count = readUsageCount(usage?.[source]);
  if (count === undefined) return;
  totals[target] = addPromptCacheCount(totals[target], count);
  purpose[target] = addPromptCacheCount(purpose[target], count);
}

function readUsageCount(value: unknown): number | undefined {
  return isPromptCacheTokenCount(value) ? value : undefined;
}

function isPromptCacheTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function addPromptCacheCount(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError("Prompt-cache usage counter is outside the safe integer range.");
  }
  return result;
}

function isPromptCacheResetReason(
  value: string | undefined,
): value is NonNullable<ContextUsageSnapshot["promptSurface"]>["resetReason"] {
  return (
    value === "INITIAL" ||
    value === "MODEL_CHANGED" ||
    value === "TOOL_SCHEMA_CHANGED" ||
    value === "STABLE_HEAD_CHANGED" ||
    value === "CACHE_SETTINGS_CHANGED" ||
    value === "COMPACTION_COMMITTED" ||
    value === "RECOVERY_INCOMPATIBLE"
  );
}

/**
 * The four Runtime Operations adapters, as the one bundle `createDefaultCodingTools` expects.
 *
 * This is the only place in the daemon that constructs them, and it is the only place that holds a
 * `RuntimeResolver` for a Coding Tool: the Tools themselves receive narrow ports, so a `read_file`
 * implementation cannot reach `git` and a `git_status` implementation cannot reach the filesystem.
 */
function defaultCodingOperations(
  runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>,
  securityCapabilityService: SecurityCapabilityService,
): DefaultCodingToolOperations {
  const readOnly = createRuntimeReadOnlyOperations(runtimeResolver);
  const process = createRuntimeProcessOperations(runtimeResolver, {
    authorizationResolver: async ({ ownerRunId, environment, securityContext }) => {
      const reference = securityContext?.securityPolicy;
      if (reference === undefined) return undefined;
      const policy = createRuntimeProcessPolicy({
        runId: ownerRunId,
        workspaceId: environment.workspace.id,
        workspaceRoot: environment.workspace.path,
        filesystemBoundary: reference.filesystemBoundary,
        processBoundary: reference.processBoundary,
        requiredEnforcement: reference.requiredEnforcement,
      });
      const provider = await securityCapabilityService.selectRuntimeProcessProvider(policy);
      return createAuthorizedRuntimeExecution({
        policy,
        provider,
        authorizationNonce: `${ownerRunId}:${reference.policyDigest}:tool`,
      });
    },
  });
  return {
    readFile: readOnly,
    readOnly,
    patch: createRuntimePatchOperations(runtimeResolver),
    exec: process,
    process,
    git: createRuntimeGitOperations(runtimeResolver),
  };
}

/**
 * The default Coding Tool set for a known environment.
 *
 * Git exposure fails closed: `UNKNOWN` is treated exactly like `UNAVAILABLE`, because a host that cannot
 * prove Git works must not offer a model a Tool that will fail. Dropping the two Git *definitions* —
 * rather than filtering a built registry — is what keeps the registry, the Coding catalog, the
 * model-visible specs and the prompt guidance block describing the same active set.
 *
 * Phase 4F replaced the legacy `filterToolRegistryForEnvironment` with the Coding product layer's own
 * `withoutGitTools` semantics, applied at the one point the default set is derived. There is now a single
 * exposure authority: the definition list, decided before anything is built.
 */
function defaultCodingToolSet(
  operations: DefaultCodingToolOperations,
  environment: GitToolAvailability,
): readonly CodingToolDefinition[] {
  const definitions = createDefaultCodingTools(operations);
  if (environment === "AVAILABLE") return definitions;
  const excluded = new Set<string>(GIT_TOOL_NAMES);
  return Object.freeze(definitions.filter((definition) => !excluded.has(definition.tool.name)));
}

/**
 * Build one immutable canonical Tool registry from the host's Coding Tool definitions.
 *
 * ```text
 * CodingToolDefinition   the executable AgentTool plus its Coding overlay
 *        ↓ registry.register(definition.tool)
 * AgentToolRegistry      the resolvable, model-spec-producing execution authority
 * ```
 *
 * The registry receives the **executable Tool**, not the overlay: the Agent Tool Layer may not learn what
 * risk level, capability or prompt snippet a Coding Tool carries, and
 * `AgentToolRegistry.modelSpecs()` is what keeps a provider request to three fields per Tool.
 *
 * Phase 4F replaced the legacy `ToolRegistryBuilder` — which accepted `ToolRegistration |
 * CodingToolDefinition` and projected both into this registry — with the canonical builder directly. The
 * legacy shape is gone, so there is nothing left to project.
 */
function buildToolRegistry(
  definitions: readonly CodingToolDefinition[],
): import("@caelush/agent").AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const definition of definitions) builder.register(definition.tool);
  return builder.build();
}

/**
 * Build the Coding overlay for the Tools this host registered, refusing a dangling entry.
 *
 * ```text
 * the Coding Tool definitions        → CodingToolCatalogBuilder.register
 * the active AgentToolRegistry       → CodingToolCatalogBuilder.forRegistry
 *        ↓
 * CodingToolCatalog                  risk level · facts projector · effect projector · prompt snippet
 * ```
 *
 * `forRegistry()` is the alignment step: it refuses any entry whose Tool the active registry cannot
 * execute, which is what keeps Coding metadata describing a call that can actually happen.
 */
function createActiveCodingCatalog(
  registry: import("@caelush/agent").AgentToolRegistry,
  definitions: readonly CodingToolDefinition[],
): CodingToolCatalog {
  const builder = new CodingToolCatalogBuilder().forRegistry(registry);
  for (const definition of definitions) builder.register(definition);
  return builder.build();
}

/**
 * The Coding Tool prompt provider, as the V2 Context Engine reads it.
 *
 * ```text
 * the provider's ContextItem   { id, priorityClass, content, tokenEstimate, whyLoaded }
 *        ↓  this projection
 * the Context package's item   { id, type: "TOOL_GUIDANCE", …, content, tokenEstimate }
 * ```
 *
 * Two packages declare a `ContextItem`: `@caelush/agent` states the minimal text item a Context
 * *provider* contributes, and `@caelush/agent` owns the typed item its budgeted build stores. The
 * composition root is the only layer that knows both, so the projection is made here.
 *
 * `type` is `TOOL_GUIDANCE` rather than `MEMORY`, because the renderer labels the block from it and
 * guidance is not retrieved knowledge. `sensitivity` is `PUBLIC`: a Coding prompt snippet is a constant
 * compiled into a Tool definition — it carries no workspace path, no secret and no live value — and
 * marking it otherwise would make the renderer drop it.
 */
function createRunBoundVerificationWorkspace(runtime: LocalRuntime): WorkspaceVerificationPort {
  return {
    async inspect(input) {
      const scope = await runtime.openWorkspace(input.workspace);
      return createRuntimeWorkspaceVerificationPort(scope).inspect(input);
    },
  };
}

/**
 * Read-only completion evidence view over the durable Tool and observation repositories.
 *
 * The completion reviewer receives the observation content projection, never the durable invocation
 * arguments. Storage remains the authority for both records; this adapter only joins their identities
 * so Core can request one Run-scoped evidence input.
 */
function createDurableToolObservationPort(
  storage: Pick<CaelushStorage, "observations" | "toolInvocations">,
): { listByRun(runId: RunId): Promise<readonly VerificationToolObservationInput[]> } {
  return {
    async listByRun(runId) {
      const [observations, invocations] = await Promise.all([
        storage.observations.listByRun(runId),
        storage.toolInvocations.listByRun(runId),
      ]);
      const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
      const projected: VerificationToolObservationInput[] = [];
      for (const observation of observations) {
        if (observation.kind !== "TOOL") continue;
        const invocation = invocationById.get(observation.toolInvocationId);
        projected.push({
          observation,
          ...(invocation === undefined ? {} : { toolName: invocation.toolName }),
          ...(invocation === undefined ? {} : { invocationStatus: invocation.status }),
        });
      }
      return projected;
    },
  };
}

function createRunBoundVerificationGit(runtime: LocalRuntime): VerificationGitPort {
  return {
    async status(input: {
      workspace?: import("@caelush/protocol").WorkspaceRef;
      signal?: AbortSignal;
    }) {
      if (input.workspace === undefined) throw new Error("verification workspace is unavailable");
      const scope = await runtime.openWorkspace(input.workspace);
      return createRuntimeGitVerificationPort(scope).status(input);
    },
    async diff(input: {
      workspace?: import("@caelush/protocol").WorkspaceRef;
      path: string;
      scope?: "WORKTREE" | "STAGED" | "ALL";
      signal?: AbortSignal;
    }) {
      if (input.workspace === undefined) throw new Error("verification workspace is unavailable");
      const scope = await runtime.openWorkspace(input.workspace);
      return createRuntimeGitVerificationPort(scope).diff(input);
    },
  };
}

/**
 * Observe the frozen gateway without changing it.
 *
 * The decorator records only safe structural facts — identity, message roles, tool
 * names and the finish reason — and it is a pure pass-through: the events, their order
 * and the call id are the gateway's, and no error path is altered. A diagnostic write
 * can never fail an invocation.
 */
function createDiagnosedGateway(
  gateway: AIGateway,
  diagnostic: ModelWireDiagnostic | undefined,
  models: ModelCatalog,
): AIGateway {
  if (diagnostic === undefined) return gateway;
  const cacheResolver = createCacheResolver();

  return {
    async stream(request: AIModelRequest, options): Promise<AIStream> {
      const startedAt = Date.now();
      const stream = await gateway.stream(request, options);
      diagnostic.record({
        phase: "REQUEST",
        callId: stream.callId,
        providerId: request.model.provider,
        model: request.model.model,
        messageRoles: request.messages.map((message) => message.role),
        toolNames: (request.tools ?? []).map((tool) => tool.name),
        modelSettings: safeModelSettings(request, models.resolve(request.model), cacheResolver),
      });
      return {
        callId: stream.callId,
        events: observeEvents(stream.events, stream.callId, request, startedAt, diagnostic),
        takePrivateCompletion: () => stream.takePrivateCompletion(),
      };
    },
    complete(request: AIModelRequest, options) {
      return gateway.complete(request, options);
    },
  };
}

async function* observeEvents(
  events: AsyncIterable<import("@caelush/ai").AIStreamEvent>,
  callId: string,
  request: AIModelRequest,
  startedAt: number,
  diagnostic: ModelWireDiagnostic,
): AsyncIterable<import("@caelush/ai").AIStreamEvent> {
  const toolNames: string[] = [];
  for await (const event of events) {
    if (event.type === "tool_call.completed") toolNames.push(event.payload.name);
    if (event.type === "stream.finish") {
      diagnostic.record({
        phase: "RESPONSE",
        callId,
        providerId: request.model.provider,
        model: request.model.model,
        finishReason: event.payload.finishReason,
        toolNames,
        durationMs: Date.now() - startedAt,
      });
    }
    yield event;
  }
}

/** Numbers and bounded policy enums only; cache identity and credentials are omitted. */
function safeModelSettings(
  request: AIModelRequest,
  model: ModelDescriptor,
  cacheResolver: ReturnType<typeof createCacheResolver>,
): Record<string, string | number> {
  const settings: Record<string, string | number> = {};
  if (request.settings?.maxOutputTokens !== undefined) {
    settings["maxOutputTokens"] = request.settings.maxOutputTokens;
  }
  if (request.settings?.temperature !== undefined)
    settings["temperature"] = request.settings.temperature;
  if (request.settings?.reasoning !== undefined)
    settings["reasoning"] = request.settings.reasoning.level;
  if (request.toolChoice !== undefined) settings["toolChoice"] = request.toolChoice.type;
  const cache = cacheResolver.resolve({
    model,
    ...(request.settings?.cache === undefined ? {} : { request: request.settings.cache }),
  });
  settings["cacheRequestedRetention"] = cache.requested;
  settings["cacheEffectiveRetention"] = cache.effective;
  settings["cacheMode"] = cache.mode;
  settings["cacheDialect"] = safeCacheDialect(model, cache.effective);
  return settings;
}

/** A bounded diagnostic projection of the selected adapter's cache behavior. */
function safeCacheDialect(
  model: ModelDescriptor,
  retention: import("@caelush/ai").CacheRetention,
): "NONE" | "AUTOMATIC" | "MARKER" | "UNKNOWN" {
  if (retention === "NONE") return "NONE";
  const descriptorSupportsRetention =
    model.capabilities.promptCaching === "SUPPORTED" &&
    model.cache?.supportedRetentions.includes(retention) === true;
  if (!descriptorSupportsRetention) return "UNKNOWN";

  const compatibleMetadata = model.adapterMetadata?.["openai-compatible"];
  if (isJsonObject(compatibleMetadata) && compatibleMetadata["cacheDialect"] === "AUTOMATIC") {
    return "AUTOMATIC";
  }
  if (
    model.api === "anthropic-messages" &&
    model.cache?.supportedRetentions.includes(retention) === true
  ) {
    return "MARKER";
  }
  return "UNKNOWN";
}

/** Preserve an explicit host request, otherwise derive intent from model metadata. */
export function resolveDefaultCacheRequest(
  model: ModelDescriptor,
  explicit?: AICacheRequest,
): AICacheRequest | undefined {
  if (explicit !== undefined) return explicit;
  const retention = model.cache?.defaultRetention;
  return retention === undefined ? undefined : { retention };
}
