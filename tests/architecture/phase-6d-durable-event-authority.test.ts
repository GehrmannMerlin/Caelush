import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

describe("Architecture V2 Phase 6D durable event authority", () => {
  it("keeps the public Storage event surface read-only", async () => {
    const eventStore = await read("packages/storage/src/events/sqlite-durable-event-store.ts");
    const storage = await read("packages/storage/src/storage.ts");
    const eventPort = await read("packages/events/src/durable-event-store.ts");

    expect(eventStore).not.toMatch(/\basync append\s*\(/);
    expect(eventStore).toContain("implements DurableRunEventReaderPort");
    expect(storage).toContain("readonly eventReader: DurableRunEventReaderPort");
    expect(storage).not.toMatch(/readonly events\s*:/);
    expect(eventPort).not.toMatch(/\bappend\s*\(/);
  });

  it("leaves event insertion only in the Storage transaction helper", async () => {
    const helper = await read("packages/storage/src/events/sqlite-durable-event-store.ts");
    const eventBus = await read("packages/events/src/event-bus.ts");
    const hub = await read("apps/daemon/src/events/run-event-hub.ts");

    expect(helper).toContain("appendDurableEventsInTransaction");
    expect(helper).toContain("INSERT INTO agent_events");
    expect(eventBus).not.toContain("durableStore.append");
    expect(hub).not.toMatch(/\bappend\s*\(/);
  });
});
