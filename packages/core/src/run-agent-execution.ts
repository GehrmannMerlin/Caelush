import {
  createAgentLoop,
  createRunningAgentStep,
  nextAgentStepSequence,
  toAIModelSettings,
  type AgentDecisionClassifier,
  type AgentExecutionIdentity,
  type AgentLoop,
  type ContextEnginePort,
  type ModelRequestAdmissionPort,
  type ModelTurnBoundaryPort,
  type ModelTurnExecutor,
} from "@caelush/agent";
import type { AIModelSettings, AIToolSpec, ModelCatalog } from "@caelush/ai";
import type { ContextBuildLimits, VerificationRepairContextInput } from "@caelush/context";
import type { AIMessage } from "@caelush/ai";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  RunId,
  StepId,
  TimestampMs,
} from "@caelush/protocol";

import type { AgentStepIdFactory } from "./agent-loop-ports.js";
import type { AgentLoopModelSettings } from "./agent-loop-input.js";
import { toAIToolSpec } from "./ai-invocation-projection.js";

/**
 * The Run Layer's direct Agent execution dependencies.
 *
 * ```text
 * RunController  →  createAgentLoop(...)  →  createRunExecutionDriver(...)
 * ```
 *
 * Phase 3C checkpoint 6 removed the legacy Core `AgentLoop` facade from the production Agent path.
 * The Run Layer no longer receives an object that owns a Step lifecycle, a `maxSteps` gate and a
 * legacy execution epoch: it receives exactly the collaborator ports the frozen kernel declares,
 * composes them itself, and drives them through the frozen `RunExecutionDriver`.
 *
 * What the Run Layer is handed, and why each entry is irreducible:
 *
 * ```text
 * models              the descriptor authority; the run's ModelRef is resolved once, here
 * modelTurnExecutor   one provider turn; admission and the durable boundary are the layer's own
 * stepIds             the Step identity factory, so the Run Layer names the Step it persists
 * createContextEngine the Context Engine for one turn, assembled at the host boundary
 * ```
 *
 * Deliberately absent: an `AgentLoop`, an `AgentLoopDependencies`, a `maxSteps` gate, a legacy
 * execution epoch and a legacy `AgentLoopExecutionResult`. A host that supplied any of them could
 * decide a Step sequence or a Reason entry point that the Run Layer is the authority for.
 */
export interface RunAgentExecutionDependencies {
  readonly models: ModelCatalog;

  readonly modelTurnExecutor: ModelTurnExecutor;

  /**
   * The Step identity factory.
   *
   * The Run Layer allocates `AgentStep.id` through this and never through a raw UUID, a timestamp
   * or a Tool/model call identity: one model turn is one durable `AgentStep`, and the layer that
   * persists it is the layer that may name it.
   */
  readonly stepIds: AgentStepIdFactory;

  /**
   * Build the Context Engine for one turn.
   *
   * The frozen `ContextEnginePort` carries no base prompt, no context limits, no working directory
   * and no verification-repair text — those are legacy Context configuration, and a general kernel
   * must not know them. The host composes the adapter; the Run Layer only ever holds the port.
   */
  createContextEngine(input: RunAgentContextEngineInput): ContextEnginePort;
}

/** What one turn's Context Engine is assembled from. */
export interface RunAgentContextEngineInput {
  readonly run: AgentRun;
  readonly identity: AgentExecutionIdentity;
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  readonly cwd?: string | undefined;
  readonly explicitPaths?: readonly string[] | undefined;
  readonly verificationRepairContext?: VerificationRepairContextInput | undefined;
}

/**
 * The resolved execution dependencies of one Run.
 *
 * This is what the `RunController` closes over. The host's factory resolves the Run's configuration
 * first, so the generic controller never learns what a base system prompt, a context limit, an
 * explicit path or a `historyPrefix` is — it only ever sees a frozen `ContextEnginePort`, a
 * resolved `ModelDescriptor`, an `AIToolSpec[]` and an `AIModelSettings` object.
 */
export interface RunAgentExecutionContext {
  readonly models: ModelCatalog;
  readonly modelTurnExecutor: ModelTurnExecutor;
  readonly stepIds: AgentStepIdFactory;
  /** The model-visible Tool catalog. Data only; the Tool Layer owns execution. */
  readonly tools: readonly AIToolSpec[];
  readonly modelSettings?: AIModelSettings | undefined;
  /** Synthetic conversation the host prepends. Never durable, never an append. */
  /** Synthetic conversation the host prepends, already projected onto the frozen AI contract. */
  readonly historyPrefix?: readonly AIMessage[] | undefined;
  readonly createContextEngine: (
    run: AgentRun,
    verificationRepairContext?: VerificationRepairContextInput,
  ) => ContextEnginePort;
}

/** The host-side factory the composition root supplies. */
export interface RunAgentExecutionContextFactory {
  resolve(run: AgentRun): Promise<RunAgentExecutionContext>;
}

