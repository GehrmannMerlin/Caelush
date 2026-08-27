import { describe, expect, it } from "vitest";
import type { DurableEventStore } from "../src/index.js";

describe("DurableEventStore port", () => {
  it("is provider-neutral and exposes append, replay, and latest sequence", () => {
    const store: DurableEventStore = {
      append: async (event) => ({ ...event, durability: { ...event.durability, sequence: 1 } }),
      replay: async () => [],
      latestSequence: async () => 0,
    };

    expect(store.latestSequence).toBeTypeOf("function");
  });
});
