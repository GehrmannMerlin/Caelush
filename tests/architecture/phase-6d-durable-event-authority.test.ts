import { access, readFile } from "node:fs/promises";
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

  it("uses the Agent-owned notifier port at every production boundary", async () => {
    const ports = await read("packages/core/src/run-controller-ports.ts");
    const settlement = await read("packages/agent/src/tools/durable/settlement-coordinator.ts");
    const failure = await read("packages/agent/src/tools/durable/failure-settlement.ts");
    const coordinator = await read("packages/agent/src/tools/durable/durable-execution-coordinator.ts");
    const daemon = await read("apps/daemon/src/daemon-composition.ts");

    expect(ports).toContain("RunEventNotifierPort");
    expect(ports).not.toMatch(/interface RunEventNotifier\b/);
    for (const source of [settlement, failure, coordinator]) {
      expect(source).toContain("RunEventNotifierPort");
      expect(source).not.toMatch(/readonly notifier\?:\s*\{[\s\S]*?readonly unknown\[\]/);
    }
    expect(daemon).not.toMatch(/readonly eventBus\??:/);
    expect(daemon).not.toMatch(/\beventBus:\s*eventNotifier/);
    expect(daemon).not.toMatch(/options\.eventBus/);
  });

  it("keeps the reusable Run event factory in Agent", async () => {
    const agentFactory = await read("packages/agent/src/events/run-event-factory.ts");
    const materializer = await read("packages/core/src/run-commit-event-materializer.ts");

    await expect(access(resolve(repositoryRoot, "packages/core/src/run-controller-events.ts"))).rejects.toThrow();
    expect(agentFactory).toContain("createRunEventFactory");
    expect(agentFactory).not.toContain("@caelush/core");
    expect(materializer).toContain('from "@caelush/agent"');
    expect(materializer).not.toContain("./run-controller-events.js");
  });
});
