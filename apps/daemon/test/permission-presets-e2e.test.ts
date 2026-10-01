import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type WorkspaceRef } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import {
  LocalRuntime,
  RuntimeFilesystemAccessDeniedError,
  createRuntimeFilesystemPolicy,
} from "@caelush/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let app: ReturnType<typeof buildDaemonApp> | undefined;

const restrictedProvider = {
  id: "fixture-restricted",
  kind: "RESTRICTED" as const,
  enforcement: "HARD" as const,
  create: async () => ({}) as never,
  probe: async () => ({ available: true, enforcement: "HARD" as const }),
};

afterEach(async () => {
  await app?.close().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  app = undefined;
  storage = undefined;
  directory = undefined;
});

async function makeApp(existingStorage?: CaelushStorage) {
  if (existingStorage === undefined) {
    directory = await mkdtemp(join(tmpdir(), "caelush-permission-e2e-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  } else {
    storage = existingStorage;
  }
  app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventHub: { watch: async function* () {} } as never,
    eventNotifier: { notifyCommitted: () => undefined },
    securityCapabilityService: new SecurityCapabilityService({
      processSandboxProviders: [restrictedProvider],
      fullAccessAvailable: true,
    }),
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  });
  return app;
}

async function createSession(currentApp: ReturnType<typeof buildDaemonApp>) {
  const response = await currentApp.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

function runPayload(
  workspace: WorkspaceRef,
  preset: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS",
) {
  return {
    goal: `Exercise ${preset}`,
    workspace,
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "test" },
    preset: { id: preset, expectedVersion: 1 },
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1_000 },
  };
}

