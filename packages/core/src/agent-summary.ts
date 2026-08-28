import type {
  AgentDecision,
  AgentLoopOutcome,
  AgentMaxStepsReachedOutcome,
} from "./agent-decision.js";

const MAX_DISPLAYED_TOOL_NAMES = 5;

export function summarizeAgentDecision(decision: AgentDecision): string {
  if (decision.type === "FINAL_CANDIDATE") {
    return "Produced a final candidate response; verification is required before completion.";
  }

  const displayedNames = decision.toolRequests
    .slice(0, MAX_DISPLAYED_TOOL_NAMES)
    .map((request) => request.toolName)
    .join(", ");
  const remainingCount = decision.toolRequests.length - MAX_DISPLAYED_TOOL_NAMES;
  const suffix = remainingCount > 0 ? ` + ${remainingCount} more` : "";
  return `Requested ${decision.toolRequests.length} tool calls: ${displayedNames}${suffix}.`;
}

export function summarizeAgentLoopOutcome(outcome: AgentLoopOutcome): string {
  if (outcome.type === "MAX_STEPS_REACHED") {
    return summarizeMaxStepsReached(outcome);
  }
  return summarizeAgentDecision(outcome);
}

function summarizeMaxStepsReached(outcome: AgentMaxStepsReachedOutcome): string {
  return `Reached the configured maximum of ${outcome.maxSteps} agent steps.`;
}
