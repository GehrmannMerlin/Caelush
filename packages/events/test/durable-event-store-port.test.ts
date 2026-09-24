import { describe, expect, it } from "vitest";
import type { DurableRunEventDraft } from "@caelush/agent";
import type { DurableEventDraft, DurableEventStore } from "../src/index.js";

describe("DurableEventStore port", () => {
  it("is provider-neutral and exposes only replay and latest sequence", () => {
    const store: DurableEventStore = {
      replay: async () => [],
      latestSequence: async () => 0,
    };

    expect("append" in store).toBe(false);
    expect(store.latestSequence).toBeTypeOf("function");
  });

  it("keeps the legacy draft name aligned with the Agent-owned canonical draft", () => {
    const legacy = null as unknown as DurableEventDraft;
    const canonical: DurableRunEventDraft = legacy;
    expect(canonical).toBeNull();
  });
});
