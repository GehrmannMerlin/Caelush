import {
  AgentLoop,
  RunController,
  RunDeadlineRegistry,
  RunExecutionScopeRegistry,
  RunRetryRegistry,
  createProjectProfileProvider,
  type RunExecutionConfigResolver,
} from "@caelush/core";
import { EventBus } from "@caelush/events";
import {
  ContextRuntimeCoordinator,
  createContextItem,
  createContextUsageProjection,
  createDefaultContextBuilder,
  createLocalProjectInspector,
  createLocalRelevantFilePlanner,
  createModelContextProfile,
  Utf8HeuristicTokenEstimator,
} from "@caelush/context";
import { MemoryRetriever, type MemoryRecord } from "@caelush/memory";
import { createAISubsystem } from "@caelush/ai";
import {
  createDaemonApiAdapters,
  toAIProviderBinding,
  toModelDescriptorSources,
} from "./providers/legacy-ai-configuration.js";
import { CatalogModelCanonicalizer } from "./providers/model-canonicalizer.js";
import {
  createModelWireDiagnostic,
  createSafeModelWireDiagnostic,
  type ModelWireDiagnostic,
  type ModelWireDiagnosticEvent,
} from "./providers/model-wire-diagnostic.js";
import { createModelTurnExecutor } from "@caelush/agent";
import type {
  AISubsystem,
  AIGateway,
  AIModelRequest,
  AIStream,
  ModelDescriptorSourcePort,
} from "@caelush/ai";
import {
  DaemonInfoSchema,
  createApprovalRequestId,
  createEventId,
  createObservationId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type ClientModelSelection,
  type DaemonInfo,
  type DefaultRunConfiguration,
  type TimestampMs,
} from "@caelush/protocol";
import {
  LocalRuntime,
  createLocalRuntimeResolver,
  sanitizeTerminalOutput,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";
import {
  DefaultVerificationPlanner,
  ProjectCheckResolverRegistry,
  VerificationRunner,
  createVerificationRepairPolicy,
  type VerificationCommandExecutionPort,
  type VerificationGitPort,
  type WorkspaceVerificationPort,
} from "@caelush/verification";
import {
  createDefaultBuiltinToolRegistrations,
  filterToolRegistryForEnvironment,
  ToolBatchCoordinator,
  ToolRegistryBuilder,
  type ToolCallingDebugEvent,
  type ToolExposureEnvironment,
} from "@caelush/tools";
import {
  createV1SecureToolDispatcher,
  verificationCommandSecurityPort,
  verificationEvidenceSanitizer,
} from "@caelush/security";
import type { CaelushStorage } from "@caelush/storage";
import {
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
import { SessionConversationContextProvider } from "./services/session-conversation-context.js";
import { DAEMON_VERSION } from "./version.js";

export const DEFAULT_CORE_AGENT_POLICY = [
  "You are Caelush, a careful workspace agent.",
  "Use the active workspace as the only path root; use '.' when referring to its root.",
  "Inspect relevant files and gather evidence before making claims or changes.",
  "Use the native tool that matches the task; do not use mutation tools for read-only work.",
  "Tool selection: use list_directory for immediate children, find_files for unknown paths, search_text for content search, read_file for known text files, git_status and git_diff for Git evidence, apply_patch for requested file changes, exec_command for tests/build/install/service commands, and write_stdin only for a session returned by exec_command.",
  "Do not use exec_command to read files, list directories, or search code when a native Tool is sufficient.",
  "Treat Tool errors as observations: correct recoverable inputs, avoid repeating an unchanged failure, and do not call an inapplicable tool.",
  "After a mutation, inspect the resulting files and relevant diff before claiming success.",
  "Stop when the requested evidence is sufficient; report blockers and uncertainty plainly.",
  "Do not reveal hidden chain-of-thought or invent evidence.",
].join(" ");

export const DEFAULT_BASE_SYSTEM_PROMPT = DEFAULT_CORE_AGENT_POLICY;

const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  maxInputTokens: 32_000,
  safetyMarginTokens: 512,
  maxConversationTokens: 12_000,
  maxRelevantFileTokens: 12_000,
  minRelevantFileTokens: 128,
});

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
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  resourcePolicy: DEFAULT_ADAPTIVE_RESOURCE_POLICY,
}) satisfies DefaultRunConfiguration;

export interface DaemonClock {
  now(): TimestampMs;
}

