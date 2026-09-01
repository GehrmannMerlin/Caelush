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
  createDefaultContextBuilder,
  createLocalProjectInspector,
  createLocalRelevantFilePlanner,
} from "@caelush/context";
import {
  LLMGateway,
  LLMProviderRegistry,
  ProviderIdSchema,
  createOpenAICompatibleLLMProvider,
  type LLMProvider,
} from "@caelush/llm";
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
  ToolBatchCoordinator,
  ToolRegistryBuilder,
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
  ConfiguredModelCanonicalizer,
  type DaemonModelCanonicalizer,
  type DaemonModelProviderConfig,
} from "./providers/model-canonicalizer.js";
import {
  RunExecutionSupervisor,
  type RunExecutionSupervisorLogger,
} from "./execution/run-execution-supervisor.js";
import { SessionConversationContextProvider } from "./services/session-conversation-context.js";

const DEFAULT_BASE_SYSTEM_PROMPT =
  "You are Caelush, a careful workspace agent. Inspect the project, make only requested changes, and report what you verified.";

const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  maxInputTokens: 32_000,
  safetyMarginTokens: 512,
  maxConversationTokens: 12_000,
  maxRelevantFileTokens: 12_000,
  minRelevantFileTokens: 128,
});

const DEFAULT_RUN_CONFIGURATION = Object.freeze({
  runtime: Object.freeze({ id: "local", kind: "local" }),
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: Object.freeze({ maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 }),
}) satisfies DefaultRunConfiguration;

export interface DaemonClock {
  now(): TimestampMs;
}

export interface DaemonCompositionOptions {
  readonly storage: CaelushStorage;
  readonly eventBus: EventBus;
  readonly providers?: readonly DaemonModelProviderConfig[];
  readonly defaultModel?: ClientModelSelection;
  readonly providerOverrides?: readonly LLMProvider[];
  readonly runtime?: LocalRuntime;
  readonly clock?: DaemonClock;
  readonly logger?: RunExecutionSupervisorLogger;
  readonly configResolver?: RunExecutionConfigResolver;
}

export interface DaemonComposition {
  readonly eventBus: EventBus;
  readonly runs: Pick<CaelushStorage["runs"], "get">;
  readonly runtime: LocalRuntime;
  readonly runtimeResolver: ReturnType<typeof createLocalRuntimeResolver>;
  readonly providerRegistry: LLMProviderRegistry;
  readonly gateway: LLMGateway;
  readonly toolRegistry: ReturnType<ToolRegistryBuilder["build"]>;
  readonly toolCoordinator: ToolBatchCoordinator;
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
  const providerRegistry = new LLMProviderRegistry();
  for (const config of providers) {
    providerRegistry.register(
      createOpenAICompatibleLLMProvider({
        id: ProviderIdSchema.parse(config.provider),
        baseURL: config.baseUrl,
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(config.queryParams === undefined ? {} : { queryParams: config.queryParams }),
        ...(config.allowedModels === undefined ? {} : { allowedModels: config.allowedModels }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      }),
    );
  }
  for (const provider of options.providerOverrides ?? []) providerRegistry.register(provider);
  const gateway = new LLMGateway({ providers: providerRegistry });
  const llmClient = {
    complete: (
      request: Parameters<LLMGateway["complete"]>[0],
      callOptions: { signal: AbortSignal },
    ) => gateway.complete(request, callOptions),
  };

  const inspector = createLocalProjectInspector();
  const agentLoop = new AgentLoop({
    inspector,
    planner: createLocalRelevantFilePlanner(),
    contextBuilder: createDefaultContextBuilder(),
    llmClient,
    clock,
    stepIdFactory: { create: createStepId },
  });
  const builtToolRegistry = new ToolRegistryBuilder();
  for (const registration of createDefaultBuiltinToolRegistrations(runtimeResolver)) {
    builtToolRegistry.register(registration);
  }
  const activeToolRegistry = builtToolRegistry.build();
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
    terminalOutputSanitizer: sanitizeTerminalOutput,
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
    verificationLLMClient: llmClient,
    verificationRepairPolicy: createVerificationRepairPolicy(),
    verificationPlanCount: (runId) =>
      options.storage.verificationExecution.countPlans?.(runId) ?? Promise.resolve(0),
  });
  const supervisor = new RunExecutionSupervisor({
    runs: options.storage.runs,
    controller,
    approvals: options.storage.approvals,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const modelCanonicalizer = new ConfiguredModelCanonicalizer(providers);
  const info = DaemonInfoSchema.parse({
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "0.1.0",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: providerRegistry.listProviderIds(),
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    defaultRunConfiguration: DEFAULT_RUN_CONFIGURATION,
  });

  let disposed = false;
  return {
    eventBus: options.eventBus,
    runs: options.storage.runs,
    runtime,
    runtimeResolver,
    providerRegistry,
    gateway,
    toolRegistry: activeToolRegistry,
    toolCoordinator,
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
