import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaelushClient } from "@caelush/client";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../daemon/src/index.js";
import { WebSessionManager } from "../src/application/session-manager.js";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;
let manager: WebSessionManager | undefined;

afterEach(async () => {
  manager?.dispose();
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  manager = undefined;
  daemon = undefined;
  directory = undefined;
});

describe("real daemon to Web timeline E2E", () => {
  it("projects real Tool, File, and Verification activity through the browser session manager", async () => {
    const workspacePath = await makeWorkspace();
    const provider = new TimelineProvider();
    daemon = await startDaemon({
      databasePath: join(workspacePath, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    manager = new WebSessionManager({
      client,
      workspace: { id: createWorkspaceId(), path: workspacePath },
      info: await client.getInfo(),
    });

    await manager.loadSessions();
    manager.beginDraft();
    await expect(manager.submitPrompt("inspect the workspace safely")).resolves.toBe(true);
    await waitFor(() => manager?.getSnapshot().activeRun === undefined);

    const snapshot = manager.getSnapshot();
    expect(snapshot.timeline.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "TOOL", status: "COMPLETED", filePath: "src/message.txt" }),
        expect.objectContaining({ kind: "VERIFICATION", status: "FINALIZED" }),
      ]),
    );
    expect(snapshot.history.map((entry) => entry.kind)).toContain("ASSISTANT");
    expect(JSON.stringify(snapshot.timeline)).not.toContain("API_KEY=real-value");
  }, 20_000);
});

/**
 * Phase 2C: a fixture adapter is a *dialect*, not a vendor.
 *
 * The class registers the shared `FIXTURE_API` id and implements the AI core's
 * `ApiAdapter` seam. There is no `supportsModel` and no capability declaration any more:
 * model metadata is the model catalog's authority, and the gateway owns the
 * `stream.start` / `stream.finish` envelope, so an adapter emits only dialect events.
 */
class TimelineProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(JSON.stringify({ verdict: "PASS", summary: "The task is acceptable." }));
    }
    if (this.calls === 1) return this.readFileCall();
    return this.text("The verified workspace report is complete.");
  }

  private async *readFileCall(): AsyncGenerator<AIAdapterEvent> {
    yield { type: "tool_call.start", payload: { toolCallId: "read-call", toolName: "read_file" } };
    yield {
      type: "tool_call.completed",
      payload: { id: "read-call", name: "read_file", input: { path: "src/message.txt" } },
    };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }

  private async *text(value: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text: value } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

async function makeWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), "caelush-web-timeline-e2e-"));
  directory = workspacePath;
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "src", "message.txt"), "API_KEY=real-value\n", "utf8");
  return workspacePath;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
