import type { AgentState, RunLimits } from "@caelush/protocol";
import { AgentKernelStateError } from "./agent-errors.js";
import type { AgentMaxStepsReachedOutcome } from "./agent-decision.js";
import { nextAgentStepSequence } from "./agent-step.js";

export type AgentStepGate =
  | { readonly allowed: true; readonly nextSequence: number }
  | {
      readonly allowed: false;
      readonly outcome: AgentMaxStepsReachedOutcome;
    };

export function evaluateAgentStepGate(state: AgentState, limits: RunLimits): AgentStepGate {
  if (state.status !== "RUNNING") {
    throw new AgentKernelStateError("agent step gate requires a RUNNING state");
  }
  if (state.currentStepId !== undefined) {
    throw new AgentKernelStateError("agent step gate cannot run with an active step");
  }
  if (state.usage.steps >= limits.maxSteps) {
    return {
      allowed: false,
      outcome: {
        type: "MAX_STEPS_REACHED",
        stepsCompleted: state.usage.steps,
        maxSteps: limits.maxSteps,
      },
    };
  }
  return { allowed: true, nextSequence: nextAgentStepSequence(state) };
}