describe("permission preset public paths", () => {
  it("advertises exact product mappings and binds each selection to a pending Run", async () => {
    const currentApp = await makeApp();
    const session = await createSession(currentApp);
    const workspace: WorkspaceRef = {
      id: createWorkspaceId(),
      path: directory!,
    };
    const capabilities = await currentApp.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspace.id}/security/capabilities`,
      headers: { host: "127.0.0.1" },
    });

    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().presets).toMatchObject([
      {
        id: "VIEW_ONLY",
        version: 1,
        status: "AVAILABLE",
      },
      {
        id: "WORKSPACE_WRITE",
        version: 1,
        status: "AVAILABLE",
      },
      {
        id: "FULL_ACCESS",
        version: 1,
        status: "AVAILABLE",
      },
    ]);

    const expected = {
      VIEW_ONLY: {
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ON_BOUNDARY",
        filesystemBoundary: "WORKSPACE_READ_ONLY",
        processBoundary: "READ_ONLY",
        requiredEnforcement: "OS_RESTRICTED",
      },
      WORKSPACE_WRITE: {
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "ON_BOUNDARY",
        filesystemBoundary: "WORKSPACE_READ_WRITE",
        processBoundary: "WORKSPACE_WRITE",
        requiredEnforcement: "OS_RESTRICTED",
      },
      FULL_ACCESS: {
        permissionProfile: "FULL_ACCESS",
        approvalPolicy: "NEVER_ASK",
        filesystemBoundary: "HOST_USER_SCOPE",
        processBoundary: "UNRESTRICTED",
        requiredEnforcement: "HARD_SAFETY_ONLY",
      },
    } as const;

    for (const preset of Object.keys(expected) as (keyof typeof expected)[]) {
      const response = await currentApp.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/runs`,
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload: runPayload(workspace, preset),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        status: "PENDING",
        securityPolicy: { preset: { id: preset, version: 1 }, ...expected[preset] },
      });
    }
  });

  it("keeps filesystem effects inside the selected preset boundary", async () => {
    const currentApp = await makeApp();
    const session = await createSession(currentApp);
    const workspacePath = join(directory!, "workspace");
    const outsidePath = join(directory!, "outside");
    const protectedPath = join(directory!, "protected");
    await Promise.all([mkdir(workspacePath), mkdir(outsidePath), mkdir(protectedPath)]);
    await writeFile(join(workspacePath, "inside.txt"), "inside\n", "utf8");
    await writeFile(join(outsidePath, "external.txt"), "external\n", "utf8");
    await writeFile(join(protectedPath, "locked.txt"), "locked\n", "utf8");
    const workspace: WorkspaceRef = { id: createWorkspaceId(), path: workspacePath };
    const createRun = async (preset: "VIEW_ONLY" | "WORKSPACE_WRITE" | "FULL_ACCESS") => {
      const response = await currentApp.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/runs`,
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload: runPayload(workspace, preset),
      });
      expect(response.statusCode).toBe(201);
      return response.json() as {
        securityPolicy: {
          filesystemBoundary: "WORKSPACE_READ_ONLY" | "WORKSPACE_READ_WRITE" | "HOST_USER_SCOPE";
        };
      };
    };
    const runtime = new LocalRuntime();
    try {
      const viewRun = await createRun("VIEW_ONLY");
      const viewScope = await runtime.openWorkspace(workspace, {
        filesystemPolicy: createRuntimeFilesystemPolicy({
          workspaceId: workspace.id,
          workspaceRoot: workspacePath,
          hostUserRoot: directory!,
          boundary: viewRun.securityPolicy.filesystemBoundary,
          protectedRoots: [protectedPath],
        }),
      });
      await expect(
        viewScope.filesystem.readTextFile(join(workspacePath, "inside.txt"), {
          offset: 0,
          limit: 10,
          maxBytes: 1024,
        }),
      ).resolves.toMatchObject({ lines: ["1: inside"] });
      await expect(
        viewScope.patch.apply({
          patch: updatePatch("inside.txt", "inside", "view-mutation"),
        }),
      ).rejects.toBeInstanceOf(RuntimeFilesystemAccessDeniedError);

      const workspaceRun = await createRun("WORKSPACE_WRITE");
      const workspaceScope = await runtime.openWorkspace(workspace, {
        filesystemPolicy: createRuntimeFilesystemPolicy({
          workspaceId: workspace.id,
          workspaceRoot: workspacePath,
          hostUserRoot: directory!,
          boundary: workspaceRun.securityPolicy.filesystemBoundary,
          protectedRoots: [protectedPath],
        }),
      });
      await expect(
        workspaceScope.patch.apply({
          patch: updatePatch("inside.txt", "inside", "workspace-edit"),
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        workspaceScope.patch.apply({
          patch: updatePatch(join(outsidePath, "external.txt"), "external", "outside-edit"),
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));

      const fullRun = await createRun("FULL_ACCESS");
      const fullScope = await runtime.openWorkspace(workspace, {
        filesystemPolicy: createRuntimeFilesystemPolicy({
          workspaceId: workspace.id,
          workspaceRoot: workspacePath,
          hostUserRoot: directory!,
          boundary: fullRun.securityPolicy.filesystemBoundary,
          protectedRoots: [protectedPath],
        }),
      });
      await expect(
        fullScope.patch.apply({
          patch: updatePatch(join(outsidePath, "external.txt"), "external", "published"),
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(readFile(join(outsidePath, "external.txt"), "utf8")).resolves.toBe(
        "published\n",
      );
      await expect(
        fullScope.patch.apply({
          patch: updatePatch(join(protectedPath, "locked.txt"), "locked", "blocked"),
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "PROTECTED_ROOT_MUTATION" }));
    } finally {
      await runtime.dispose();
    }
  });

  it("recovers an immutable policy snapshot after the daemon and Storage restart", async () => {
    const currentApp = await makeApp();
    const session = await createSession(currentApp);
    const workspace: WorkspaceRef = { id: createWorkspaceId(), path: directory! };
    const created = await currentApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: runPayload(workspace, "FULL_ACCESS"),
    });
    expect(created.statusCode).toBe(201);
    const beforeRestart = created.json();
    await currentApp.close();
    app = undefined;
    await storage!.close();
    storage = undefined;

    const reopened = await openCaelushStorage({ path: join(directory!, "caelush.db") });
    const restartedApp = await makeApp(reopened);
    const recovered = await restartedApp.inject({
      method: "GET",
      url: `/api/v1/runs/${beforeRestart.id}`,
      headers: { host: "127.0.0.1" },
    });

    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().securityPolicy).toEqual(beforeRestart.securityPolicy);
    expect(recovered.json().status).toBe("PENDING");
  });
});

function updatePatch(filePath: string, before: string, after: string): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${filePath.replaceAll("\\", "/")}`,
    "@@",
    `-${before}`,
    `+${after}`,
    "*** End Patch",
  ].join("\n");
}
