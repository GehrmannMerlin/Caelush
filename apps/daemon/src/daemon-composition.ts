import {
  RunController,
  RunDeadlineRegistry,
  RunExecutionScopeRegistry,
  RunRetryRegistry,
  createCodingCompletionAssembly,
  createLegacyContextRuntimeAdapter,
  createProjectProfileProvider,
  createRunAgentExecutionContext,
  createToolExecutionLedgerRawObservationResolver,
  toAIMessage,
  toContextObservationProjection,
  type RunAgentExecutionContextFactory,
  type VerificationModelClient,
  type RunExecutionConfigResolver,
  type ToolTurnPipeline,
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
  type ContextItem,
} from "@caelush/context";
import { MemoryRetriever, type MemoryRecord } from "@caelush/memory";
import { createAIError, createAISubsystem } from "@caelush/ai";
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
import type { AgentExecutionIdentity } from "@caelush/agent";
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
  type AgentRun,
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
  createToolExecutionDependencies,
  createCodingToolAdmissionPort,
  createCodingToolDurableMetadataPort,
  createDurableInvocationGatePort,
  filterToolRegistryForEnvironment,
  ToolRegistryBuilder,
  boundToolModelContent,
  type ToolCallingDebugEvent,
  type ToolExposureEnvironment,
  type ToolRegistration,
} from "@caelush/tools";
import {
  createDurableToolExecutionCoordinator,
  createModelToolFeedbackProjector,
  createToolAdmissionCoordinator,
  createToolBatchCoordinator,
  createToolCallPreparer,
  createToolFailureSettlement,
  createToolResultBatchNormalizer,
  type DurableToolExecutionCoordinator,
} from "@caelush/agent";
import { createLegacyNumericArgumentNormalization } from "@caelush/coding-agent";
import {
  createDefaultCodingTools,
  createRuntimeGitOperations,
  createRuntimePatchOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  createToolPromptContextProvider,
  GIT_TOOL_NAMES,
  type CodingToolDefinition,
  type DefaultCodingToolOperations,
} from "@caelush/coding-agent";
import {
  createDefaultV1ToolExecutionSecurity,
  createV1ToolApprovalRequestFactory,
  CaelushToolExecutionUpdateSanitizer,
  DISCARDING_TOOL_UPDATE_CONSUMER,
  verificationCommandSecurityPort,
  verificationEvidenceSanitizer,
} from "@caelush/security";
import { createSqliteToolBudgetAdmission, type CaelushStorage } from "@caelush/storage";

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

/**
 * Project durable invocation state back onto the canonical prepared call.
 *
 * Nothing is resolved, normalized or validated here. The canonical registry resolved the Tool at
 * registration, preparation validated the arguments before the `REQUESTED` row was written, and the
 * arguments come from the durable invocation itself. This is durable state projected onto the canonical
 * call type, not a second preparation path.
 */
