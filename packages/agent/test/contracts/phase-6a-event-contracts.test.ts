import { describe, expect, it } from "vitest";
import type {
  DurableRunEventDraft,
  DurableRunEventReaderPort,
  RunEventNotifierPort,
} from "@caelush/agent";

describe("Phase 6A Agent event contracts", () => {
  it("exposes the Agent-owned draft, reader, and notifier shapes", () => {
    const notifier: RunEventNotifierPort = {
      notifyCommitted: () => undefined,
      emitTransient: () => undefined,
    };
    const reader: DurableRunEventReaderPort = {
      replay: async () => [],
      latestSequence: async () => 0,
    };
    const draft = null as unknown as DurableRunEventDraft;

    expect(notifier.notifyCommitted).toBeTypeOf("function");
    expect(notifier.emitTransient).toBeTypeOf("function");
    expect(reader.replay).toBeTypeOf("function");
    expect(reader.latestSequence).toBeTypeOf("function");
    expect(draft).toBeNull();
  });
});
