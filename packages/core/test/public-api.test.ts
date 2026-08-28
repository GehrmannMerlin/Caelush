import * as core from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Core Phase 6A public API", () => {
  it("exports the required Kernel contracts and helpers", () => {
    const required = [
      "AgentModelOutputError",
      "AgentToolResultBatchError",
      "AgentKernelStateError",
      "classifyAgentDecision",
      "normalizeToolResultBatch",
      "summarizeAgentDecision",
      "summarizeAgentLoopOutcome",
      "createInitialAgentState",
      "startAgentState",
      "beginAgentStepState",
      "settleAgentStepState",
      "markAgentStateVerifying",
      "markAgentStateMaxStepsReached",
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

  it("does not expose an AgentLoop during Phase 6A", () => {
    expect((core as Record<string, unknown>).AgentLoop).toBeUndefined();
    expect((core as Record<string, unknown>).runAgentLoop).toBeUndefined();
  });
});
