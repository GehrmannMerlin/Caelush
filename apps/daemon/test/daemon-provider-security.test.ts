import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import { CaelushClient, CaelushClientHttpError } from "@caelush/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../src/index.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  daemon = undefined;
});

describe("daemon provider and public model boundary", () => {
  it("rejects client endpoints before provider fetch and keeps credentials out of public surfaces", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-provider-security-"));
    const providerFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("provider transport must not be called");
    });
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      providers: [
        {
          provider: "configured",
          baseUrl: "https://provider.example/v1",
          apiKey: "provider-secret",
          allowedModels: ["allowed-model"],
          fetch: providerFetch,
        },
      ],
      defaultModel: { provider: "configured", model: "allowed-model" },
    });
    const client = new CaelushClient({ baseUrl: daemon.url });
    const info = await client.getInfo();
    expect(info).toMatchObject({
      configuredProviders: ["configured"],
      defaultModel: { provider: "configured", model: "allowed-model" },
    });
    expect(JSON.stringify(info)).not.toContain("provider-secret");
    expect(JSON.stringify(info)).not.toContain("provider.example");

    const maliciousSession = await fetch(`${daemon.url}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        defaultModel: {
          provider: "configured",
          model: "allowed-model",
          baseUrl: "https://attacker.example/v1",
        },
      }),
    });
    expect(maliciousSession.status).toBe(400);
    expect(await maliciousSession.text()).not.toContain("attacker.example");
    expect(providerFetch).not.toHaveBeenCalled();

    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "configured", model: "allowed-model" },
    });
    expect(session.defaultModel).toEqual({ provider: "configured", model: "allowed-model" });
    expect(JSON.stringify(session)).not.toContain("provider.example");

    const baseRun = {
      goal: "inspect",
      workspace: { id: createWorkspaceId(), path: directory },
      runtime: { id: "local", kind: "local" as const },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "NEVER_ASK" as const,
      limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 5_000 },
    };
    await expect(
      client.createRun(session.id, {
        ...baseRun,
        model: {
          provider: "configured",
          model: "allowed-model",
          baseUrl: "https://attacker.example/v1",
        } as never,
      }),
    ).rejects.toThrow();
    expect(providerFetch).not.toHaveBeenCalled();

    const unknownProvider = await client
      .createRun(session.id, {
        ...baseRun,
        model: { provider: "unknown", model: "allowed-model" },
      })
      .catch((error: unknown) => error);
    expect(unknownProvider).toBeInstanceOf(CaelushClientHttpError);
    expect(unknownProvider).toMatchObject({
      status: 409,
      code: "MODEL_PROVIDER_UNAVAILABLE",
    });
    expect(String((unknownProvider as Error).message)).not.toContain("provider-secret");

    const unknownModel = await client
      .createRun(session.id, {
        ...baseRun,
        model: { provider: "configured", model: "not-allowed" },
      })
      .catch((error: unknown) => error);
    expect(unknownModel).toBeInstanceOf(CaelushClientHttpError);
    expect(unknownModel).toMatchObject({
      status: 409,
      code: "MODEL_PROVIDER_UNAVAILABLE",
    });
    expect(JSON.stringify(unknownModel)).not.toContain("provider-secret");
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
