import { describe, expect, it } from "vitest";
import type { DurableRunEventDraft } from "@caelush/agent";
import type { DurableEventDraft, DurableEventStore } from "../src/index.js";

describe("DurableEventStore port", () => {
  it("is provider-neutral and exposes append, replay, and latest sequence", () => {
    const store: DurableEventStore = {
      append: async (event) => ({ ...event, durability: { ...event.durability, sequence: 1 } }),
      replay: async () => [],
      latestSequence: async () => 0,
    };

    expect(store.latestSequence).toBeTypeOf("function");
  });

  it("keeps the legacy draft name aligned with the Agent-owned canonical draft", () => {
    const legacy = null as unknown as DurableEventDraft;
    const canonical: DurableRunEventDraft = legacy;
    expect(canonical).toBeNull();
  });
});