export interface DaemonCompositionOptions {
  readonly storage: CaelushStorage;
  readonly eventBus: EventBus;
  readonly providers?: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
  /** AI-native composition seams for tests and hosts. */
  readonly providerBindings?: readonly import("@caelush/ai").AIProviderBinding[];
  readonly modelSources?: readonly ModelDescriptorSourcePort[];
  readonly adapterOverrides?: readonly import("@caelush/ai").ApiAdapter[];
  /** Capability discovered for the selected workspace; unknown hides Git tools. */
  readonly toolExposure?: ToolExposureEnvironment;
  readonly runtime?: LocalRuntime;
  readonly clock?: DaemonClock;
  readonly logger?: RunExecutionSupervisorLogger;
  readonly configResolver?: RunExecutionConfigResolver;
  readonly wireDiagnosticWriter?: (
    event: import("./providers/model-wire-diagnostic.js").ModelWireDiagnosticEvent,
  ) => void;
  /** Safe Tool-calling diagnostics; the writer receives no raw arguments or output. */
  readonly toolCallingDebugWriter?: (event: ToolCallingDebugEvent) => void;
}

export interface DaemonComposition {
  readonly eventBus: EventBus;
  readonly runs: Pick<CaelushStorage["runs"], "get">;
  readonly runtime: LocalRuntime;
  readonly runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>;
  /** The V2 AI subsystem: the single model invocation authority. */
  readonly ai: AISubsystem;
  readonly modelTurns: ReturnType<typeof createModelTurnExecutor>;
  readonly toolRegistry: ReturnType<ToolRegistryBuilder["build"]>;
  readonly toolCoordinator: ToolBatchCoordinator;
  readonly contextRuntime: ContextRuntimeCoordinator;
  readonly contextUsage: {
    getContextUsage(
      runId: string,
    ): Promise<import("@caelush/context").ContextUsageProjection | undefined>;
  };
  readonly controller: RunController;
  readonly supervisor: RunExecutionSupervisor;
  readonly approvals: Pick<CaelushStorage["approvals"], "listPendingByRun">;
  readonly modelCanonicalizer: DaemonModelCanonicalizer;
  readonly info: DaemonInfo;
  dispose(): Promise<void>;
}

