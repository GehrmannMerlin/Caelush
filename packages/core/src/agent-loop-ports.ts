import type {
  BuiltModelContext,
  ContextBuildInput,
  ProjectInspectorInput,
  ProjectIntelligenceSnapshot,
  RelevantFileContextPlan,
  RelevantFilePlannerInput,
  ContextRuntimeCoordinatorPort,
} from "@caelush/context";
import type { AIModelRequest, ModelCatalog } from "@caelush/ai";
import type { ModelTurnExecutor } from "@caelush/agent";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  ModelRef,
  StepId,
  TimestampMs,
} from "@caelush/protocol";

export type AgentProviderTurnState = "NOT_STARTED" | "FAILED" | "COMPLETED" | "CANCELLED";

export interface AgentBeforeProviderTurn {
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly step: AgentStep;
  readonly model: ModelRef;
}

export interface AgentBeforeProviderAdmission {
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly step: AgentStep;
  readonly model: ModelRef;
  readonly request: AIModelRequest;
}

export interface AgentLoopLifecycleHooks {
  beforeProviderAdmission?(input: AgentBeforeProviderAdmission): Promise<AIModelRequest | void>;
  beforeProviderTurn(input: AgentBeforeProviderTurn): Promise<void>;
}

export interface AgentProjectInspectorPort {
  inspect(input: ProjectInspectorInput): Promise<ProjectIntelligenceSnapshot>;
}

export interface AgentRelevantFilePlannerPort {
  plan(input: RelevantFilePlannerInput): Promise<RelevantFileContextPlan>;
}

export interface AgentContextBuilderPort {
  build(input: ContextBuildInput): BuiltModelContext;
}

export type AgentContextRuntimePort = ContextRuntimeCoordinatorPort;

export interface AgentClock {
  now(): TimestampMs;
}

export interface AgentStepIdFactory {
  create(): StepId;
}

export interface AgentLoopDependencies {
  readonly inspector: AgentProjectInspectorPort;
  readonly planner: AgentRelevantFilePlannerPort;
  readonly contextBuilder: AgentContextBuilderPort;
  readonly contextRuntime?: AgentContextRuntimePort;
  /**
   * The model metadata authority.
   *
   * The loop resolves the run's `ModelRef` through this catalog and hands the
   * resulting `ModelDescriptor` to the context runtime and the request builder, so
   * the same immutable descriptor generation backs both.
   */
  readonly models: ModelCatalog;
  /**
   * The model execution authority.
   *
   * The loop never sees a gateway, a provider registry or a model provider: it hands
   * one `AIModelRequest` to the executor and receives one `AIModelTurnResult`.
   */
  readonly modelTurns: ModelTurnExecutor;
  readonly clock: AgentClock;
  readonly stepIdFactory: AgentStepIdFactory;
  readonly lifecycle?: AgentLoopLifecycleHooks;
}
