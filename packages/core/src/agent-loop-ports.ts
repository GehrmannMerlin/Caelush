import type {
  BuiltModelContext,
  ContextBuildInput,
  ProjectInspectorInput,
  ProjectIntelligenceSnapshot,
  RelevantFileContextPlan,
  RelevantFilePlannerInput,
} from "@caelush/context";
import type { LLMRequest } from "@caelush/llm/request";
import type { LLMTurnResult } from "@caelush/llm/turn";
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

export interface AgentLoopLifecycleHooks {
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

export interface AgentLLMClient {
  complete(request: LLMRequest, options: { readonly signal: AbortSignal }): Promise<LLMTurnResult>;
}

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
  readonly llmClient: AgentLLMClient;
  readonly clock: AgentClock;
  readonly stepIdFactory: AgentStepIdFactory;
  readonly lifecycle?: AgentLoopLifecycleHooks;
}
