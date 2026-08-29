import * as core from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Core Phase 6B public API", () => {
  it("exports the required Kernel contracts and helpers", () => {
    const required = [
      "AgentModelOutputError",
      "AgentToolResultBatchError",
      "AgentKernelStateError",
      "AgentLoopInputError",
      "AgentLoop",
      "classifyAgentDecision",
      "normalizeToolResultBatch",
      "toLLMToolResultMessages",
      "summarizeAgentDecision",
      "summarizeAgentLoopOutcome",
      "createInitialAgentState",
      "startAgentState",
      "beginAgentStepState",
      "settleAgentStepState",
      "markAgentStateVerifying",
      "markAgentStateMaxStepsReached",
      "markAgentStateWaitingApproval",
      "createRunningAgentStep",
      "completeAgentStep",
      "failAgentStep",
      "cancelAgentStep",
      "evaluateAgentStepGate",
      "nextAgentStepSequence",
    ];
    for (const name of required) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it("exposes the resumable AgentLoop without exposing a duplicate runner", () => {
    expect((core as Record<string, unknown>).AgentLoop).toBeDefined();
    expect((core as Record<string, unknown>).runAgentLoop).toBeUndefined();
  });
});
