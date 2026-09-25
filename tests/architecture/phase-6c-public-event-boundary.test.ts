import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

describe("Architecture V2 Phase 6C public event boundary", () => {
  it("keeps public DTO ownership in Protocol and projection ownership in daemon", async () => {
    const protocol = await read("packages/protocol/src/events/index.ts");
    const publicEvent = await read("packages/protocol/src/events/public.ts");
    const projector = await read("apps/daemon/src/events/public-event-projector.ts");

    expect(protocol).toContain("PublicRunEventSchema");
    expect(protocol).toContain("PublicRunEvent");
    expect(publicEvent).toContain('z.literal("USER_VISIBLE")');
    expect(projector).toContain("export interface PublicEventProjector");
    expect(projector).toContain("PublicRunEventSchema.safeParse");
    expect(projector).not.toContain("storage");
  });

  it("forces the ordinary route through the public projector and mapper", async () => {
    const route = await read("apps/daemon/src/routes/events.ts");
    const mapper = await read("apps/daemon/src/transport/sse-event-mapper.ts");

    expect(route).toContain("PublicEventProjector");
    expect(route).toContain("publicEventProjector.project");
    expect(route).toContain("mapPublicRunEventToSse");
    expect(route).not.toContain("mapAgentEventToSse");
    expect(route).not.toContain("dependencies.eventBus");
    expect(mapper).toContain("PublicRunEvent");
    expect(mapper).toContain("mapPublicRunEventToSse");
    expect(mapper).not.toContain("AgentEvent");
  });

  it("keeps hidden visibility and later phase boundaries closed", async () => {
    const client = await read("packages/client/src/client.ts");
    const reducer = await read("packages/client/src/timeline/reducer.ts");
    const app = await read("apps/daemon/src/app.ts");
    const daemonEvents = await read("apps/daemon/src/events/run-event-hub.ts");
    const legacyBus = await read("packages/events/src/event-bus.ts");

    expect(client).toContain("PublicRunEventSchema");
    expect(client).not.toContain("AgentEventSchema");
    expect(reducer).toContain("PublicRunEvent");
    expect(app).toContain("publicEventProjector");
    expect(daemonEvents).toContain("class RunEventHub");
    expect(legacyBus).toContain("async publish(");
    expect(await read("apps/daemon/src/routes/events.ts")).not.toMatch(
      /include(?:Debug|System)|[?&]debug=/,
    );
    const registry = await read("packages/agent/src/hooks/control-hook.ts");
    expect(registry).toContain("ControlHookRegistry");
    expect(registry).not.toContain("@caelush/context");
    expect(registry).not.toContain("@caelush/storage");
  });
});
