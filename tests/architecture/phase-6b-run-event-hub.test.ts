import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

describe("Architecture V2 Phase 6B RunEventHub", () => {
  it("keeps the Hub in daemon and exposes only observation authority", async () => {
    const hub = await read("apps/daemon/src/events/run-event-hub.ts");
    const composition = await read("apps/daemon/src/daemon-composition.ts");
    const storage = await read("packages/storage/src/storage.ts");

    expect(hub).toContain("implements RunEventNotifierPort");
    expect(hub).toContain("DurableRunEventReaderPort");
    expect(hub).toContain("notifyCommitted");
    expect(hub).toContain("emitTransient");
    expect(hub).not.toMatch(/\b(?:append|appendInTransaction)\s*\(/);
    expect(hub).not.toMatch(/from ["'](?:@caelush\/storage|\.\.\/.*storage)/);
    expect(composition).toContain("new RunEventHub(options.storage.eventReader");
    expect(storage).toContain("readonly eventReader: DurableRunEventReaderPort");
  });

  it("does not move observation authority into packages or future phases", async () => {
    const [agent, ai, runtime, events, route, daemon] = await Promise.all([
      read("packages/agent/src/index.ts"),
      read("packages/ai/src/index.ts"),
      read("packages/runtime/src/index.ts"),
      read("packages/events/src/event-bus.ts"),
      read("apps/daemon/src/routes/events.ts"),
      read("apps/daemon/src/daemon.ts"),
    ]);

    expect(agent).not.toContain("RunEventHub");
    expect(ai).not.toContain("RunEventHub");
    expect(runtime).not.toContain("RunEventHub");
    expect(events).not.toContain("apps/daemon");
    expect(route).toContain("eventHub.watch");
    expect(route).toContain("mapPublicRunEventToSse");
    expect(daemon).not.toContain("new EventBus");
    const registry = await read("packages/agent/src/hooks/control-hook.ts");
    expect(registry).toContain("ControlHookRegistry");
    expect(registry).not.toContain("@caelush/context");
    expect(registry).not.toContain("@caelush/storage");
  });

  it("keeps writer retirement and producer migration out of the completed 6B/6C boundary", async () => {
    const route = await read("apps/daemon/src/routes/events.ts");
    const eventBus = await read("packages/events/src/event-bus.ts");
    const protocol = await read("packages/protocol/src/events/base.ts");

    expect(route).toContain("PublicEventProjector");
    expect(route).toContain("publicEventProjector.project");
    expect(eventBus).toContain("async publish(");
    expect(eventBus).toContain("notifyCommitted(");
    expect(protocol).toContain('deliveryClass: z.literal("ORDERED")');
    expect(protocol).toContain('deliveryClass: z.literal("COALESCIBLE")');
  });
});
