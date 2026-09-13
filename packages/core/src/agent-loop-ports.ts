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
import type { AgentExecutionIdentity } from "@caelush/agent";
import type { LegacyModelTurnExecutor } from "./legacy-model-turn-executor.js";
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

/**
 * Publishes the Run identity a model turn executes for.
 *
 * Phase 3A made `AgentExecutionIdentity` an explicit input of the frozen model turn
 * executor, because the durable model turn boundary commits against a Run and a Session.
 * The Run Layer owns that identity and hands it to the loop, which never invents one. This
 * port disappears with the loop itself: `AgentLoop.advance()` receives the identity in its
 * input.
 */
export interface AgentTurnIdentityResolverPort {
  (run: Pick<AgentRun, "id" | "sessionId" | "goal">): AgentExecutionIdentity;
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
   * The loop never sees a gateway, a provider registry or a model provider: it hands one
   * `AIModelRequest` to the executor and receives one `AIModelTurnResult`.
   *
   * Phase 3A aligned the agent executor with the frozen union result, so this seam is the
   * transitional throwing facade over it. It becomes the frozen port itself when the Core
   * loop is replaced in Phase 3B.
   */
  readonly modelTurns: LegacyModelTurnExecutor;
  readonly clock: AgentClock;
  readonly stepIdFactory: AgentStepIdFactory;
  /**
   * Publishes the identity a model turn executes for, before the turn is dispatched.
   *
   * Optional so a test can drive the loop without Run identity plumbing, and it must be
   * supplied in production because the frozen boundary port commits against it.
   */
  readonly resolveTurnIdentity?: AgentTurnIdentityResolverPort;
  readonly lifecycle?: AgentLoopLifecycleHooks;
}
