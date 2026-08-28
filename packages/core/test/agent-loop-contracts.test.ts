import type {
  AgentLoopCommonInput,
  AgentLoopExecutionResult,
  AgentLoopResumeInput,
  AgentLoopStartInput,
  AgentLLMClient,
  AgentClock,
  AgentStepIdFactory,
  AgentLoopDependencies,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("AgentLoop contracts", () => {
  it("can represent start, resume, ports, and execution results without host implementations", () => {
    const common = {} as AgentLoopCommonInput;
    const start: AgentLoopStartInput = common;
    const resume: AgentLoopResumeInput = {
      ...common,
      pendingDecision: {} as AgentLoopResumeInput["pendingDecision"],
      toolResults: [],
    };
    const client: AgentLLMClient = { complete: async () => ({}) as never };
    const clock: AgentClock = { now: () => 0 as never };
    const idFactory: AgentStepIdFactory = { create: () => "step" as never };
    const dependencies: AgentLoopDependencies = {
      inspector: {} as AgentLoopDependencies["inspector"],
      planner: {} as AgentLoopDependencies["planner"],
      contextBuilder: {} as AgentLoopDependencies["contextBuilder"],
      llmClient: client,
      clock,
      stepIdFactory: idFactory,
    };

    expect(start).toBe(common);
    expect(resume.toolResults).toEqual([]);
    expect(dependencies.llmClient).toBe(client);
    expect(undefined as unknown as AgentLoopExecutionResult).toBeUndefined();
  });
});
