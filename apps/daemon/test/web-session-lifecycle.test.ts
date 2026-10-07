import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRef, startDaemon } from "../src/index.js";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSessionManager } from "../../web/src/application/session-manager.js";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./support/ai-fixture.js";
import { restrictedProvider } from "./support/permission-flow-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

/** Keep this lifecycle test on the compatibility model selection path. */
function withoutAIControlPlane(client: CaelushClient): CaelushClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (
        property === "listAIProviders" ||
        property === "getAIModelDirectory" ||
        property === "getDefaultAISelection"
      ) {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class DirectFinalProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  calls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.calls += 1;
    const isReview = input.request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.text(
      isReview
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "Verified web result.",
    );
  }

  private async *text(text: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("Web Session model production lifecycle", () => {
  it("drives a real daemon Run to VerifiedRunFinalResult", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-web-session-"));
    const workspace = createWorkspaceRef(directory);
    const provider = new DirectFinalProvider();
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
      processSandboxProviders: [restrictedProvider],
      web: { buildRoot: join(process.cwd(), "apps", "web", "dist"), workspace },
    });
    const client = withoutAIControlPlane(new CaelushClient({ baseUrl: daemon.url }));
    const indexResponse = await fetch(`${daemon.url}/`);
    expect(indexResponse.status).toBe(200);
    expect(await indexResponse.text()).toContain('id="caelush-bootstrap"');
    const apiResponse = await fetch(`${daemon.url}/api/v1/health`);
    expect(apiResponse.status).toBe(200);
    const info = await client.getInfo();
    const manager = new WebSessionManager({ client, workspace, info });

    await manager.loadSessions();
    manager.beginDraft();
    const submitted = await manager.submitPrompt("complete the web lifecycle");
    expect(
      submitted,
      JSON.stringify({
        error: manager.getSnapshot().error,
        selectedPreset: manager.getSnapshot().selectedPreset,
        availablePresets: manager.getSnapshot().availablePresets,
        submission: manager.getSnapshot().submission,
        selectedSession: manager.getSnapshot().selectedSession?.id,
      }),
    ).toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    const snapshot = manager.getSnapshot();
    expect(snapshot.selectedSessionId).toBeDefined();
    expect(snapshot.activeRuns).toHaveLength(0);
    expect(snapshot.composerEnabled).toBe(true);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "USER", text: "complete the web lifecycle" }),
        expect.objectContaining({ kind: "ASSISTANT", text: "Verified web result." }),
      ]),
    );
    expect(snapshot.history.some((entry) => entry.text.includes("raw"))).toBe(false);
    expect(provider.calls).toBe(2);

    manager.dispose();
  }, 20_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
