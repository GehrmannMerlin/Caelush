import type { RunId, StepId, ToolInvocationId } from "@caelush/protocol";
import type {
  DurableToolEventDraft,
  ToolExecutionCommit,
  ToolExecutionCommitResult,
  ToolExecutionSnapshot,
} from "./dispatcher-types.js";

export interface ToolExecutionStorePort {
  load(invocationId: ToolInvocationId): Promise<ToolExecutionSnapshot | null>;
  findByExternalCall(
    runId: RunId,
    stepId: StepId,
    externalCallId: string,
  ): Promise<ToolExecutionSnapshot | null>;
  commit(command: ToolExecutionCommit): Promise<ToolExecutionCommitResult>;
}

export { type DurableToolEventDraft };

export class ToolExecutionConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolExecutionConflictError";
  }
}

export class ToolExecutionInvariantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolExecutionInvariantError";
  }
}
