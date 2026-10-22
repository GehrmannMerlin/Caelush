/**
 * The legacy Core decision facade.
 *
 * Phase 3A moved every agent decision contract into `@caelush/agent`, where it is written
 * in `@caelush/ai` and `@caelush/protocol` types. This module is a compatibility re-export
 * so existing Core call sites keep their import path while the migration continues. It
 * declares nothing of its own except the Run Layer outcome below, which is not an agent
 * decision at all.
 *
 * The general Agent Kernel deliberately owns no shape for structural step exhaustion: the
 * `maxSteps` gate is a Run Layer gate, and the agent loop must not know what `maxSteps` is.
 */
export type {
  AgentDecision,
  AgentFinalCandidateDecision,
  AgentModelTurn,
  AgentToolCallsDecision,
  AgentToolRequest,
} from "@caelush/agent";

/** A Run that stopped because the structural step budget ran out. */
export interface AgentMaxStepsReachedOutcome {
  readonly type: "MAX_STEPS_REACHED";
  readonly stepsCompleted: number;
  readonly maxSteps: number;
}

/**
 * What one AgentLoop call produced, in the Run Layer's vocabulary.
 *
 * `MAX_STEPS_REACHED` is a Run Layer outcome rather than a model decision: the model did
 * not decide to stop, the loop gate did.
 */
export type AgentLoopOutcome = import("@caelush/agent").AgentDecision | AgentMaxStepsReachedOutcome;

/**
 * The ordered request list of one Tool decision, in the assistant's own order.
 *
 * The decision carries two arrays — executable requests and rejected ones — while the assistant
 * message carries the *sequence* they appeared in. Both the Tool turn driver and the durable
 * result-batch normalizer pair results against this projection, so there is exactly one answer to
 * "which request is at position N".
 *
 * A decision whose arrays and message disagree is an invariant break, not an argument error: it
 * would let a result answer a request at the wrong position.
 */
export function orderedToolCalls(
  decision: import("@caelush/agent").AgentToolCallsDecision,
): readonly import("@caelush/agent").ToolBatchCall[] {
  const executableById = new Map(
    decision.toolRequests.map((request) => [request.externalCallId, request]),
  );
  const rejectedById = new Map(
    (decision.rejectedToolRequests ?? []).map((request) => [request.externalCallId, request]),
  );
  const ordered: import("@caelush/agent").ToolBatchCall[] = [];
  for (const part of decision.modelTurn.assistantMessage.content) {
    if (part.type === "tool-call") {
      const request = executableById.get(part.toolCallId);
      if (request === undefined) {
        throw new Error("A Tool decision announced a call it does not contain.");
      }
      executableById.delete(part.toolCallId);
      ordered.push({
        externalCallId: request.externalCallId,
        toolName: request.toolName,
        args: request.args,
      });
      continue;
    }
    if (part.type === "tool-call-rejected") {
      const request = rejectedById.get(part.toolCallId);
      if (request === undefined) {
        throw new Error("A Tool decision announced a rejected call it does not contain.");
      }
      rejectedById.delete(part.toolCallId);
      ordered.push({
        externalCallId: request.externalCallId,
        toolName: request.toolName,
        issue: { code: request.issue.code, argumentBytes: request.issue.argumentBytes },
      });
    }
  }
  if (executableById.size > 0 || rejectedById.size > 0) {
    throw new Error("A Tool decision contains requests its assistant message does not announce.");
  }
  return Object.freeze(ordered);
}
