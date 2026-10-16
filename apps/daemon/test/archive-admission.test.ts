import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import { createSessionId, createTimestampMs, createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { RunService } from "../src/services/run-service.js";
import { SessionService } from "../src/services/session-service.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";
import { RunExecutionSupervisor } from "../src/execution/run-execution-supervisor.js";
import { buildDaemonApp } from "../src/app.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

const stores: CaelushStorage[] = [];
afterEach(async () => {
  for (const storage of stores.splice(0)) await storage.close();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const storage = await openCaelushStorage({
    path: ":memory:",
    archivePolicy: { isTerminalRunStatus },
  });
  stores.push(storage);
  const stamp = createTimestampMs(1);
  const workspace = {
    id: createWorkspaceId(),
    canonicalPath: "D:/archive",
    displayName: "archive",
    createdAt: stamp,
    updatedAt: stamp,
    lastOpenedAt: stamp,
  };
  await storage.workspaces.insert(workspace);
  const session = {
    id: createSessionId(),
    workspaceId: workspace.id,
    defaultWorkspace: { id: workspace.id, path: workspace.canonicalPath },
    createdAt: stamp,
    updatedAt: stamp,
    metadata: {},
  };
  await storage.sessions.insert(session);
  return { storage, session, workspace };
}

describe("daemon archive admission", () => {
  it("refuses a late production Session insert after its Workspace was permanently deleted", async () => {
    const { storage, workspace } = await fixture();
    const entered = gate();
    const resume = gate();
    const service = new SessionService({
      repository: storage.sessions,
      archives: storage.archives,
      workspaceService: new WorkspaceService({
        repository: storage.workspaces,
        archives: storage.archives,
      }),
      defaultSelection: async () => {
        entered.release();
        await resume.promise;
        return undefined;
      },
    });
    const creation = service.createSession({ workspaceId: workspace.id, title: "late" });
    await entered.promise;
    const target = { type: "WORKSPACE" as const, workspaceId: workspace.id };
    await storage.archives.archive(target, createTimestampMs(10));
    await storage.archives.purge(target, (await storage.archives.snapshotDeletion(target)).digest);
    resume.release();
    await expect(creation).rejects.toMatchObject({ name: "StorageNotFoundError" });
    expect(await storage.sessions.list()).toEqual([]);
    expect(await storage.workspaces.getById(workspace.id)).toBeNull();
  });
  it("blocks Run creation when archive commits during asynchronous preparation", async () => {
    const { storage, session } = await fixture();
    const entered = gate();
    const resume = gate();
    const service = new RunService({
      sessions: storage.sessions,
      runs: storage.runs,
      archives: storage.archives,
      securityCapabilityService: new SecurityCapabilityService({ fullAccessAvailable: true }),
      contextBudgetPolicyResolver: {
        resolve: async () => {
          entered.release();
          await resume.promise;
          return { version: "ADAPTIVE_V1", outputReserveTokens: 16384, safetyReserveTokens: 4096 };
        },
      },
    });
    const creation = service.createRun(session.id, {
      goal: "run",
      model: { provider: "fixture", model: "model" },
      workspace: session.defaultWorkspace,
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1000 },
    });
    await entered.promise;
    await storage.archives.archive(
      { type: "SESSION", sessionId: session.id },
      createTimestampMs(10),
    );
    resume.release();
    await expect(creation).rejects.toMatchObject({ code: "OBJECT_ARCHIVED" });
    expect(await storage.runs.listBySession(session.id)).toEqual([]);
  });

  it("blocks Session insertion when the parent archives during preparation", async () => {
    const { storage, workspace } = await fixture();
    const entered = gate();
    const resume = gate();
    const service = new SessionService({
      repository: storage.sessions,
      archives: storage.archives,
      defaultSelection: async () => {
        entered.release();
        await resume.promise;
        return undefined;
      },
    });
    const creation = service.createSession({ workspaceId: workspace.id });
    await entered.promise;
    await storage.archives.archive(
      { type: "WORKSPACE", workspaceId: workspace.id },
      createTimestampMs(10),
    );
    resume.release();
    await expect(creation).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    expect(await storage.sessions.listByWorkspace(workspace.id)).toHaveLength(1);
  });

  it("returns active lists while retaining archived history by ID", async () => {
    const { storage, session, workspace } = await fixture();
    const app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      workspaces: storage.workspaces,
      archives: storage.archives,
      workspaceService: new WorkspaceService({
        repository: storage.workspaces,
        archives: storage.archives,
      }),
      eventHub: { watch: async function* () {} } as never,
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15000 },
    });
    try {
      await storage.archives.archive(
        { type: "SESSION", sessionId: session.id },
        createTimestampMs(10),
      );
      const headers = { host: "127.0.0.1" };
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/sessions", headers })).json().items,
      ).toEqual([]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/sessions`,
            headers,
          })
        ).json().items,
      ).toEqual([]);
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}`, headers }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("refuses execution actions on archived terminal Runs", async () => {
    const { storage, session, workspace } = await fixture();
    const service = new RunService({
      sessions: storage.sessions,
      runs: storage.runs,
      archives: storage.archives,
      securityCapabilityService: new SecurityCapabilityService({ fullAccessAvailable: true }),
      contextBudgetPolicyResolver: {
        resolve: async () => ({
          version: "ADAPTIVE_V1",
          outputReserveTokens: 16384,
          safetyReserveTokens: 4096,
        }),
      },
    });
    const run = await service.createRun(session.id, {
      goal: "run",
      workspace: session.defaultWorkspace,
      model: { provider: "fixture", model: "model" },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1000 },
    });
    const runId = run.id;
    await storage.runs.update({ ...run, status: "COMPLETED" });
    await storage.archives.archive(
      { type: "WORKSPACE", workspaceId: workspace.id },
      createTimestampMs(10),
    );
    const supervisor = new RunExecutionSupervisor({
      runs: storage.runs,
      archives: storage.archives,
      controller: {} as never,
    });
    await expect(supervisor.start(runId)).rejects.toMatchObject({ code: "OBJECT_ARCHIVED" });
    await expect(supervisor.recover(runId)).rejects.toMatchObject({ code: "OBJECT_ARCHIVED" });
    await expect(supervisor.continueResourceGuard(runId)).rejects.toMatchObject({
      code: "OBJECT_ARCHIVED",
    });
  });
});
