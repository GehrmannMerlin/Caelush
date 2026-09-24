import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

describe("Architecture V2 Phase 6E transient signal and streaming cutover", () => {
  it("keeps versioned Protocol history and current transient contracts side by side", async () => {
    const protocol = await read("packages/protocol/src/events/index.ts");
    const catalog = await read("packages/protocol/src/events/catalog.ts");
    const registry = await read("packages/protocol/src/events/registry.ts");

    for (const type of [
      "model.text.delta",
      "model.reasoning_summary.delta",
      "model.tool_call.delta",
    ]) {
      expect(catalog).toContain(type);
      expect(registry).toContain(type);
    }
    for (const type of ["tool.output", "shell.output", "process.output"]) {
      expect(catalog).toContain(`${type}", 2`);
      expect(registry).toContain(`${type}\\u00002`);
    }
    expect(protocol).toContain("createVersionedEventSchema");
    expect(protocol).toContain("z.union([");
    expect(protocol).not.toContain('z.discriminatedUnion("type"');
  });

  it("keeps model projection in Agent and Runtime neutral", async () => {
    const projector = await read("packages/agent/src/events/model-stream-signal-projector.ts");
    const executor = await read("packages/agent/src/loop/turn/model-turn-executor.ts");
    const runtime = await read("packages/runtime/src/exec/contracts.ts");
    const coding = await read(
      "packages/coding-agent/src/tools/runtime-progress-signal-projector.ts",
    );

    expect(projector).toContain("ModelStreamSignalProjector");
    expect(projector).toContain("model.reasoning_summary.delta");
    expect(projector).not.toContain("@caelush/runtime");
    expect(executor).toContain("notifier.emitTransient");
    expect(runtime).toContain("ProcessOutputEvent");
    expect(runtime).not.toContain("RunEvent");
    expect(coding).toContain("RuntimeProgressSignalProjector");
    expect(coding).not.toContain("@caelush/storage");
    expect(coding).not.toContain("@caelush/daemon");
  });

  it("routes live output through the notifier and removes new durable output writes", async () => {
    const daemon = await read("apps/daemon/src/daemon-composition.ts");
    const settlement = await read("packages/agent/src/tools/durable/settlement-coordinator.ts");
    const sse = await read("apps/daemon/src/transport/sse-event-mapper.ts");
    const timeline = await read("packages/client/src/timeline/reducer.ts");
    const liveActivity = await read("packages/client/src/live-activity.ts");

    expect(daemon).toContain("createRuntimeProgressSignalProjector");
    expect(daemon).toContain("eventNotifier.emitTransient");
    expect(settlement).not.toContain("createToolOutputEvent(");
    expect(sse).toContain('event.durability.kind === "DURABLE"');
    expect(timeline).toContain('event.durability.kind === "EPHEMERAL"');
    expect(liveActivity).toContain("reduceLiveActivityEvent");
    expect(liveActivity).toContain("lastStreamSequences");
  });
});