/** The resolved configuration one Run's Agent execution is composed from. */
export interface RunAgentExecutionConfiguration {
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  readonly tools: readonly import("@caelush/protocol").ToolDefinition[];
  readonly modelSettings?: AgentLoopModelSettings | undefined;
  /** Synthetic conversation the host prepends, already projected onto the frozen AI contract. */
  readonly historyPrefix?: readonly AIMessage[] | undefined;
  readonly cwd?: string | undefined;
  readonly explicitPaths?: readonly string[] | undefined;
}

/** Where a host wires the configuration and ports the resolved context is projected from. */
export interface RunAgentExecutionContextFactoryDependencies {
  readonly config: RunAgentExecutionConfiguration;
  readonly models: ModelCatalog;
  readonly modelTurnExecutor: ModelTurnExecutor;
  readonly stepIds: AgentStepIdFactory;
  createContextEngine(input: RunAgentContextEngineInput): ContextEnginePort;
}

/**
 * The ports the Run Layer composes for one turn.
 *
 * The three are the frozen kernel's own: an admission decision, the durable boundary that must
 * commit before provider I/O, and the provider turn itself. The Run Layer builds them per effect,
 * because each of them is bound to the exact turn the effect runs as.
 */
export interface RunAgentTurnPorts {
  readonly modelTurnExecutor: ModelTurnExecutor;
  readonly modelAdmission?: ModelRequestAdmissionPort | undefined;
  readonly modelTurnBoundary?: ModelTurnBoundaryPort | undefined;
}

/** Create the host-side projection of one Run's direct Agent execution dependencies. */
export function createRunAgentExecutionContext(
  dependencies: RunAgentExecutionContextFactoryDependencies,
): RunAgentExecutionContext {
  const { config } = dependencies;
  return {
    models: dependencies.models,
    modelTurnExecutor: dependencies.modelTurnExecutor,
    stepIds: dependencies.stepIds,
    tools: config.tools.map(toAIToolSpec),
    ...(config.modelSettings === undefined
      ? {}
      : { modelSettings: toAIModelSettings(config.modelSettings) }),
    ...(config.historyPrefix === undefined ? {} : { historyPrefix: config.historyPrefix }),
    createContextEngine: (run, verificationRepairContext) =>
      dependencies.createContextEngine({
        run,
        identity: { runId: run.id, sessionId: run.sessionId, goal: run.goal },
        baseSystemPrompt: config.baseSystemPrompt,
        contextLimits: config.contextLimits,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.explicitPaths === undefined ? {} : { explicitPaths: config.explicitPaths }),
        ...(verificationRepairContext === undefined ? {} : { verificationRepairContext }),
      }),
  };
}

/**
 * Compose the frozen AgentLoop the Run Layer drives one effect through.
 *
 * This is the only `createAgentLoop(...)` call site in the production Agent path, and it composes
 * the four frozen ports directly: a `ContextEnginePort`, a `ModelTurnExecutor`, the composition
 * root's `AgentDecisionClassifier` and the two Run-Layer-owned turn ports. A general kernel has no
 * default classifier and no default boundary, so neither can be omitted silently here.
 */
export function createRunAgentLoop(
  contextEngine: ContextEnginePort,
  classifier: AgentDecisionClassifier,
  ports: RunAgentTurnPorts,
): AgentLoop {
  return createAgentLoop({
    contextEngine,
    modelTurnExecutor: ports.modelTurnExecutor,
    decisionClassifier: classifier,
    ...(ports.modelAdmission === undefined ? {} : { modelAdmission: ports.modelAdmission }),
    ...(ports.modelTurnBoundary === undefined
      ? {}
      : { modelTurnBoundary: ports.modelTurnBoundary }),
  });
}

/**
 * Allocate the durable Step one model turn will be opened as.
 *
 * ```text
 * Run Layer creates the Step object
 *        ↓ the Step is NOT durable yet
 * Context prepare → admission → ModelTurnBoundary
 *        ↓ the Step becomes durable
 * ```
 *
 * The sequence comes from the canonical `nextAgentStepSequence`, never from a second
 * `state.usage.steps + 1` authority, and the start time is clamped to the state's own timestamp so
 * `startedAt >= AgentState.updatedAt` holds for the durable record.
 *
 * Nothing here writes. A context failure, a budget refusal or a cancellation before the boundary
 * therefore leaves zero durable Step rows, which is the whole point of allocating it in memory
 * first: a pending Step is an in-memory execution fact, not a new persisted state.
 */
export function allocateRunAgentStep(input: {
  readonly state: AgentState;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly now: TimestampMs;
}): AgentStep {
  return createRunningAgentStep({
    id: input.stepId,
    runId: input.runId,
    sequence: nextAgentStepSequence(input.state),
    startedAt: monotonicStepStart(input.state, input.now),
  });
}

/**
 * The one monotonic time rule of the Run Layer.
 *
 * `AgentState.updatedAt` never moves backwards, so a Step that started before it would produce a
 * durable record whose own invariant rejects it. The rule lives here, once, rather than being
 * copied into each caller that needs it.
 */
export function monotonicStepStart(state: AgentState, now: TimestampMs): TimestampMs {
  return Math.max(state.updatedAt, now) as TimestampMs;
}
