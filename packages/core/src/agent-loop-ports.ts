import type {
  BuiltModelContext,
  ContextBuildInput,
  ContextUsageProjection,
  ProjectInspectorInput,
  ProjectIntelligenceSnapshot,
  RelevantFileContextPlan,
  RelevantFilePlannerInput,
  ContextRuntimeCoordinatorPort,
} from "@caelush/context";
import type { AIModelRequest, ModelCatalog } from "@caelush/ai";
import type {
  AgentExecutionIdentity,
  ContextEnginePort,
  ModelRequestAdmissionPort,
  ModelTurnBoundaryPort,
  ModelTurnStreamSink,
} from "@caelush/agent";
import type { LegacyModelTurnExecutor } from "./legacy-model-turn-executor.js";
import type { AgentLoopCommonInput } from "./agent-loop-input.js";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  ModelRef,
  StepId,
  TimestampMs,
} from "@caelush/protocol";

/**
 * How far a provider turn got.
 *
 * This is a Core observation, not a frozen kernel contract. The frozen `advance()` result
 * reports a decision, a failure or a cancellation, and deliberately says nothing about the
 * provider attempt behind it: the caller composes the `ModelTurnExecutor` and therefore is
 * the only party that knows whether the provider was contacted and how it answered. `stage`
 * and `providerTurnState` live here for exactly that reason.
 */
export type AgentProviderTurnState = "NOT_STARTED" | "COMPLETED" | "FAILED" | "CANCELLED";

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

/**
 * The legacy Context runtime seam.
 *
 * `getContextUsage` is optional and stays Core-private: it is the legacy runtime's own
 * account of the context it just built — the effective input limit, the pressure state and
 * the compaction count — which the compatibility adapter projects into the frozen
 * `ContextBuildReport`. It is deliberately not part of any `@caelush/agent` contract, and a
 * host that supplies only a builder simply does not have it.
 */
export type AgentContextRuntimePort = ContextRuntimeCoordinatorPort & {
  getContextUsage?(runId: string): ContextUsageProjection | undefined;
};

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

/**
 * Builds the frozen Context Engine for one turn.
 *
 * The frozen boundary has no `baseSystemPrompt`, `contextLimits`, `cwd` or `explicitPaths`:
 * those are legacy Context configuration, and a general kernel must not carry them. The Core
 * facade therefore assembles the legacy adapter per turn, from the turn's own input, and hands
 * the port down.
 */
export interface AgentContextEngineFactoryPort {
  (input: AgentLoopCommonInput): ContextEnginePort;
}

export interface AgentLoopDependencies {
  readonly inspector: AgentProjectInspectorPort;
  readonly planner: AgentRelevantFilePlannerPort;
  readonly contextBuilder: AgentContextBuilderPort;
  readonly contextRuntime?: AgentContextRuntimePort;
  /**
   * The frozen Context Engine seam.
   *
   * Phase 3B routes every Reason through `@caelush/agent`'s `AgentLoop.advance()`, which
   * requires a `ContextEnginePort`. The factory is where the Core boundary builds the legacy
   * adapter from the turn's own configuration, so the general loop never sees a base prompt, a
   * context limit or a working directory.
   */
  readonly createContextEngine?: AgentContextEngineFactoryPort;
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
   * transitional throw-based facade over it. Phase 3B drives it from inside the frozen
   * `AgentLoop.advance()`, which resolves a union; the facade unwraps that union here.
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
  /**
   * The frozen model admission port.
   *
   * A refusal is a typed decision now, not an exception, so a blocked turn never reaches the
   * boundary or the provider and the Run Layer settles it from the reported budget block.
   */
  readonly modelAdmission?: ModelRequestAdmissionPort;
  /**
   * The frozen durable model turn boundary.
   *
   * When omitted, the facade derives it from `lifecycle.beforeProviderTurn`, which the
   * RunController implements as the atomic commit of the running Step, its `currentStepId`,
   * any consumed continuation and `llm.started`.
   */
  readonly modelTurnBoundary?: ModelTurnBoundaryPort;
  /**
   * The transient presentation sink for one Run.
   *
   * Streaming is not an input of the frozen `AgentLoop.advance()`: the frozen contract has no
   * `streamSink` field, and the composition root binds live deltas by decorating the executor
   * it hands to the loop. This is that binding — the facade forwards the sink into every
   * `ModelTurnExecutionInput` it builds, so presentation stays a `ModelTurnExecutor` concern
   * and `advance()` receives no presentation input at all.
   */
  readonly streamSink?: ModelTurnStreamSink;
  readonly lifecycle?: AgentLoopLifecycleHooks;
}
