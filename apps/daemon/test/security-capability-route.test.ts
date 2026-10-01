import { describe, expect, it, vi } from "vitest";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";
import { buildDaemonApp } from "../src/app.js";

const provider = {
  id: "fixture-restricted",
  kind: "RESTRICTED" as const,
  enforcement: "HARD" as const,
  create: vi.fn(),
  probe: vi.fn(async () => ({ available: true, enforcement: "HARD" as const })),
};

function makeService() {
  return new SecurityCapabilityService({
    processSandboxProviders: [provider],
    fullAccessAvailable: true,
    ttySupported: false,
  });
}

function makeApp(service: SecurityCapabilityService) {
  return buildDaemonApp({
    sessions: {} as never,
    runs: {} as never,
    eventHub: { watch: async function* () {} } as never,
    securityCapabilityService: service,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  });
}

describe("security capability routes", () => {
  it("advertises all preset descriptors and verified sandbox enforcement", async () => {
    const service = makeService();
    const app = makeApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/security/capabilities",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      defaultPreset: "WORKSPACE_WRITE",
      ttySupported: false,
      workspacePreparationSupported: false,
      processSandbox: {
        status: "AVAILABLE",
        enforcement: "HARD",
        provider: "fixture-restricted",
      },
    });
    expect(response.json().presets.map((preset: { id: string }) => preset.id)).toEqual([
      "VIEW_ONLY",
      "WORKSPACE_WRITE",
      "FULL_ACCESS",
    ]);
    await app.close();
  });

  it("reports a provider failure as unavailable and never implies ordinary-spawn fallback", async () => {
    const service = new SecurityCapabilityService({
      processSandboxProviders: [
        {
          ...provider,
          probe: vi.fn(async () => ({
            available: false,
            enforcement: "NONE" as const,
            reasonCode: "RUNNER_HASH_MISMATCH",
          })),
        },
      ],
      fullAccessAvailable: false,
    });
    const app = makeApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/security/capabilities",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().processSandbox).toMatchObject({
      status: "UNAVAILABLE",
      enforcement: "NONE",
      reasonCode: "RUNNER_HASH_MISMATCH",
    });
    const workspaceResponse = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces/wsp_00000000-0000-7000-8000-000000000000/security/capabilities",
      headers: { host: "127.0.0.1" },
    });
    expect(workspaceResponse.statusCode).toBe(200);
    expect(
      workspaceResponse.json().presets.find((preset: { id: string }) => preset.id === "VIEW_ONLY"),
    ).toMatchObject({ status: "UNAVAILABLE", reasonCode: "RUNNER_HASH_MISMATCH" });
    await app.close();
  });

  it("disables only the capabilities selected by host rollout gates", async () => {
    const service = new SecurityCapabilityService({
      processSandboxProviders: [provider],
      fullAccessAvailable: true,
      featureGates: {
        permissionPresetsV1: true,
        runtimeSandboxV1: false,
        fullAccessV1: true,
      },
    });
    const response = await service.getWorkspaceCapabilities(
      "wsp_00000000-0000-7000-8000-000000000000" as never,
    );

    expect(response.presets.find((preset) => preset.id === "VIEW_ONLY")).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "RUNTIME_SANDBOX_DISABLED",
    });
    expect(response.presets.find((preset) => preset.id === "WORKSPACE_WRITE")).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "RUNTIME_SANDBOX_DISABLED",
    });
    expect(response.presets.find((preset) => preset.id === "FULL_ACCESS")).toMatchObject({
      status: "AVAILABLE",
    });
  });
});