function preparedCallFromDurableState(
  registry: ReturnType<typeof filterToolRegistryForEnvironment>,
  invocation: import("@caelush/protocol").ToolInvocation,
  externalCallId: string,
): import("@caelush/agent").PreparedToolCall {
  const resolved = registry.agentRegistry().resolve(invocation.toolName);
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
  /**
   * A registry the caller already built and validated, including its Coding catalog.
   *
   * A builder holds the derivation state — which Tool was registered where — that the Coding catalog
   * alignment needs, so a host that validated the overlay at startup hands the *same* builder here
   * rather than a bare registry. It is re-validated on this side, so the trust boundary does not move.
   */
  readonly toolRegistrations?: readonly (ToolRegistration | CodingToolDefinition)[] | undefined;
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
  readonly toolRegistry: ReturnType<ToolRegistryBuilder["build"]>;
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
  readonly contextRuntime: ContextRuntimeCoordinator;
  readonly contextUsage: {
    getContextUsage(
      runId: string,
    ): Promise<import("@caelush/context").ContextUsageProjection | undefined>;
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
  readonly info: DaemonInfo;
  dispose(): Promise<void>;
}

export async function composeDaemon(options: DaemonCompositionOptions): Promise<DaemonComposition> {
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
  const modelTurnExecutor = createModelTurnExecutor({ gateway });
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
      const result = await modelTurnExecutor.execute({
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
  const planner = createLocalRelevantFilePlanner();
  const contextBuilder = createDefaultContextBuilder();
  /**
   * The Phase 4E production Tool composition.
   *
   * ```text
   * RuntimeResolver
   *   → the four Runtime Operations adapters     @caelush/coding-agent
   *   → createDefaultCodingTools(...)            the nine Coding Tool definitions
   *   → ToolRegistryBuilder                      the canonical AgentToolRegistry
   * ```
   *
   * The default nine Tools now **originate in `@caelush/coding-agent`**. The legacy package's
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
  const defaultCodingTools = defaultCodingToolSet(defaultCodingOperations(runtimeResolver), {
    git: options.toolExposure?.git ?? "AVAILABLE",
  });
  const builtToolRegistry = new ToolRegistryBuilder();
  for (const registration of options.toolRegistrations ??
    (defaultCodingTools as readonly (ToolRegistration | CodingToolDefinition)[])) {
    builtToolRegistry.register(registration);
  }
  /**
   * The Coding Tool catalog for the Tools this host registered.
   *
   * `buildCodingCatalog()` is what refuses a *dangling* overlay — a catalog entry whose Tool the active
   * registry cannot execute — so building it before the registry is used is what keeps Coding metadata
   * and executable Tools describing one set. The returned catalog is retained because the composition
   * root is the layer that reads it: the durable `riskLevel` below comes from the catalog rather than
   * from a second derivation.
   */
  const codingCatalog = await builtToolRegistry.buildCodingCatalog();
  const activeToolRegistry = filterToolRegistryForEnvironment(
    builtToolRegistry.build(),
    options.toolExposure ?? { git: "AVAILABLE" },
  );
  /**
   * The Coding Tool prompt provider, composed once per daemon.
   *
   * ```text
   * the active registry's tools   →  their Coding promptSnippets  →  the budgeted Context build
   * ```
   *
   * Phase 4E moved usage guidance out of `AIToolSpec.description` and into Context. The provider is the
   * Coding product layer's, and this composition supplies the **active tool names in registry order** —
   * the order the registry, the model catalog and this guidance block all share.
   *
   * The adapter hands it the tools a turn actually exposes, and the intersection with the active
   * registry is taken here, so a Tool this host did not register (a Git Tool on a non-Git workspace)
   * can never describe itself to a model and the guidance block cannot name a Tool the model was not
   * offered.
   */
  const toolPromptProvider = createToolPromptContextProvider();
  const activeToolNames = activeToolRegistry.names();
  const toolGuidance: (
    turnToolNames: readonly string[],
  ) => Promise<readonly ContextItem[]> = async (turnToolNames) => {
    const offered = new Set<string>(turnToolNames);
    const items = await toolPromptProvider.provide({
      activeTools: activeToolNames.filter((name) => offered.has(name)),
    });
    return items.map((item) => toContextGuidanceItem(item, activeToolNames.length));
  };
  /**
   * The Phase 4C production Tool assembly.
   *
   * ```text
   * ToolAdmissionPort              Security/Coding admission adapter over the real gate
   * ToolDurableMetadataPort        the registry's risk level, for the durable invocation row
   * ToolApprovalRequestFactory     the real approval card, from redacted security facts
   * ToolBudgetAdmissionPort        the canonical view over the durable budget ledger
   * ToolExecutionStorePort         @caelush/storage, implementing the canonical port
   * DurableToolExecutionCoordinator   ← the Tool Invocation Lifecycle Authority
   * ToolDispatcher                 a compatibility facade, delegating to the coordinator
   * ```
   *
   * Every dependency below is a *construction* dependency of the coordinator, never a field of a frozen
   * request: the durable request carries identity, the prepared call, the environment, the security
   * context and a signal, and nothing else.
   *
   * The composition root is also where the three compatibility pieces that must not live in a canonical
   * layer are wired:
   *
   * ```text
   * the settlement extension decoder   storage decodes it; the Coding vocabulary is here
   * the approval request factory       the Agent layer never learns what a safeAction is
   * the effects projection             AgentState belongs to the host, not to the Tool layer
   * ```
   */
  const toolSecurity = createDefaultV1ToolExecutionSecurity({
    terminalOutputSanitizer: sanitizeTerminalOutput,
  });
  const toolExecutionDependencies = createToolExecutionDependencies({
    registry: activeToolRegistry,
    resultSanitizer: toolSecurity.resultSanitizer,
    updateSanitizer: new CaelushToolExecutionUpdateSanitizer(),
    transientUpdates: DISCARDING_TOOL_UPDATE_CONSUMER,
    // The durable event identity factory and the safe presenter, so a Tool effect's host-domain event
    // (`file.read`, `file.modified`, `process.started`) is drawn from the same sequence as the terminal
    // event it accompanies and carries the same safe presentation.
    eventIdFactory: { create: createEventId },
    presentation: toolSecurity.presentation,
  });
  const toolApprovalRequests = createV1ToolApprovalRequestFactory({
    registry: activeToolRegistry,
    gate: toolSecurity.gate,
    approvalIdFactory: { create: createApprovalRequestId },
  });
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
      definitions: activeToolRegistry.modelDefinitions(),
      approvalPresentation: (decision) => decision.safeAction,
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
        definitions: activeToolRegistry.modelDefinitions(),
        catalog: codingCatalog,
      }),
      approvalRequests: toolApprovalRequests,
      approvalLookup: options.storage.approvals,
      invocationIdFactory: { create: createToolInvocationId },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      clock,
      invocationExecutorFactory: toolExecutionDependencies.invocationExecutorFactory,
      updateSanitizer: toolExecutionDependencies.updateSanitizer,
      resultPipelineFactory: toolExecutionDependencies.resultPipelineFactory,
      preparedCallFactory: ({ invocation, externalCallId }) =>
        preparedCallFromDurableState(activeToolRegistry, invocation, externalCallId),
      failureSettlement: createToolFailureSettlement({
        store: options.storage.toolExecution,
        clock,
        observationIdFactory: { create: createObservationId },
        eventIdFactory: { create: createEventId },
        presentation: toolSecurity.presentation,
        boundContent: (content) =>
          boundToolModelContent(content, toolExecutionDependencies.outputPolicy),
        notifier: options.eventBus,
      }),
      budget: toolBudgetAdmission,
      presentation: toolSecurity.presentation,
      rawOutputStore: options.storage.contextArtifacts,
      notifier: options.eventBus,
      boundFailureContent: (content) =>
        boundToolModelContent(content, toolExecutionDependencies.outputPolicy),
    });
  /**
   * Phase 4D: the legacy `ToolDispatcher` is no longer composed here.
   *
   * ```text
   * BEFORE 4D   ToolDispatcher → legacy ToolBatchCoordinator → RunController
   * AFTER  4D   ToolCallPreparer + ToolBudgetAdmissionPort + DurableToolExecutionCoordinator
   *                     → canonical ToolBatchCoordinator → RunController
   * ```
   *
   * The dispatcher's only production consumer was the legacy batch coordinator. Phase 4D replaced that
   * with the canonical batch, which drives the same `toolDurableCoordinator` the facade was built
   * around, directly. A facade nothing production calls is dead weight rather than compatibility, so the
   * composition root does not build one.
   *
   * `@caelush/tools` keeps the Dispatcher class for its legacy direct API and for its own tests until
   * Phase 4F decides that surface's retirement. Nothing in this composition root depends on it.
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
   * reaches the Dispatcher: production scheduling, pre-invocation rejection and the uncertain barrier are
   * the Agent package's. The Dispatcher remains composed for the legacy direct API and for the Coding
   * builtin registrations, not as a production batch authority.
   */
  const toolPreparer = createToolCallPreparer(activeToolRegistry.agentRegistry(), {
    normalization: createLegacyNumericArgumentNormalization(),
  });
  const toolBatch = createToolBatchCoordinator({
    preparer: toolPreparer,
    budget: toolBudgetAdmission,
    durable: toolDurableCoordinator,
    registry: activeToolRegistry.agentRegistry(),
  });
  const toolTurn = {
    batches: toolBatch,
    // The one place the Agent package's model feedback semantics and the Context package's token
    // projection algorithm are joined. Architecture V2 forbids `agent -> context`, so the adapter lives
    // at the composition root that legitimately knows both.
    feedback: createModelToolFeedbackProjector({
      projection: toContextObservationProjection(),
    }),
    normalizer: createToolResultBatchNormalizer(),
    // The same registry the batch resolves and executes against: one catalog, never two.
    modelDefinitions: () => activeToolRegistry.modelDefinitions(),
  } satisfies ToolTurnPipeline;
  /**
   * Where a Tool result's raw output is resolved from, for the legacy Context adapter.
   *
   * A forced Context recovery re-projects the unbounded Tool output under a tighter policy, and the
   * frozen `AIToolResultMessage` deliberately has no field for the artifact pointer that finds it.
   * The Tool execution ledger already holds it, keyed by the same `(run, step, externalCallId)`
   * identity the invocation was executed under, so this is a lookup over durable data rather than a
   * second store — and it is what makes the recovery survive a restart.
   */
  const rawObservationRefs = createToolExecutionLedgerRawObservationResolver({
    store: options.storage.toolExecution,
  });
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
  const agentExecution: RunAgentExecutionContextFactory = {
    async resolve(run) {
      const config = await executionConfigResolver.resolve(run);
      return createRunAgentExecutionContext({
        config: {
          baseSystemPrompt: config.baseSystemPrompt,
          contextLimits: config.contextLimits,
          tools: activeToolRegistry.modelDefinitions(),
          ...(config.modelSettings === undefined ? {} : { modelSettings: config.modelSettings }),
          // The synthetic session prefix still arrives in the durable legacy encoding, so it is
          // projected onto the frozen AI contract here — at the composition root, which is the only
          // place that knows both sides. The Run Layer only ever sees `AIMessage`.
          ...(config.historyPrefix === undefined
            ? {}
            : { historyPrefix: config.historyPrefix.map(toAIMessage) }),
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          ...(config.explicitPaths === undefined ? {} : { explicitPaths: config.explicitPaths }),
        },
        models: ai.models,
        modelTurnExecutor,
        stepIds: { create: createStepId },
        // The frozen Context Engine seam. The legacy Context System is configured per turn — base
        // prompt, limits, cwd, explicit paths — so the host builds its adapter from the turn's own
        // input, and the general loop never sees any of it. The adapter takes no model catalog: the
        // descriptor the loop resolved is the one context build authority for the turn.
        createContextEngine: (input) =>
          createLegacyContextRuntimeAdapter({
            inspector,
            planner,
            contextBuilder,
            contextRuntime,
            baseSystemPrompt: input.baseSystemPrompt,
            contextLimits: input.contextLimits,
            workspace: input.run.workspace,
            runId: input.run.id,
            rawObservationRefs,
            toolGuidance,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(input.explicitPaths === undefined ? {} : { explicitPaths: input.explicitPaths }),
            ...(input.verificationRepairContext === undefined
              ? {}
              : {
                  verificationRepairContext: () => Promise.resolve(input.verificationRepairContext),
                }),
          }),
      });
    },
  };
  const verificationExecution = createRunBoundVerificationExecution(runtime, options.storage.runs);
  const verificationWorkspace = createRunBoundVerificationWorkspace(runtime);
  const verificationGit = createRunBoundVerificationGit(runtime);
  const controller = new RunController({
    agentExecution,
    contextRuntime,
    executionStore: options.storage.execution,
    completionStore: options.storage.execution,
    events: options.eventBus,
    configResolver: executionConfigResolver,
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
      resolverRegistry: new ProjectCheckResolverRegistry(),
      modelTurns: verificationModelTurns,
      budget: options.storage.budget,
      repairPolicy: createVerificationRepairPolicy(),
      planCount: (runId) =>
        options.storage.verificationExecution.countPlans?.(runId) ?? Promise.resolve(0),
    }),
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
    modelTurnExecutor,
    verificationModelTurns,
    toolRegistry: activeToolRegistry,
    toolTurn,
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
    resolveTurnIdentity,
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

