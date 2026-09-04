import { describe, expect, it } from "vitest";
import { createModelContextProfile } from "../src/model-context-profile.js";
import { createContextPolicy } from "../src/context-policy.js";
import { createExecutionUnit, type ExecutionUnit } from "../src/execution-unit.js";
import { ContextPressureController, ContextPressureStateMachine } from "../src/compaction.js";

const policy = createContextPolicy(
  createModelContextProfile({
    providerId: "fixture",
    modelId: "tiny",
    contextWindowTokens: 16_000,
    maxOutputTokens: 4096,
    recommendedOutputReserveTokens: 2048,
    supportsPromptCaching: false,
    supportsUsageReporting: true,
    profileSource: "CONFIGURATION",
  }),
);

function unit(id: string, status: "OPEN" | "CLOSED", tokenEstimate: number): ExecutionUnit {
  return createExecutionUnit({
    id,
    runId: "run-1",
    sourceSequenceFrom: Number(id.slice(1)),
    sourceSequenceTo: Number(id.slice(1)) + 1,
    status,
    assistantMessageRef: `${id}:assistant`,
    toolInvocationIds: [`${id}:call`],
    toolResultRefs: status === "CLOSED" ? [`${id}:result`] : [],
    tokenEstimate,
    createdAt: 1,
    ...(status === "CLOSED" ? { closedAt: 2 } : {}),
  });
}

describe("ContextPressureController", () => {
  it("compacts only closed units and leaves the open protocol unit outside the cut", async () => {
    const controller = new ContextPressureController({ policy });
    const result = await controller.compact({
      runId: "run-1",
      goal: "do not modify database/",
      estimatedInputTokens: policy.emergencyCompactionTokens,
      units: [unit("u1", "CLOSED", 100), unit("u2", "CLOSED", 100), unit("u3", "OPEN", 100)],
      sourceRange: { from: 1, to: 10 },
      changedFiles: [],
      recentErrors: [],
      verificationState: "PENDING",
      compactor: async () => {
        throw new Error("unavailable");
      },
    });

    expect(result.selectedUnits.map((selected) => selected.id)).toEqual(["u1", "u2"]);
    expect(result.openUnits.map((open) => open.id)).toEqual(["u3"]);
    expect(result.degraded).toBe(true);
    expect(result.checkpoint.goal).toBe("do not modify database/");
  });

  it("uses hysteresis after compaction", () => {
    const controller = new ContextPressureController({ policy });
    expect(controller.shouldCompact(policy.proactiveCompactionTokens)).toBe(true);
    expect(controller.postCompactionTargetTokens).toBeLessThan(policy.proactiveCompactionTokens);
    expect(controller.shouldCompact(controller.postCompactionTargetTokens)).toBe(false);
  });

  it("keeps the post-compaction target below the proactive trigger", () => {
    const controller = new ContextPressureController({ policy });

    expect(controller.postCompactionTargetRatio).toBe(0.5);
    expect(controller.shouldCompact(controller.postCompactionTargetTokens)).toBe(false);
    expect(controller.shouldCompact(policy.proactiveCompactionTokens)).toBe(true);
  });

  it("transitions through recovery and uses hysteresis after a successful rebuild", () => {
    const machine = new ContextPressureStateMachine(policy);
    expect(machine.state).toBe("NORMAL");
    machine.observe(policy.proactiveCompactionTokens);
    expect(machine.state).toBe("PROACTIVE");
    machine.markRecovering();
    expect(machine.state).toBe("RECOVERING_OVERFLOW");
    machine.markRecovered(controllerTarget(policy));
    expect(machine.state).toBe("NORMAL");
    machine.markExhausted();
    expect(machine.state).toBe("EXHAUSTED");
  });
});

function controllerTarget(input: typeof policy): number {
  return Math.floor(input.effectiveInputLimit * input.postCompactionTargetRatio);
}
