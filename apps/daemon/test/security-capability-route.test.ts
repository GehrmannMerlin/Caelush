import { describe, expect, it, vi } from "vitest";
import { getPermissionPresetCatalog } from "@caelush/security";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";
import type { WorkspacePreparationPort } from "../src/services/security-capability-service.js";
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

  it("describes restricted execution as unavailable when the runtime sandbox gate is off", async () => {
    const service = new SecurityCapabilityService({
      processSandboxProviders: [provider],
      fullAccessAvailable: true,
      featureGates: {
        permissionPresetsV1: true,
        runtimeSandboxV1: false,
        fullAccessV1: true,
      },
    });

    // `processSandbox` describes restricted execution only. With the sandbox gate off there is no
    // restricted execution to advertise, and Full Access availability must not manufacture one.
    expect(await service.getGlobalCapabilities()).toMatchObject({
      processSandbox: {
        status: "UNAVAILABLE",
        enforcement: "NONE",
        reasonCode: "RUNTIME_SANDBOX_DISABLED",
      },
      workspacePreparationSupported: false,
    });
    expect(await service.getRuntimeFacts()).toMatchObject({
      sandboxProvider: "disabled",
      enforcement: "NONE",
    });
  });
});

const catalog = new Map(getPermissionPresetCatalog().map((preset) => [preset.id, preset]));

function presetSelection(id: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS") {
  return { id, expectedVersion: catalog.get(id)!.version };
}

function restrictedProviderFixture() {
  return {
    id: "fixture-restricted",
    kind: "RESTRICTED" as const,
    enforcement: "PARTIAL" as const,
    create: vi.fn(),
    probe: vi.fn(async () => ({ available: true, enforcement: "PARTIAL" as const })),
  };
}

describe("restricted capability truthfulness", () => {
  it("never reports an ordinary-spawn fallback while Full Access is available", async () => {
    const service = new SecurityCapabilityService({
      processSandboxProviders: [
        {
          ...restrictedProviderFixture(),
          probe: vi.fn(async () => ({
            available: false,
            enforcement: "NONE" as const,
            reasonCode: "RUNNER_HASH_MISMATCH",
          })),
        },
      ],
      fullAccessAvailable: true,
    });

    // The bug this replaces: a failed restricted probe used to be reported as
    // `processSandbox: AVAILABLE/NONE/unrestricted` whenever Full Access was enabled.
    expect(await service.getGlobalCapabilities()).toMatchObject({
      processSandbox: {
        status: "UNAVAILABLE",
        enforcement: "NONE",
        provider: "fixture-restricted",
        reasonCode: "RUNNER_HASH_MISMATCH",
      },
    });

    const workspace = await service.getWorkspaceCapabilities(
      "wsp_00000000-0000-7000-8000-000000000000" as never,
    );
    for (const id of ["VIEW_ONLY", "WORKSPACE_WRITE"] as const) {
      expect(workspace.presets.find((preset) => preset.id === id)).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "RUNNER_HASH_MISMATCH",
      });
    }
    // Full Access availability is derived independently and is not affected.
    expect(workspace.presets.find((preset) => preset.id === "FULL_ACCESS")).toMatchObject({
      status: "AVAILABLE",
    });
  });

  it("reports read-only as ready while workspace-write still requires preparation", async () => {
    const preparation = preparationFixture({
      VIEW_ONLY: "READY",
      WORKSPACE_WRITE: "REQUIRED",
    });
    const service = new SecurityCapabilityService({
      processSandboxProviders: [restrictedProviderFixture()],
      fullAccessAvailable: true,
      workspacePreparation: preparation.port,
    });

    const workspace = await service.getWorkspaceCapabilities(
      "wsp_00000000-0000-7000-8000-000000000000" as never,
    );

    expect(workspace.presets.find((preset) => preset.id === "VIEW_ONLY")).toEqual({
      id: "VIEW_ONLY",
      version: presetSelection("VIEW_ONLY").expectedVersion,
      status: "AVAILABLE",
    });
    expect(workspace.presets.find((preset) => preset.id === "WORKSPACE_WRITE")).toMatchObject({
      status: "PREPARATION_REQUIRED",
      reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
    });
    expect(workspace.presets.find((preset) => preset.id === "FULL_ACCESS")).toMatchObject({
      status: "AVAILABLE",
    });
    expect(workspace.preparation).toMatchObject({
      supported: true,
      status: "REQUIRED",
      reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
    });
  });

  it("reports an unobtainable preparation instead of a usable preset", async () => {
    const preparation = preparationFixture({ VIEW_ONLY: "READY", WORKSPACE_WRITE: "UNAVAILABLE" });
    const service = new SecurityCapabilityService({
      processSandboxProviders: [restrictedProviderFixture()],
      fullAccessAvailable: true,
      workspacePreparation: preparation.port,
    });

    const workspace = await service.getWorkspaceCapabilities(
      "wsp_00000000-0000-7000-8000-000000000000" as never,
    );

    expect(workspace.presets.find((preset) => preset.id === "WORKSPACE_WRITE")).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "WORKSPACE_PREPARATION_UNAVAILABLE",
    });
    expect(workspace.preparation).toMatchObject({
      supported: true,
      status: "UNAVAILABLE",
      reasonCode: "WORKSPACE_PREPARATION_UNAVAILABLE",
    });
  });

  it("reflects a completed preparation on the next capability read", async () => {
    const workspaceId = "wsp_00000000-0000-7000-8000-000000000000" as never;
    let prepared = false;
    const service = new SecurityCapabilityService({
      processSandboxProviders: [restrictedProviderFixture()],
      fullAccessAvailable: true,
      workspacePreparation: {
        supported: true,
        getStatus: async (_workspaceId, preset) =>
          preset.id === "WORKSPACE_WRITE" ? (prepared ? "READY" : "REQUIRED") : "READY",
        prepare: async () => {
          prepared = true;
          return { status: "READY" as const };
        },
      },
    });

    expect(
      (await service.getWorkspaceCapabilities(workspaceId)).presets.find(
        (preset) => preset.id === "WORKSPACE_WRITE",
      ),
    ).toMatchObject({ status: "PREPARATION_REQUIRED" });

    expect(
      await service.prepareWorkspace(workspaceId, presetSelection("WORKSPACE_WRITE")),
    ).toMatchObject({ status: "READY" });

    expect(
      (await service.getWorkspaceCapabilities(workspaceId)).presets.find(
        (preset) => preset.id === "WORKSPACE_WRITE",
      ),
    ).toEqual({
      id: "WORKSPACE_WRITE",
      version: presetSelection("WORKSPACE_WRITE").expectedVersion,
      status: "AVAILABLE",
    });
    expect((await service.getWorkspaceCapabilities(workspaceId)).preparation).toMatchObject({
      status: "READY",
    });
  });
});

function preparationFixture(
  statuses: Partial<
    Record<"VIEW_ONLY" | "WORKSPACE_WRITE", "NOT_REQUIRED" | "REQUIRED" | "READY" | "UNAVAILABLE">
  >,
): { readonly port: WorkspacePreparationPort } {
  return {
    port: {
      supported: true,
      getStatus: async (_workspaceId, preset) =>
        statuses[preset.id as "VIEW_ONLY"] ?? "UNAVAILABLE",
      prepare: async () => ({ status: "READY" as const }),
    },
  };
}
