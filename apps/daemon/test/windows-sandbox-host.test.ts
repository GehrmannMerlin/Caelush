import { describe, expect, it, vi } from "vitest";
import { getPermissionPresetCatalog } from "@caelush/security";
import { StorageNotFoundError } from "@caelush/storage";
import type {
  NativeWorkspaceSandboxController,
  ProcessSandboxProvider,
  ResolvedSandboxRunnerArtifact,
} from "@caelush/runtime";
import type { WorkspaceId, WorkspaceRecord } from "@caelush/protocol";
import {
  WINDOWS_SANDBOX_PROVIDER_ID,
  createWindowsSandboxHost,
} from "../src/services/windows-sandbox-host.js";

const workspaceId = "wsp_00000000-0000-7000-8000-000000000000" as WorkspaceId;
const workspaceRoot = "C:\\Workspace Fixture";

function workspaceRecord(canonicalPath = workspaceRoot): WorkspaceRecord {
  return {
    id: workspaceId,
    canonicalPath,
    displayName: "fixture",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
}

function workspaceServiceResolving(record: WorkspaceRecord = workspaceRecord()) {
  return { requireWorkspace: vi.fn(async () => record) };
}

function workspaceServiceMissing() {
  return {
    requireWorkspace: vi.fn(async () => {
      throw new StorageNotFoundError("Workspace", workspaceId);
    }),
  };
}

function artifact(): ResolvedSandboxRunnerArtifact {
  return {
    runnerPath: "C:\\bundle\\sandbox-runner\\caelush-sandbox-runner.exe",
    manifestPath: "C:\\bundle\\sandbox-runner\\manifest.json",
    manifest: {
      schemaVersion: 1,
      product: "caelush",
      controlProtocolVersion: 1,
      platform: "windows",
      arch: "x64",
      executableName: "caelush-sandbox-runner.exe",
      sha256: "0".repeat(64),
      providers: ["windows-acl-restricted-token"],
    },
  };
}

function fakeController(overrides: Partial<NativeWorkspaceSandboxController> = {}) {
  const calls: Array<{ operation: string; workspaceRoot: string; presetId: string }> = [];
  const controller: NativeWorkspaceSandboxController = {
    getStatus: async (root, presetId) => {
      calls.push({ operation: "getStatus", workspaceRoot: root, presetId });
      return "REQUIRED";
    },
    prepare: async (root, presetId) => {
      calls.push({ operation: "prepare", workspaceRoot: root, presetId });
      return "READY";
    },
    createRunTemp: (() => Promise.reject(new Error("not used"))) as never,
    cleanupRunTemp: (() => Promise.resolve()) as never,
    ...overrides,
  };
  return { controller, calls };
}

function providerFixture(id = WINDOWS_SANDBOX_PROVIDER_ID): ProcessSandboxProvider {
  return {
    id,
    kind: "RESTRICTED",
    enforcement: "PARTIAL",
    create: vi.fn(),
    probe: vi.fn(async () => ({ available: true, enforcement: "PARTIAL" as const })),
  };
}

const presetById = new Map(getPermissionPresetCatalog().map((preset) => [preset.id, preset]));

describe("windows sandbox host adapter", () => {
  it("composes exactly one restricted provider and one preparation port", () => {
    const { controller } = fakeController();
    const host = createWindowsSandboxHost({
      artifact: artifact(),
      workspaceService: workspaceServiceResolving(),
      platform: "win32",
      createController: () => controller,
    });

    expect(host.providers).toHaveLength(1);
    expect(host.providers[0]?.id).toBe(WINDOWS_SANDBOX_PROVIDER_ID);
    expect(host.providers[0]?.kind).toBe("RESTRICTED");
    expect(host.workspacePreparation.supported).toBe(true);
  });

  it("resolves the workspace root through the workspace authority on every read", async () => {
    const { controller, calls } = fakeController();
    const workspaceService = workspaceServiceResolving();
    const host = createWindowsSandboxHost({
      artifact: artifact(),
      workspaceService,
      platform: "win32",
      createController: () => controller,
    });

    const viewOnly = presetById.get("VIEW_ONLY")!;
    await host.workspacePreparation.getStatus(workspaceId, viewOnly);
    await host.workspacePreparation.prepare(workspaceId, {
      id: "WORKSPACE_WRITE",
      expectedVersion: presetById.get("WORKSPACE_WRITE")!.version,
    });

    expect(workspaceService.requireWorkspace).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { operation: "getStatus", workspaceRoot, presetId: "VIEW_ONLY" },
      { operation: "prepare", workspaceRoot, presetId: "WORKSPACE_WRITE" },
    ]);
  });

  it("never prepares a stale path for a workspace that no longer exists", async () => {
    const { controller, calls } = fakeController();
    const host = createWindowsSandboxHost({
      artifact: artifact(),
      workspaceService: workspaceServiceMissing(),
      platform: "win32",
      createController: () => controller,
    });

    const write = presetById.get("WORKSPACE_WRITE")!;
    expect(await host.workspacePreparation.getStatus(workspaceId, write)).toBe("UNAVAILABLE");
    expect(
      await host.workspacePreparation.prepare(workspaceId, {
        id: "WORKSPACE_WRITE",
        expectedVersion: write.version,
      }),
    ).toMatchObject({ status: "FAILED", reasonCode: "WORKSPACE_NOT_FOUND" });
    expect(calls).toEqual([]);
  });

  it("stays unavailable without an artifact but still starts with one bounded provider", async () => {
    const { controller } = fakeController();
    const host = createWindowsSandboxHost({
      artifact: undefined,
      workspaceService: workspaceServiceResolving(),
      platform: "win32",
      createController: () => controller,
    });

    expect(host.providers).toHaveLength(1);
    expect(host.workspacePreparation.supported).toBe(false);
    expect(
      await host.workspacePreparation.prepare(workspaceId, {
        id: "WORKSPACE_WRITE",
        expectedVersion: presetById.get("WORKSPACE_WRITE")!.version,
      }),
    ).toMatchObject({ status: "UNAVAILABLE", reasonCode: "SANDBOX_RUNNER_UNAVAILABLE" });
  });

  it.skipIf(process.platform !== "win32")(
    "reports a bounded reason instead of an ordinary-spawn fallback without an artifact",
    async () => {
      const host = createWindowsSandboxHost({
        artifact: undefined,
        workspaceService: workspaceServiceResolving(),
        platform: "win32",
      });

      const probe = await host.providers[0]!.probe!();
      expect(probe.available).toBe(false);
      expect(probe.enforcement).toBe("NONE");
      expect(probe.reasonCode).toBe("RUNNER_ARTIFACT_MISSING");
    },
  );

  it("uses the injected provider override instead of the production composition", () => {
    const { controller } = fakeController();
    const injected = providerFixture("injected-windows-provider");
    const createProvider = vi.fn(() => injected);
    const host = createWindowsSandboxHost({
      artifact: artifact(),
      workspaceService: workspaceServiceResolving(),
      platform: "win32",
      createController: () => controller,
      createProvider,
    });

    expect(host.providers[0]).toBe(injected);
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceController: controller }),
    );
  });

  it("composes no Windows provider on a host that is not Windows", () => {
    const host = createWindowsSandboxHost({
      artifact: artifact(),
      workspaceService: workspaceServiceResolving(),
      platform: "linux",
    });

    expect(host.providers).toEqual([]);
    expect(host.workspacePreparation.supported).toBe(false);
  });
});