/**
 * The four Runtime Operations adapters, as the one bundle `createDefaultCodingTools` expects.
 *
 * This is the only place in the daemon that constructs them, and it is the only place that holds a
 * `RuntimeResolver` for a Coding Tool: the Tools themselves receive narrow ports, so a `read_file`
 * implementation cannot reach `git` and a `git_status` implementation cannot reach the filesystem.
 */
function defaultCodingOperations(
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

/**
 * The default Coding Tool set for a known environment.
 *
 * Git exposure fails closed: `UNKNOWN` is treated exactly like `UNAVAILABLE`, because a host that
 * cannot prove Git works must not offer a model a Tool that will fail. Dropping the two Git
 * *definitions* — rather than filtering a built registry — is what keeps the registry, the Coding
 * catalog, the model-visible specs and the prompt guidance block describing the same active set.
 */
function defaultCodingToolSet(
  operations: DefaultCodingToolOperations,
  environment: ToolExposureEnvironment,
): readonly CodingToolDefinition[] {
  const definitions = createDefaultCodingTools(operations);
  if (environment.git === "AVAILABLE") return definitions;
  const excluded = new Set<string>(GIT_TOOL_NAMES);
  return Object.freeze(definitions.filter((definition) => !excluded.has(definition.tool.name)));
}

/**
 * The Coding Tool prompt provider, as the legacy Context build reads it.
 *
 * ```text
 * the provider's ContextItem   { id, priorityClass, content, tokenEstimate, whyLoaded }
 *        ↓  this projection
 * the Context package's item   { id, type: "TOOL_GUIDANCE", …, content, tokenEstimate }
 * ```
 *
 * Two packages declare a `ContextItem`: `@caelush/agent` states the minimal text item a Context
 * *provider* contributes, and `@caelush/context` states the typed item its budgeted build stores. The
 * composition root is the only layer that knows both, so the projection is made here.
 *
 * `type` is `TOOL_GUIDANCE` rather than `MEMORY`, because the renderer labels the block from it and
 * guidance is not retrieved knowledge. `sensitivity` is `PUBLIC`: a Coding prompt snippet is a constant
 * compiled into a Tool definition — it carries no workspace path, no secret and no live value — and
 * marking it otherwise would make the renderer drop it.
 */
function toContextGuidanceItem(
  item: import("@caelush/agent").ContextItem,
  activeToolCount: number,
): ContextItem {
  const tokenEstimate =
    item.tokenEstimate ?? Math.ceil(Buffer.byteLength(item.content, "utf8") / 3);
  return createContextItem({
    id: item.id,
    type: "TOOL_GUIDANCE",
    sourceRef: "coding.tool_prompt",
    scope: "RUN",
    retention: "EPHEMERAL",
    priorityClass: item.priorityClass === "OPTIONAL" ? "LOW" : item.priorityClass,
    tokenEstimate,
    cacheStability: "STABLE",
    freshness: "CURRENT",
    sensitivity: "PUBLIC",
    whyLoaded:
      item.whyLoaded ?? `Tool guidance for ${String(activeToolCount)} active Coding tool(s).`,
    createdSequence: 0,
    updatedSequence: 0,
    content: item.content,
  });
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
