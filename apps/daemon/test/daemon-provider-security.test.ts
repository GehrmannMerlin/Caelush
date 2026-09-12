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

    // Phase 2C: the provider model allowlist is enforced by the AI gateway preflight
    // (step 5), not by daemon model canonicalization, so a model outside
    // `allowedModels` is accepted at Run creation and rejected when the Run's first
    // model turn is prepared. The security boundary is unchanged: every rejection
    // still happens before any provider transport, and no credential can appear on a
    // public surface.
    const unknownModelRun = await client.createRun(session.id, {
      ...baseRun,
      model: { provider: "configured", model: "not-allowed" },
    });
    expect(unknownModelRun.status).toBe("PENDING");
    await client.startRun(unknownModelRun.id);
    const unknownModel = await waitForRunStatus(client, unknownModelRun.id, "FAILED");
    expect(JSON.stringify(unknownModel)).not.toContain("provider-secret");
    expect(JSON.stringify(unknownModel)).not.toContain("provider.example");
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

async function waitForRunStatus(
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
