import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type { AgentError, AgentRun, AgentState, StepId } from "@caelush/protocol";
import type { AgentToolRequest } from "./agent-decision.js";

export type RunControllerResult =
  | { readonly status: "PENDING"; readonly run: AgentRun; readonly state?: AgentState }
  | { readonly status: "RUNNING"; readonly run: AgentRun; readonly state: AgentState }
  | {
      readonly status: "WAITING_TOOL_RESULTS";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly sourceStepId: StepId;
      readonly toolRequests: readonly AgentToolRequest[];
    }
  | {
      readonly status: "AWAITING_VERIFICATION";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly sourceStepId: StepId;
      readonly candidateText: string;
    }
  | {
      readonly status: "FAILED";
      readonly run: AgentRun;
      readonly state: AgentState;
      readonly error: AgentError;
    }
  | { readonly status: "MAX_STEPS_REACHED"; readonly run: AgentRun; readonly state: AgentState }
  | { readonly status: "TERMINAL"; readonly run: AgentRun; readonly state?: AgentState };

export type RunControllerToolResults = readonly LLMToolResultMessage[];
