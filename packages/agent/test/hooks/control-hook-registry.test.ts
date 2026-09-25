import { describe, expect, it } from "vitest";
import {
  createControlHookId,
  createControlHookRegistryBuilder,
  type ControlHook,
  type ControlHookRegistration,
} from "../../src/hooks/control-hook.js";

type TestHook = ControlHook<string, string>;

function registration(
  id: string,
  priority: number,
  hook: TestHook = { invoke: async (input) => input },
): ControlHookRegistration<TestHook> {
  return {
    id: createControlHookId(id),
    priority,
    criticality: "REQUIRED",
    timeoutMs: 100,
    hook,
  };
}

describe("ControlHookRegistryBuilder", () => {
  it("builds a deterministic immutable registry", () => {
    const builder = createControlHookRegistryBuilder<TestHook>();
    const first = registration("zeta", 10);
    const second = registration("alpha", 10);
    const third = registration("early", 1);
    builder.register(first).register(second).register(third);

    const registry = builder.build();
    const listed = registry.list();
    expect(listed.map((item) => item.id)).toEqual(["early", "alpha", "zeta"]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);

    builder.register(registration("later", 20));
    expect(registry.list().map((item) => item.id)).toEqual(["early", "alpha", "zeta"]);
    expect(() => listed.push(first)).toThrow();
  });

  it.each([
    ["duplicate hook id", () => registration("same", 1), () => registration("same", 2)],
    ["invalid priority", () => registration("bad", -1)],
    ["non-safe priority", () => registration("bad", Number.MAX_SAFE_INTEGER + 1)],
    ["invalid timeout", () => ({ ...registration("bad", 1), timeoutMs: 0 })],
    [
      "non-safe timeout",
      () => ({ ...registration("bad", 1), timeoutMs: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["invalid criticality", () => ({ ...registration("bad", 1), criticality: "MAYBE" as never })],
    ["missing callable", () => ({ ...registration("bad", 1), hook: {} as TestHook })],
  ])("rejects %s", (_name, first, second) => {
    const builder = createControlHookRegistryBuilder<TestHook>();
    builder.register(first());
    if (second !== undefined) builder.register(second());
    expect(() => builder.build()).toThrow();
  });

  it("supports the empty registry as an identity", () => {
    const registry = createControlHookRegistryBuilder<TestHook>().build();
    expect(registry.list()).toEqual([]);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });
});
