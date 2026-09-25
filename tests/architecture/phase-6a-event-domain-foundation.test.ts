import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

describe("Architecture V2 Phase 6A event domain foundation", () => {
  it("keeps the canonical event ownership and compatibility direction explicit", async () => {
    const protocol = await read("packages/protocol/src/events/index.ts");
    const agent = await read("packages/agent/src/index.ts");
    const legacyEvents = await read("packages/events/src/event-draft.ts");
    const legacyManifest = await read("packages/events/package.json");

    expect(protocol).toContain("RunEventSchema");
    expect(protocol).toContain("AgentEventSchema = RunEventSchema");
    expect(agent).toContain("./events/durable-run-event-draft.js");
    expect(agent).toContain("./events/notifier-port.js");
    expect(legacyEvents).toContain("@caelush/agent");
    expect(legacyManifest).toContain('"@caelush/agent": "workspace:*"');
  });

  it("preserves the foundation while allowing the completed Phase 6C public cutover", async () => {
    const eventBus = await read("packages/events/src/event-bus.ts");
    const daemonComposition = await read("apps/daemon/src/daemon-composition.ts");
    const daemonRoute = await read("apps/daemon/src/routes/events.ts");

    expect(eventBus).toContain("async publish(");
    expect(eventBus).toContain("notifyCommitted(");
    expect(daemonComposition).not.toContain("EventBus");
    expect(daemonRoute).toContain("PublicEventProjector");
    expect(daemonRoute).toContain("mapPublicRunEventToSse");
    expect(await read("packages/storage/src/schema.ts")).not.toContain("event_schema_version_v2");
  });

  it("keeps Control Hook ownership in Agent without moving Context or Storage into the kernel", async () => {
    expect(await read("apps/daemon/src/events/run-event-hub.ts")).toContain("class RunEventHub");
    const registry = await read("packages/agent/src/hooks/control-hook.ts");
    expect(registry).toContain("ControlHookRegistry");
    expect(registry).not.toContain("@caelush/context");
    expect(registry).not.toContain("@caelush/storage");
  });
});
