import type {
  AgentLoopCommonInput,
  AgentLoopExecutionResult,
  AgentLoopResumeInput,
  AgentLoopStartInput,
  AgentClock,
  AgentStepIdFactory,
  AgentLoopDependencies,
} from "../src/index.js";
import { describe, expect, it } from "vitest";
import { fakeModelTurnExecutor, testModelCatalog } from "./support/fake-model-turn-executor.js";

describe("AgentLoop contracts", () => {
  it("can represent start, resume, ports, and execution results without host implementations", () => {
    const common = {} as AgentLoopCommonInput;
    const start: AgentLoopStartInput = common;
    const resume: AgentLoopResumeInput = {
      ...common,
      pendingDecision: {} as AgentLoopResumeInput["pendingDecision"],
      toolResults: [],
    };
    const models = testModelCatalog();
    const modelTurns = fakeModelTurnExecutor(async () => ({}) as never);
    const clock: AgentClock = { now: () => 0 as never };
    const idFactory: AgentStepIdFactory = { create: () => "step" as never };
    const dependencies: AgentLoopDependencies = {
      inspector: {} as AgentLoopDependencies["inspector"],
      planner: {} as AgentLoopDependencies["planner"],
      contextBuilder: {} as AgentLoopDependencies["contextBuilder"],
      models,
      modelTurns,
      clock,
      stepIdFactory: idFactory,
    };

    expect(start).toBe(common);
    expect(resume.toolResults).toEqual([]);
    expect(dependencies.models).toBe(models);
    expect(dependencies.modelTurns).toBe(modelTurns);
    expect(undefined as unknown as AgentLoopExecutionResult).toBeUndefined();
  });
});
