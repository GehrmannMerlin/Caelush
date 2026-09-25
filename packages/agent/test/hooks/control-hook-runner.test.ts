import { createRunId, createSessionId, createStepId } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createControlHookId,
  createControlHookRegistryBuilder,
  type ControlHook,
  type ControlHookRegistration,
} from "../../src/hooks/control-hook.js";
import {
  ControlHookAbortedError,
  ControlHookReentrancyError,
} from "../../src/hooks/control-hook-errors.js";
import { createControlHookRunner } from "../../src/hooks/control-hook-runner.js";

const identity = { runId: createRunId(), sessionId: createSessionId() };
const context = {
  identity,
  stepId: createStepId(),
  mode: "EXECUTE" as const,
  signal: new AbortController().signal,
};

function registration<T>(
  id: string,
  hook: ControlHook<undefined, T>,
  overrides: Partial<ControlHookRegistration<ControlHook<undefined, T>>> = {},
): ControlHookRegistration<ControlHook<undefined, T>> {
  return {
    id: createControlHookId(id),
    priority: 1,
    criticality: "REQUIRED",
    timeoutMs: 100,
    hook,
    ...overrides,
  };
}

function policy<T>(initial: T) {
  return {
    initial,
    onResult: (current: T, next: T) => next,
    onFailure: ({
      registration: failed,
    }: {
      readonly registration: ControlHookRegistration<ControlHook<unknown, T>>;
      readonly error: unknown;
    }) =>
      failed.criticality === "OPTIONAL"
        ? { kind: "CONTINUE" as const, result: initial }
        : { kind: "THROW" as const, error: new Error("required hook failed") },
  };
}

describe("ControlHookRunner", () => {
  it("awaits hooks serially in registry order and returns receipts", async () => {
    const order: string[] = [];
    const registry = createControlHookRegistryBuilder<ControlHook<undefined, string>>()
      .register(
        registration(
          "second",
          {
            invoke: async () => {
              order.push("second:start");
              order.push("second:end");
              return "second";
            },
          },
          { priority: 2 },
        ),
      )
      .register(
        registration(
          "first",
          {
            invoke: async () => {
              order.push("first:start");
              order.push("first:end");
              return "first";
            },
          },
          { priority: 1 },
        ),
      )
      .build();
    const runner = createControlHookRunner({
      pipelineId: "test-pipeline",
      clock: {
        now: (() => {
          let value = 100;
          return () => (value += 1);
        })(),
      },
    });

    const result = await runner.run(registry, undefined, context, {
      initial: "initial",
      onResult: (_current, next) => next,
      onFailure: () => ({ kind: "THROW", error: new Error("unexpected") }),
    });

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(result.result).toBe("second");
    expect(result.invocations.map((item) => item.hookId)).toEqual(["first", "second"]);
    expect(result.receipts.every((receipt) => receipt.outcome === "APPLIED")).toBe(true);
    expect(result.receipts[0]).toMatchObject({ pipeline: "test-pipeline", hookId: "first" });
  });

  it("skips optional failures with a FAILED receipt and throws required failures", async () => {
    const optional = createControlHookRegistryBuilder<ControlHook<undefined, string>>()
      .register(
        registration(
          "optional",
          {
            invoke: async () => {
              throw new Error("secret failure");
            },
          },
          { criticality: "OPTIONAL" },
        ),
      )
      .build();
    const runner = createControlHookRunner({ clock: { now: () => 10 }, pipelineId: "failure" });
    const skipped = await runner.run(optional, undefined, context, {
      initial: "initial",
      onResult: (_current, next) => next,
      onFailure: ({ registration: failed }) =>
        failed.criticality === "OPTIONAL"
          ? { kind: "CONTINUE", result: "initial" }
          : { kind: "THROW", error: new Error("required") },
    });
    expect(skipped.result).toBe("initial");
    expect(skipped.receipts[0]).toMatchObject({ outcome: "FAILED", hookId: "optional" });
    expect(skipped.receipts[0]?.error).toBeUndefined();

    const required = createControlHookRegistryBuilder<ControlHook<undefined, string>>()
      .register(
        registration("required", {
          invoke: async () => {
            throw new Error("hidden");
          },
        }),
      )
      .build();
    await expect(
      runner.run(required, undefined, context, {
        initial: "initial",
        onResult: (_current, next) => next,
        onFailure: () => ({ kind: "THROW", error: new Error("required hook failed") }),
      }),
    ).rejects.toThrow("required hook failed");
  });

  it("returns on timeout and isolates a late promise", async () => {
    vi.useFakeTimers();
    try {
      let rejectLate!: (error: Error) => void;
      const late = new Promise<string>((_resolve, reject) => {
        rejectLate = reject;
      });
      const registry = createControlHookRegistryBuilder<ControlHook<undefined, string>>()
        .register(
          registration("slow", { invoke: () => late }, { timeoutMs: 5, criticality: "OPTIONAL" }),
        )
        .build();
      const runner = createControlHookRunner({ clock: { now: () => 10 }, pipelineId: "timeout" });
      const pending = runner.run(registry, undefined, context, {
        initial: "initial",
        onResult: (_current, next) => next,
        onFailure: ({ registration: failed }) =>
          failed.criticality === "OPTIONAL"
            ? { kind: "CONTINUE", result: "initial" }
            : { kind: "THROW", error: new Error("required") },
      });
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;
      expect(result.result).toBe("initial");
      expect(result.receipts[0]).toMatchObject({ outcome: "FAILED", hookId: "slow" });
      rejectLate(new Error("late failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates parent cancellation and does not start a later hook", async () => {
    const controller = new AbortController();
    let secondStarted = false;
    const registry = createControlHookRegistryBuilder<ControlHook<undefined, string>>()
      .register(
        registration("first", {
          invoke: async () => {
            controller.abort();
            return "first";
          },
        }),
      )
      .register(
        registration(
          "second",
          {
            invoke: async () => {
              secondStarted = true;
              return "second";
            },
          },
          { priority: 2 },
        ),
      )
      .build();
    const runner = createControlHookRunner({ clock: { now: () => 10 }, pipelineId: "abort" });
    await expect(
      runner.run(registry, undefined, { ...context, signal: controller.signal }, policy("initial")),
    ).rejects.toBeInstanceOf(ControlHookAbortedError);
    expect(secondStarted).toBe(false);
  });

  it("rejects nested same-pipeline execution but permits independent top-level runs", async () => {
    const runner = createControlHookRunner({ clock: { now: () => 10 }, pipelineId: "reentrant" });
    let nested!: Promise<unknown>;
    const registry = createControlHookRegistryBuilder<ControlHook<undefined, string>>();
    const hook: ControlHook<undefined, string> = {
      invoke: async (_input, nestedContext) => {
        nested = runner.run(registry.build(), undefined, nestedContext, policy("nested"));
        try {
          await nested;
          throw new Error("nested pipeline unexpectedly completed");
        } catch (error) {
          if (!(error instanceof ControlHookReentrancyError)) throw error;
        }
        return "outer";
      },
    };
    registry.register(registration("same", hook));
    const result = await runner.run(registry.build(), undefined, context, policy("initial"));
    expect(result.result).toBe("outer");

    const otherController = new AbortController();
    const otherContext = { ...context, signal: otherController.signal };
    await expect(
      runner.run(registry.build(), undefined, otherContext, policy("initial")),
    ).resolves.toMatchObject({ result: "outer" });
  });
});