export function composeDaemon(options: DaemonCompositionOptions): DaemonComposition {
  const providers = [...(options.providers ?? [])];
  const clock = options.clock ?? { now: () => createTimestampMs(Date.now()) };
  const runtime = options.runtime ?? new LocalRuntime();
  const runtimeResolver = createLocalRuntimeResolver(runtime);
  const ai = createAISubsystem({
    modelSources: [...providers.flatMap(toModelDescriptorSources), ...(options.modelSources ?? [])],
    providers: [...providers.map(toAIProviderBinding), ...(options.providerBindings ?? [])],
    adapters: [...createDaemonApiAdapters(), ...(options.adapterOverrides ?? [])],
  });
  // The diagnostic is a transparent decorator over the frozen gateway: the AI core
  // contract gains no debug callback, and nothing here can observe an endpoint, a
  // credential, a header, a prompt or a tool argument.
  const wireDiagnostic =
    options.wireDiagnosticWriter === undefined
      ? createSafeModelWireDiagnostic()
      : createModelWireDiagnostic({ writer: options.wireDiagnosticWriter });
  const gateway = createDiagnosedGateway(ai.gateway, wireDiagnostic);
  const modelTurns = createModelTurnExecutor({ gateway });

  const inspector = createLocalProjectInspector();
  const memoryRetriever = new MemoryRetriever(options.storage.memory);
  const memoryEstimator = new Utf8HeuristicTokenEstimator();
  const configuredProfiles = providers.flatMap((config) =>
    Object.entries(config.modelProfiles ?? {}).map(([modelId, profile]) =>
      createModelContextProfile({
        providerId: config.provider,
        modelId,
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens,
        recommendedOutputReserveTokens: profile.recommendedOutputReserveTokens,
        supportsPromptCaching: profile.supportsPromptCaching ?? false,
        supportsUsageReporting: profile.supportsUsageReporting ?? false,
        ...(profile.toolOutputSoftLimitTokens === undefined
          ? {}
          : { toolOutputSoftLimitTokens: profile.toolOutputSoftLimitTokens }),
        profileSource: "CONFIGURATION",
      }),
    ),
  );
  const contextRuntime = new ContextRuntimeCoordinator({
    configuredProfiles,
    checkpointRepository: options.storage.contextCheckpoints,
    usageRepository: options.storage.contextRuntimeStates,
    clock,
    checkpointIdFactory: { create: () => createEventId() },
    memoryLoader: async ({ projectId, goal, maxTokens }) => {
      const records = await memoryRetriever.retrieve({
        scope: "PROJECT",
        ...(projectId === undefined ? {} : { projectId }),
        goal,
        maxItems: 32,
        maxTokens,
      });
      return projectMemoryRecords(records, maxTokens, memoryEstimator);
    },
    rawObservationLoader: async ({ runId, artifactRef }) => {
      const artifact = await options.storage.contextArtifacts.readInternal(artifactRef);
      return artifact?.runId === runId ? artifact.content : undefined;
    },
  });
  const agentLoop = new AgentLoop({
    inspector,
    planner: createLocalRelevantFilePlanner(),
    contextBuilder: createDefaultContextBuilder(),
    contextRuntime,
    models: ai.models,
    modelTurns,
    clock,
    stepIdFactory: { create: createStepId },
  });
  const builtToolRegistry = new ToolRegistryBuilder();
  for (const registration of createDefaultBuiltinToolRegistrations(runtimeResolver)) {
    builtToolRegistry.register(registration);
  }
  const activeToolRegistry = filterToolRegistryForEnvironment(
    builtToolRegistry.build(),
    options.toolExposure ?? { git: "AVAILABLE" },
  );
  const dispatcher = createV1SecureToolDispatcher({
    registry: activeToolRegistry,
    store: options.storage.toolExecution,
    notifier: options.eventBus,
    clock,
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    approvalStore: options.storage.approvals,
    approvalIdFactory: { create: createApprovalRequestId },
    budget: options.storage.budget,
    rawOutputStore: options.storage.contextArtifacts,
    terminalOutputSanitizer: sanitizeTerminalOutput,
    securityToolNames: activeToolRegistry.names(),
    ...(options.toolCallingDebugWriter === undefined
      ? {}
      : { debug: { emit: options.toolCallingDebugWriter } }),
  });
  const toolCoordinator = new ToolBatchCoordinator(dispatcher);
  const scopes = new RunExecutionScopeRegistry();
  const deadlineRegistry = new RunDeadlineRegistry({ clock });
  const retryRegistry = new RunRetryRegistry({ clock });
  const defaultResolver = {
    resolve: async () => ({
      baseSystemPrompt: DEFAULT_BASE_SYSTEM_PROMPT,
      contextLimits: DEFAULT_CONTEXT_LIMITS,
    }),
  } satisfies RunExecutionConfigResolver;
  const baseResolver: RunExecutionConfigResolver = options.configResolver ?? defaultResolver;
  const historyContext = new SessionConversationContextProvider({ runs: options.storage.runs });
  const executionConfigResolver = {
    resolve: async (run) => {
      const config = await baseResolver.resolve(run);
      if (config.historyPrefix !== undefined) return config;
      return { ...config, historyPrefix: await historyContext.getHistoryPrefix(run) };
    },
  } satisfies RunExecutionConfigResolver;
  const verificationExecution = createRunBoundVerificationExecution(runtime, options.storage.runs);
  const verificationWorkspace = createRunBoundVerificationWorkspace(runtime);
  const verificationGit = createRunBoundVerificationGit(runtime);
  const controller = new RunController({
    agentLoop,
    contextRuntime,
    execution: options.storage.execution,
    events: options.eventBus,
    configResolver: executionConfigResolver,
    toolCoordinator,
    clock,
    eventIdFactory: { create: createEventId },
    approvals: options.storage.approvals,
    scopes,
    deadlineRegistry,
    retryRegistry,
    resources: { cancelOwnedResources: (runId) => runtime.cancelOwnedResources(runId) },
    budget: options.storage.budget,
    resourceGovernance: options.storage.resourceGovernance,
    verificationPlanner: new DefaultVerificationPlanner(),
    verificationPlanIdFactory: { create: createVerificationPlanId },
    verificationCheckIdFactory: { create: createVerificationCheckId },
    verificationRunner: new VerificationRunner(),
    projectProfileProvider: createProjectProfileProvider(inspector),
    verificationExecution,
    verificationExecutionStore: options.storage.verificationExecution,
    verificationExecutionRecovery: options.storage.verificationExecution,
    verificationWorkspace,
    verificationGit,
    verificationSecurity: verificationCommandSecurityPort,
    verificationEvidenceSanitizer,
    verificationEvidenceIdFactory: createVerificationEvidenceId,
    verificationResolverRegistry: new ProjectCheckResolverRegistry(),
    verificationModelTurns: modelTurns,
    verificationRepairPolicy: createVerificationRepairPolicy(),
    verificationPlanCount: (runId) =>
      options.storage.verificationExecution.countPlans?.(runId) ?? Promise.resolve(0),
    onVerifiedCompletion: ({ run }) => {
      void options.storage.memoryExtractionJobs
        .createOrGet({
          id: createEventId(),
          sourceRunId: run.id,
          projectId: run.workspace.id,
          createdAt: clock.now(),
        })
        .catch(() => undefined);
    },
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
    },
    runtimeKinds: ["local"],
    configuredProviders: ai.providers.list().map((provider) => provider.id),
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    defaultRunConfiguration: DEFAULT_RUN_CONFIGURATION,
  });

  let disposed = false;
  return {
    eventBus: options.eventBus,
    runs: options.storage.runs,
    runtime,
    runtimeResolver,
    ai,
    modelTurns,
    toolRegistry: activeToolRegistry,
    toolCoordinator,
    contextRuntime,
    contextUsage: {
      getContextUsage: async (runId) => {
        const current = contextRuntime.getContextUsage(runId);
        if (current !== undefined) return current;
        const persisted = await options.storage.contextRuntimeStates.getByRun(runId);
        if (persisted !== undefined) return createContextUsageProjection(persisted);
        return undefined;
      },
    },
    controller,
    supervisor,
    approvals: options.storage.approvals,
    modelCanonicalizer,
    info,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.all(supervisor.activeRunIds().map((runId) => controller.cancel(runId)));
      await supervisor.dispose();
      controller.dispose();
      deadlineRegistry.dispose();
      retryRegistry.dispose();
      await runtime.dispose();
    },
  };
}

