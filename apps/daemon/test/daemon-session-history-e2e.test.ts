import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import type {
  AIAdapterEvent,
  ApiAdapter,
  ApiAdapterStreamInput,
  ResolvedAIModelRequest,
} from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { openCaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import {
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  fixtureBinding,
  fixtureModelSource,
} from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

class TwoTurnProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly normalRequests: ResolvedAIModelRequest[] = [];

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if (
      input.request.messages.some(
        (message) => message.role === "system" && message.content.includes("Review the supplied"),
      )
    ) {
      return this.text(JSON.stringify({ verdict: "PASS", summary: "Accepted." }));
    }
    this.normalRequests.push(input.request);
    const turn = this.normalRequests.length;
    return this.text(turn === 1 ? "first verified answer" : "second verified answer");
  }

  private async *text(value: string): AsyncGenerator<AIAdapterEvent> {
    yield { type: "text.delta", payload: { text: value } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

describe("daemon Session conversation history E2E", () => {
  it("gives the second Run the first verified turn without copying its durable rows", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-session-history-e2e-"));
    const provider = new TwoTurnProvider();
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [provider],
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const workspace = { id: createWorkspaceId(), path: directory };
    const session = await client.createSession({
      defaultWorkspace: workspace,
      defaultModel: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    });

    const first = await createRun(client, session.id, workspace, "first goal");
    await client.startRun(first.id);
    const firstCompleted = await waitForRun(client, first.id, "COMPLETED");
    expect(firstCompleted.finalResult).toMatchObject({
      type: "VERIFIED_COMPLETION",
      text: "first verified answer",
    });

    const second = await createRun(client, session.id, workspace, "second goal");
    await client.startRun(second.id);
    const secondCompleted = await waitForRun(client, second.id, "COMPLETED");
    expect(secondCompleted.sessionId).toBe(session.id);
    expect(secondCompleted.id).not.toBe(first.id);
    expect(secondCompleted.workspace).toEqual(firstCompleted.workspace);

    const secondRequest = provider.normalRequests[1];
    expect(secondRequest).toBeDefined();
    expect(secondRequest!.messages).toContainEqual({ role: "user", content: "first goal" });
    expect(secondRequest!.messages).toContainEqual({
      role: "assistant",
      content: [{ type: "text", text: "first verified answer" }],
    });
    expect(secondRequest!.messages).toContainEqual({ role: "user", content: "second goal" });

    const storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    try {
      const secondConversation = await storage.messages.listByRun(second.id);
      expect(secondConversation.map((entry) => entry.message)).toEqual([
        { role: "user", content: "second goal" },
        { role: "assistant", content: [{ type: "text", text: "second verified answer" }] },
      ]);
    } finally {
      await storage.close();
    }
  }, 20_000);
});

async function createRun(
  client: CaelushClient,
  sessionId: Parameters<CaelushClient["createRun"]>[0],
  workspace: { readonly id: ReturnType<typeof createWorkspaceId>; readonly path: string },
  goal: string,
) {
  return client.createRun(sessionId, {
    goal,
    workspace,
    model: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  });
}

async function waitForRun(
  client: CaelushClient,
  runId: Parameters<CaelushClient["getRun"]>[0],
  status: string,
) {
  let run = await client.getRun(runId);
  for (let attempt = 0; attempt < 200 && run.status !== status; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    run = await client.getRun(runId);
  }
  expect(run.status).toBe(status);
  return run;
}
