import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunSchema,
  AgentSessionSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
} from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { expandPermissionPreset } from "@caelush/security";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { backfillSessionWorkspaceOwnership } from "../src/workspaces/workspace-backfill.js";

let storage: CaelushStorage | undefined;
let root: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createFixture() {
  root = await mkdtemp(join(tmpdir(), "caelush-workspace-backfill-"));
  storage = await openCaelushStorage({ path: join(root, "caelush.db") });
  const service = new WorkspaceService({
    repository: storage.workspaces,
    sessions: storage.sessions,
    runs: storage.runs,
    now: () => 100,
  });
  const other = await mkdtemp(join(root, "other-"));
  return { service, workspace: root, other };
}

function session(defaultWorkspace?: { id: ReturnType<typeof createWorkspaceId>; path: string }) {
  return AgentSessionSchema.parse({
    id: createSessionId(),
    ...(defaultWorkspace === undefined ? {} : { defaultWorkspace }),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  });
}

function run(sessionId: ReturnType<typeof createSessionId>, workspace: string) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId,
    goal: "legacy run",
    status: "COMPLETED",
    workspace: { id: createWorkspaceId(), path: workspace },
    model: { provider: "test", model: "test" },
    runtime: { id: "local", kind: "test" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    securityPolicy: expandPermissionPreset({
      presetId: "VIEW_ONLY",
      expectedVersion: 1,
      createdAt: new Date(1).toISOString(),
    }),
    limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1000 },
    createdAt: 1,
    finishedAt: 2,
  });
}

describe("deterministic Session Workspace backfill", () => {
  it("binds legacy defaultWorkspace through the Registry canonical ref", async () => {
    const fixture = await createFixture();
    const legacy = session({ id: createWorkspaceId(), path: fixture.workspace });
    await storage!.sessions.insert(legacy);

    const report = await backfillSessionWorkspaceOwnership({
      sessions: storage!.sessions,
      runs: storage!.runs,
      workspaceService: fixture.service,
    });
    const rebound = await storage!.sessions.get(legacy.id);
    expect(report).toMatchObject({ bound: 1, unbound: 0, ambiguous: 0 });
    expect(rebound).toMatchObject({ workspaceId: expect.any(String) });
    expect(rebound?.defaultWorkspace?.path).toBe(
      fixture.workspace.replaceAll("\\", "/").toLowerCase(),
    );
  });

  it("binds a legacy Session when all Runs identify one Workspace", async () => {
    const fixture = await createFixture();
    const legacy = session();
    await storage!.sessions.insert(legacy);
    await storage!.runs.insert(run(legacy.id, fixture.workspace));

    const report = await backfillSessionWorkspaceOwnership({
      sessions: storage!.sessions,
      runs: storage!.runs,
      workspaceService: fixture.service,
    });
    expect(report.bound).toBe(1);
    expect((await storage!.sessions.get(legacy.id))?.workspaceId).toBeTruthy();
  });

  it("leaves ambiguous legacy Sessions unbound instead of guessing", async () => {
    const fixture = await createFixture();
    const legacy = session();
    await storage!.sessions.insert(legacy);
    await storage!.runs.insert(run(legacy.id, fixture.workspace));
    await storage!.runs.insert(run(legacy.id, fixture.other));

    const report = await backfillSessionWorkspaceOwnership({
      sessions: storage!.sessions,
      runs: storage!.runs,
      workspaceService: fixture.service,
    });
    expect(report).toMatchObject({ bound: 0, unbound: 0, ambiguous: 1 });
    expect((await storage!.sessions.get(legacy.id))?.workspaceId).toBeUndefined();
  });
});
