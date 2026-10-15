import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

afterEach(async () => {
  await daemon?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class PreviewProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  previewUrl: string | undefined;
  private started = false;

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (!this.started) {
      this.started = true;
      yield {
        type: "tool_call.start",
        payload: { toolCallId: "preview", toolName: "exec_command" },
      };
      yield {
        type: "tool_call.completed",
        payload: {
          id: "preview",
          name: "exec_command",
          input: { cmd: "node preview.mjs", yield_time_ms: 1000 },
        },
      };
      yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
      return;
    }
    this.previewUrl = JSON.stringify(input.request.messages).match(
      /PREVIEW_URL=(http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    yield { type: "text.delta", payload: { text: `Preview ready: ${this.previewUrl}` } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("preview process lifecycle", () => {
  it("keeps the preview listening after normal Run completion and cleans it up on daemon shutdown", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-preview-lifecycle-"));
    await writeFile(
      join(directory, "preview.mjs"),
      [
        'import { createServer } from "node:http";',
        'const server = createServer((_request, response) => response.end("preview alive"));',
        'server.listen(0, "127.0.0.1", () => {',
        "  console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}/`);",
        "});",
      ].join("\n"),
    );
    const provider = new PreviewProvider();
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    if (session.defaultWorkspace === undefined) throw new Error("Workspace was not registered");
    const run = await client.createRun(session.id, {
      goal: "Start a local preview and leave it running for the user.",
      workspace: session.defaultWorkspace,
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 15_000 },
    });
    await client.startRun(run.id);
    let settled = await client.getRun(run.id);
    for (let attempt = 0; attempt < 200 && settled.status !== "COMPLETED"; attempt += 1) {
      if (["FAILED", "CANCELLED", "TIMEOUT"].includes(settled.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await client.getRun(run.id);
    }

    expect(settled.status).toBe("COMPLETED");
    expect(provider.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    const url = provider.previewUrl!;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("preview alive");

    await daemon.close();
    daemon = undefined;
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 20_000);
});
