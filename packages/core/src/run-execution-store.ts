import type { LLMMessage } from "@caelush/llm/messages";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  AgentEvent,
  EventDurability,
  RunId,
  StepId,
  TimestampMs,
} from "@caelush/protocol";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";

type DurableEvent = Extract<EventDurability, { kind: "DURABLE" }>;

export type DurableEventDraft = AgentEvent extends infer Event
  ? Event extends { type: string }
    ? Omit<Event, "durability"> & { durability: Omit<DurableEvent, "sequence"> }
    : never
  : never;

export type DurableAgentEvent = AgentEvent extends infer Event
  ? Event extends { type: string }
    ? Omit<Event, "durability"> & { durability: DurableEvent }
    : never
  : never;

export interface RunConversationEntry {
  readonly runId: RunId;
  readonly sequence: number;
  readonly sourceStepId?: StepId;
  readonly createdAt: TimestampMs;
  readonly message: LLMMessage;
}

export interface RunExecutionSnapshot {
  readonly run: AgentRun;
  readonly state?: AgentState;
  readonly stateRevision?: number;
  readonly activeStep?: AgentStep;
  readonly conversation: readonly RunConversationEntry[];
  readonly continuation?: RunContinuationCheckpoint;
  readonly continuationRevision?: number;
}

export interface RunExecutionMessageAppend {
  readonly createdAt: TimestampMs;
  readonly sourceStepId?: StepId;
  readonly message: LLMMessage;
}

export interface RunExecutionStepWrite {
  readonly operation: "INSERT" | "UPDATE";
  readonly step: AgentStep;
}

export type RunExecutionContinuationWrite =
  | {
      readonly operation: "SET";
      readonly checkpoint: RunContinuationCheckpoint;
      readonly updatedAt: TimestampMs;
    }
  | {
      readonly operation: "CLEAR";
    };

export interface RunExecutionCommit {
  readonly run: AgentRun;
  readonly state?: AgentState;
  readonly expectedStateRevision: number | null;
  readonly expectedContinuationRevision: number | null;
  readonly stepWrites: readonly RunExecutionStepWrite[];
  readonly messagesToAppend: readonly RunExecutionMessageAppend[];
  readonly continuation?: RunExecutionContinuationWrite;
  readonly events: readonly DurableEventDraft[];
}

export interface RunExecutionCommitResult {
  readonly snapshot: RunExecutionSnapshot;
  readonly events: readonly DurableAgentEvent[];
}

export interface RunExecutionStorePort {
  load(runId: RunId): Promise<RunExecutionSnapshot | null>;
  commit(command: RunExecutionCommit): Promise<RunExecutionCommitResult>;
}

export class RunExecutionConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunExecutionConflictError";
  }
}

export class RunExecutionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutionInvariantError";
  }
}
