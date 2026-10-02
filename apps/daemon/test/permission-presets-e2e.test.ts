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
import {
  HOST_HEADERS,
  JSON_HEADERS,
  createSession,
  prepareHarness,
  restrictedProvider,
  runPayload,
  trackFixtures,
} from "./support/permission-flow-fixture.js";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let app: ReturnType<typeof buildDaemonApp> | undefined;
const fixtures = trackFixtures();

afterEach(async () => {
  await app?.close().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  await fixtures.closeAll();
  app = undefined;
  storage = undefined;
  directory = undefined;
});

/**
 * The legacy unregistered-Workspace composition: a Daemon with no `WorkspaceService`, which is what
 * the pre-registry public paths still allow. The registered composition used by the prepared flow
 * lives in the shared fixture.
 */
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
      headers: HOST_HEADERS,
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
        headers: JSON_HEADERS,
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
        headers: JSON_HEADERS,
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
      headers: JSON_HEADERS,
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
      headers: HOST_HEADERS,
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

describe("prepared Windows permission flow", () => {
  it("refuses a Run until the workspace is prepared, then accepts it after prepare", async () => {
    const harness = prepareHarness();
    const { app: currentApp, workspace } = await fixtures.create({
      workspacePreparation: harness.port,
    });
    // A workspace-bound daemon requires the session to name its workspace; that is the point of the
    // prepared flow, so the harness creates the session the way the Web client does.
    const session = await createSession(currentApp, { workspaceId: workspace.id });
    const capabilitiesUrl = `/api/v1/workspaces/${workspace.id}/security/capabilities`;

    const before = await currentApp.inject({
      method: "GET",
      url: capabilitiesUrl,
      headers: HOST_HEADERS,
    });
    expect(before.statusCode).toBe(200);
    // Read-only needs no preparation, workspace-write does, and Full Access stays independent.
    expect(before.json().presets).toMatchObject([
      { id: "VIEW_ONLY", version: 1, status: "AVAILABLE" },
      {
        id: "WORKSPACE_WRITE",
        version: 1,
        status: "PREPARATION_REQUIRED",
        reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
      },
      { id: "FULL_ACCESS", version: 1, status: "AVAILABLE" },
    ]);
    expect(before.json().preparation).toMatchObject({ supported: true, status: "REQUIRED" });

    // The server is authoritative: a client that skips the disabled state cannot create the Run.
    const tooEarly = await currentApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: JSON_HEADERS,
      payload: runPayload(workspace, "WORKSPACE_WRITE"),
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toMatchObject({ code: "CONFLICT" });
    expect(tooEarly.json().error.message).toMatch(/preparation/i);

    // Read-only is already usable and is not blocked by the workspace-write requirement.
    const viewRun = await currentApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: JSON_HEADERS,
      payload: runPayload(workspace, "VIEW_ONLY"),
    });
    expect(viewRun.statusCode).toBe(201);

    const preparation = await currentApp.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/security/prepare`,
      headers: JSON_HEADERS,
      payload: { preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 } },
    });
    expect(preparation.statusCode).toBe(200);
    expect(preparation.json()).toMatchObject({
      workspaceId: workspace.id,
      preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      status: "READY",
    });

    const after = await currentApp.inject({
      method: "GET",
      url: capabilitiesUrl,
      headers: HOST_HEADERS,
    });
    expect(after.json().presets).toMatchObject([
      { id: "VIEW_ONLY", version: 1, status: "AVAILABLE" },
      { id: "WORKSPACE_WRITE", version: 1, status: "AVAILABLE" },
      { id: "FULL_ACCESS", version: 1, status: "AVAILABLE" },
    ]);
    expect(after.json().preparation).toMatchObject({ supported: true, status: "READY" });

    const created = await currentApp.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/runs`,
      headers: JSON_HEADERS,
      payload: runPayload(workspace, "WORKSPACE_WRITE"),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: "PENDING",
      securityPolicy: { preset: { id: "WORKSPACE_WRITE", version: 1 } },
    });
  });
});
