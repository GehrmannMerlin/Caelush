import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRef, startDaemon } from "../src/index.js";
import type {
  LLMCapabilities,
  LLMProvider,
  LLMProviderCallContext,
  LLMProviderRequest,
  LLMStreamEvent,
  ProviderId,
} from "@caelush/llm";
import type { ModelRef } from "@caelush/protocol";
import { CaelushClient } from "@caelush/client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSessionManager } from "../../web/src/application/session-manager.js";

const capabilities: LLMCapabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "SUPPORTED",
  structuredOutput: "SUPPORTED",
  vision: "UNSUPPORTED",
  reasoningSummary: "UNSUPPORTED",
};

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

class DirectFinalProvider implements LLMProvider {
  readonly id = "web-fixture" as ProviderId;
  calls = 0;

  supportsModel(model: ModelRef): boolean {
    return model.provider === this.id && model.model === "web-fixture-model";
  }

  getCapabilities(): LLMCapabilities {
    return capabilities;
  }

  stream(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
  ): AsyncIterable<LLMStreamEvent> {
    this.calls += 1;
    const isReview = request.messages.some(
      (message) => message.role === "system" && message.content.includes("Review the supplied"),
    );
    return this.text(
      request,
      context,
      isReview
        ? JSON.stringify({ verdict: "PASS", summary: "The candidate is acceptable." })
        : "Verified web result.",
    );
  }

  private async *text(
    request: LLMProviderRequest,
    context: LLMProviderCallContext,
    text: string,
  ): AsyncIterable<LLMStreamEvent> {
    yield {
      type: "stream.start",
      payload: { callId: context.callId, providerId: this.id, model: request.model },
    };
    yield { type: "text.delta", payload: { text } };
    yield { type: "stream.finish", payload: { finishReason: "STOP" } };
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
      providerOverrides: [provider],
      defaultModel: { provider: "web-fixture", model: "web-fixture-model" },
      web: { buildRoot: join(process.cwd(), "apps", "web", "dist"), workspace },
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const indexResponse = await fetch(`${daemon.url}/`);
    expect(indexResponse.status).toBe(200);
    expect(await indexResponse.text()).toContain('id="caelush-bootstrap"');
    const apiResponse = await fetch(`${daemon.url}/api/v1/health`);
    expect(apiResponse.status).toBe(200);
    const info = await client.getInfo();
    const manager = new WebSessionManager({ client, workspace, info });

    await manager.loadSessions();
    manager.beginDraft();
    await expect(manager.submitPrompt("complete the web lifecycle")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    const snapshot = manager.getSnapshot();
    expect(snapshot.selectedSessionId).toBeDefined();
    expect(snapshot.activeRuns).toHaveLength(0);
    expect(snapshot.composerEnabled).toBe(true);
    expect(snapshot.history).toEqual([
      expect.objectContaining({ kind: "USER", text: "complete the web lifecycle" }),
      expect.objectContaining({ kind: "ASSISTANT", text: "Verified web result." }),
    ]);
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
