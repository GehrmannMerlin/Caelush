import type { AgentLoopModelSettings } from "./agent-loop-input.js";
import type { AgentLoop } from "./agent-loop.js";
import type { ContextBuildLimits } from "@caelush/context";
import type { AgentRun, EventId, ToolDefinition } from "@caelush/protocol";
import type { DurableAgentEvent, RunExecutionStorePort } from "./run-execution-store.js";

export interface RunExecutionConfig {
  readonly baseSystemPrompt: string;
  readonly contextLimits: ContextBuildLimits;
  readonly tools?: readonly ToolDefinition[];
  readonly modelSettings?: AgentLoopModelSettings;
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
}

export interface RunExecutionConfigResolver {
  resolve(run: AgentRun): Promise<RunExecutionConfig>;
}

export interface RunEventNotifier {
  notifyCommitted(events: readonly DurableAgentEvent[]): void;
}

export interface EventIdFactory {
  create(): EventId;
}

export interface RunControllerDependencies {
  readonly agentLoop: AgentLoop;
  readonly execution: RunExecutionStorePort;
  readonly events: RunEventNotifier;
  readonly configResolver: RunExecutionConfigResolver;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };
  readonly eventIdFactory: EventIdFactory;
}
