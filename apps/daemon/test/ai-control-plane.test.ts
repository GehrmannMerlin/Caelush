import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaelushClient, CaelushClientHttpError } from "@caelush/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../src/index.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  daemon = undefined;
  directory = undefined;
});

describe("AI runtime configuration control plane", () => {
  it("connects with a candidate key, preserves the old key on auth failure, and snapshots selection", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-ai-control-plane-"));
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const authorization = request.headers.get("authorization");
      if (authorization === "Bearer invalid-key") {
        return new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (authorization !== "Bearer candidate-key" && authorization !== "Bearer replacement-key") {
        return new Response(JSON.stringify({ error: { message: "unexpected auth" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "deepseek-reasoner" }, { id: "deepseek-chat" }, { id: "deepseek-flash" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      workspacePath: directory,
      port: 0,
      sseHeartbeatIntervalMs: 0,
      environment: {},
      providers: [
        {
          provider: "deepseek",
          baseUrl: "https://fixture.deepseek.local/v1",
          fetch: providerFetch,
        },
      ],
      logger: false,
    });
    const client = new CaelushClient({ baseUrl: daemon.url });

    const before = await client.listAIProviders();
    const deepseekBefore = before.providers.find((provider) => provider.id === "deepseek");
    expect(deepseekBefore).toMatchObject({
      credentialConfigured: false,
      credentialSource: "NONE",
      credentialWritable: true,
      discoveryState: "NOT_CONFIGURED",
    });

    // An unconfigured runtime must still expose a safe empty directory. The
    // Web control plane uses this response together with GET providers to
    // render the connection UI before the first credential is saved.
    await expect(client.getAIModelDirectory()).resolves.toEqual({ models: [] });

    const connected = await client.connectAIProvider("deepseek", { apiKey: "candidate-key" });
    expect(connected.directory.models.map((model) => model.id).sort()).toEqual(
      ["deepseek-reasoner", "deepseek-chat", "deepseek-flash"].sort(),
    );
    expect(JSON.stringify(connected)).not.toContain("candidate-key");
    expect(JSON.stringify(connected)).not.toContain("Authorization");

    const invalid = await client
      .connectAIProvider("deepseek", { apiKey: "invalid-key" })
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(CaelushClientHttpError);
    expect(invalid).toMatchObject({ code: "AI_AUTHENTICATION", status: 401 });
    expect(String((invalid as Error).message)).not.toContain("invalid-key");

    const afterFailedReplace = await client.listAIProviders();
    expect(
      afterFailedReplace.providers.find((provider) => provider.id === "deepseek"),
    ).toMatchObject({
      credentialConfigured: true,
      credentialSource: "LOCAL",
      credentialWritable: true,
    });

    const selection = await client.setDefaultAISelection({
      provider: "deepseek",
      model: "deepseek-flash",
      reasoningLevel: "XHIGH",
    });
    expect(selection.selection).toEqual({
      provider: "deepseek",
      model: "deepseek-flash",
      reasoningLevel: "XHIGH",
    });

    const workspace = (await client.listWorkspaces()).items[0];
    if (workspace === undefined) throw new Error("test workspace was not registered");
    const session = await client.createSession({
      defaultWorkspace: { id: workspace.id, path: directory },
    });
    expect(session.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(session.defaultReasoningLevel).toBe("XHIGH");

    const baseRun = {
      goal: "selection snapshot",
      workspace: { id: workspace.id, path: directory },
      runtime: { id: "local", kind: "local" as const },
      preset: { id: "FULL_ACCESS" as const, expectedVersion: 1 },
      limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 5_000 },
    };
    const firstRun = await client.createRun(session.id, baseRun);
    expect(firstRun.model).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(firstRun.reasoningLevel).toBe("XHIGH");

    const updatedSession = await client.updateSessionModelSelection(session.id, {
      defaultModel: { provider: "deepseek", model: "deepseek-flash" },
      defaultReasoningLevel: "LOW",
    });
    expect(updatedSession.defaultReasoningLevel).toBe("LOW");
    const secondRun = await client.createRun(session.id, baseRun);
    expect(secondRun.reasoningLevel).toBe("LOW");
    expect((await client.getRun(firstRun.id)).reasoningLevel).toBe("XHIGH");

    await client.disconnectAIProvider("deepseek");
    const afterDisconnect = await client.listAIProviders();
    expect(afterDisconnect.providers.find((provider) => provider.id === "deepseek")).toMatchObject({
      credentialConfigured: false,
      credentialSource: "NONE",
      discoveryState: "NOT_CONFIGURED",
    });
    expect(providerFetch).toHaveBeenCalled();
  });
});