function projectMemoryRecords(
  records: readonly MemoryRecord[],
  maxTokens: number,
  estimator: Utf8HeuristicTokenEstimator,
): readonly import("@caelush/context").ContextItem[] {
  const items: import("@caelush/context").ContextItem[] = [];
  let usedTokens = 0;
  for (const record of records) {
    if (record.sensitivity === "SENSITIVE") continue;
    const content = `${record.topic}: ${record.fact}`;
    const tokenEstimate = estimator.estimateText(content);
    if (usedTokens + tokenEstimate > maxTokens) continue;
    items.push(
      createContextItem({
        id: record.id,
        type: "MEMORY",
        sourceRef: record.id,
        scope: "PROJECT",
        retention: "RETRIEVABLE",
        priorityClass: "NORMAL",
        tokenEstimate,
        cacheStability: "STABLE",
        freshness: "CURRENT",
        sensitivity: record.sensitivity,
        whyLoaded: "project goal match",
        createdSequence: 0,
        updatedSequence: 0,
        content,
      }),
    );
    usedTokens += tokenEstimate;
  }
  return items;
}

function createRunBoundVerificationExecution(
  runtime: LocalRuntime,
  runs: Pick<CaelushStorage["runs"], "get">,
): VerificationCommandExecutionPort {
  return {
    async executeArgv(input: Parameters<RuntimeWorkspaceScope["exec"]["executeArgv"]>[0]) {
      const run = await runs.get(input.ownerRunId);
      if (run === null) throw new Error("verification Run is unavailable");
      const scope = await runtime.openWorkspace(run.workspace);
      return scope.exec.executeArgv(input);
    },
    async interact(input: Parameters<RuntimeWorkspaceScope["exec"]["interact"]>[0]) {
      const run = await runs.get(input.ownerRunId);
      if (run === null) throw new Error("verification Run is unavailable");
      const scope = await runtime.openWorkspace(run.workspace);
      return scope.exec.interact(input);
    },
  };
}

function createRunBoundVerificationWorkspace(runtime: LocalRuntime): WorkspaceVerificationPort {
  return {
    async inspect(input) {
      const scope = await runtime.openWorkspace(input.workspace);
      return createRuntimeWorkspaceVerificationPort(scope).inspect(input);
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
): AIGateway {
  if (diagnostic === undefined) return gateway;

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
        modelSettings: safeModelSettings(request),
      });
      return {
        callId: stream.callId,
        events: observeEvents(stream.events, stream.callId, request, startedAt, diagnostic),
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

/** Numbers only. A settings object can never carry a credential. */
function safeModelSettings(request: AIModelRequest): Record<string, string | number> {
  const settings: Record<string, string | number> = {};
  if (request.settings?.maxOutputTokens !== undefined) {
    settings["maxOutputTokens"] = request.settings.maxOutputTokens;
  }
  if (request.settings?.temperature !== undefined)
    settings["temperature"] = request.settings.temperature;
  if (request.toolChoice !== undefined) settings["toolChoice"] = request.toolChoice.type;
  return settings;
}
