import { createRunId, createSessionId, createStepId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createControlHookId,
  createControlHookRegistryBuilder,
  type ControlHook,
  type ControlHookRegistration,
} from "../../src/hooks/control-hook.js";
import {
  ContextContributionPipelineError,
  createContextContributionPipeline,
  type ContextContribution,
  type ContextContributionHook,
  type ContextContributionInput,
} from "../../src/hooks/context-contribution.js";

const input: ContextContributionInput = {
  identity: {
    runId: createRunId(),
    sessionId: createSessionId(),
    goal: "test goal",
  },
  turn: { stepId: createStepId(), sequence: 1 },
  mode: "NORMAL",
  goal: "test goal",
};

const hookContext = {
  identity: input.identity,
  stepId: input.turn.stepId,
  mode: "EXECUTE" as const,
  signal: new AbortController().signal,
};

function contribution(
  id: string,
  source: string,
  replay: ContextContribution["replay"] = "SNAPSHOT",
  content = id,
): ContextContribution {
  return {
    id,
    source,
    replay,
    items: [
      {
        id: `${source}:${id}:item`,
        priorityClass: "NORMAL",
        content,
        tokenEstimate: 0,
      },
    ],
  };
}

function registration(
  id: string,
  hook: ContextContributionHook,
  overrides: Partial<
    ControlHookRegistration<ControlHook<ContextContributionInput, readonly ContextContribution[]>>
  > = {},
): ControlHookRegistration<ControlHook<ContextContributionInput, readonly ContextContribution[]>> {
  return {
    id: createControlHookId(id),
    priority: 1,
    criticality: "REQUIRED",
    timeoutMs: 100,
    hook: { invoke: (input, context) => hook.contribute(input, context) },
    ...overrides,
  };
}

function registry(
  registrations: readonly ControlHookRegistration<
    ControlHook<ContextContributionInput, readonly ContextContribution[]>
  >[],
) {
  const builder =
    createControlHookRegistryBuilder<
      ControlHook<ContextContributionInput, readonly ContextContribution[]>
    >();
  for (const item of registrations) builder.register(item);
  return builder.build();
}

function pipeline(
  registrations: readonly ControlHookRegistration<
    ControlHook<ContextContributionInput, readonly ContextContribution[]>
  >[] = [],
  options: Parameters<typeof createContextContributionPipeline>[0] = {},
) {
  return createContextContributionPipeline({
    registry: registry(registrations),
    ...options,
  });
}

describe("ContextContributionPipeline", () => {
  it("treats an empty registry as an identity with no diagnostics", async () => {
    const result = await pipeline().run(input, hookContext);
    expect(result.contributions).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.receipts).toEqual([]);
  });

  it("aggregates hooks in registry order and freezes safe output", async () => {
    const result = await pipeline([
      registration(
        "second",
        { contribute: async () => [contribution("b", "second")] },
        { priority: 2 },
      ),
      registration("first", { contribute: async () => [contribution("a", "first")] }),
    ]).run(input, hookContext);

    expect(result.contributions.map((item) => item.id)).toEqual(["a", "b"]);
    expect(Object.isFrozen(result.contributions)).toBe(true);
    expect(Object.isFrozen(result.contributions[0])).toBe(true);
    expect(result.receipts.map((item) => item.hookId)).toEqual(["first", "second"]);
  });

  it("rejects boundedness violations before aggregation", async () => {
    const result = await pipeline(
      [
        registration(
          "optional",
          {
            contribute: async () => [contribution("too-large", "optional", "SNAPSHOT", "123456")],
          },
          { criticality: "OPTIONAL" },
        ),
      ],
      { limits: { maxItemBytes: 4 } },
    ).run(input, hookContext);

    expect(result.contributions).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ hookId: "optional", code: "OUTPUT_INVALID" }]);
    expect(result.diagnostics[0]?.message).not.toContain("123456");
  });

  it("fails closed for required invalid output and skips optional hook failures safely", async () => {
    const required = pipeline([
      registration("required", { contribute: async () => [{ bad: true } as never] }),
    ]);
    await expect(required.run(input, hookContext)).rejects.toBeInstanceOf(
      ContextContributionPipelineError,
    );

    const optional = pipeline([
      registration(
        "optional",
        {
          contribute: async () => {
            throw new Error("secret");
          },
        },
        { criticality: "OPTIONAL" },
      ),
    ]);
    const result = await optional.run(input, hookContext);
    expect(result.contributions).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ hookId: "optional", code: "HOOK_FAILED" }]);
    expect(result.diagnostics[0]?.message).not.toContain("secret");
  });

  it("normalizes unqualified RECOMPUTE and retains it only when the host approves", async () => {
    const contributions = [
      contribution("remote", "remote", "RECOMPUTE"),
      contribution("local", "local", "RECOMPUTE"),
    ];
    const result = await pipeline(
      [registration("provider", { contribute: async () => contributions })],
      {
        isRecomputeEligible: ({ contribution: item }) => item.id === "local",
      },
    ).run(input, hookContext);

    expect(result.contributions.map((item) => item.replay)).toEqual(["SNAPSHOT", "RECOMPUTE"]);
  });

  it("rejects duplicate contribution identity instead of silently overwriting", async () => {
    const duplicate = contribution("same", "source");
    const result = await pipeline([
      registration("first", { contribute: async () => [duplicate] }),
      registration(
        "second",
        { contribute: async () => [duplicate] },
        { priority: 2, criticality: "OPTIONAL" },
      ),
    ]).run(input, hookContext);

    expect(result.contributions).toHaveLength(1);
    expect(result.diagnostics).toMatchObject([{ hookId: "second", code: "DUPLICATE_IDENTITY" }]);
  });
});
