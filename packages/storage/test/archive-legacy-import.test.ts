import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalRunStatus } from "@caelush/core";
import {
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  SessionIdSchema,
} from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";
const stores: CaelushStorage[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) {
    expect(root.startsWith(join(tmpdir(), "caelush-legacy-proof-"))).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(path = ":memory:") {
  const storage = await openCaelushStorage({
    path,
    archivePolicy: { isTerminalRunStatus },
  });
  stores.push(storage);
  return storage;
}
describe("legacy archive import", () => {
  it("imports an independent legacy marker even while the parent Workspace is archived", async () => {
    const storage = await fixture();
    const id = createWorkspaceId(),
      stamp = createTimestampMs(1);
    await storage.workspaces.insert({
      id,
      canonicalPath: "D:/parent",
      displayName: "parent",
      createdAt: stamp,
      updatedAt: stamp,
      lastOpenedAt: stamp,
    });
    const session = makeSession({ workspaceId: id, defaultWorkspace: { id, path: "D:/parent" } });
    await storage.sessions.insert(session);
    const parent = await storage.archives.archive(
      { type: "WORKSPACE", workspaceId: id },
      createTimestampMs(2),
    );
    const imported = await storage.archives.importLegacyMarkers({
      markers: [{ sessionId: session.id, archivedAt: createTimestampMs(7) }],
    });
    expect(imported.importedSessionIds).toEqual([session.id]);
    await storage.archives.restore(
      { type: "WORKSPACE", workspaceId: id },
      parent.state.ownArchive!.archiveId,
    );
    expect(
      (await storage.archives.getState({ type: "SESSION", sessionId: session.id })).ownArchive,
    ).toMatchObject({ reason: "LEGACY_SESSION_MARKER", archivedAt: 7 });
  });

  it("checks all sibling evidence beyond the first page and keeps ambiguous history isolated after reopen and re-registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-legacy-proof-"));
    roots.push(root);
    const databasePath = join(root, "archive.db");
    let storage = await fixture(databasePath);
    const id = createWorkspaceId(),
      otherId = createWorkspaceId(),
      stamp = createTimestampMs(1);
    const workspace = {
      id,
      canonicalPath: "D:/good",
      displayName: "good",
      createdAt: stamp,
      updatedAt: stamp,
      lastOpenedAt: stamp,
    };
    for (let i = 0; i < 101; i++)
      await storage.sessions.insert(
        makeSession({ workspaceId: id, defaultWorkspace: { id, path: workspace.canonicalPath } }),
      );
    const bad = makeSession({
      id: SessionIdSchema.parse("ses_ffffffff-ffff-7fff-bfff-ffffffffffff"),
      workspaceId: id,
      defaultWorkspace: { id: otherId, path: "D:/other" },
    });
    await storage.sessions.insert(bad);
    await storage.runs.insert(
      makeRun(bad.id, { status: "COMPLETED", workspace: { id: otherId, path: "D:/other" } }),
    );
    const page = await storage.archives.listLegacyArchiveCandidates();
    expect(page.items).toHaveLength(100);
    expect(page.items.some((c) => c.session.id === bad.id)).toBe(false);
    const first = page.items[0]!;
    const entry = {
      sessionId: first.session.id,
      expectedEvidenceDigest: first.evidenceDigest,
      workspace,
    };
    expect((await storage.archives.reconcileLegacyEntries([entry])).deferredSessionIds).toEqual([
      first.session.id,
    ]);
    expect(await storage.workspaces.getById(id)).toBeNull();
    const last = (await storage.archives.listLegacyArchiveCandidates(page.nextCursor)).items.find(
      (c) => c.session.id === bad.id,
    )!;
    await storage.archives.reconcileLegacyEntries([
      { sessionId: bad.id, expectedEvidenceDigest: last.evidenceDigest },
    ]);
    await storage.archives.reconcileLegacyEntries([entry]);
    const parent = await storage.archives.getState({ type: "WORKSPACE", workspaceId: id });
    await storage.archives.restore(parent.target, parent.ownArchive!.archiveId);
    // A later explicit registry re-creation cannot acquire the isolated historical Session.
    await storage.workspaces.remove(id);
    await storage.workspaces.insert({ ...workspace, createdAt: createTimestampMs(2) });
    stores.splice(stores.indexOf(storage), 1);
    await storage.close();
    storage = await fixture(databasePath);
    const state = await storage.archives.getState({ type: "SESSION", sessionId: bad.id });
    expect(state.archived).toBe(true);
    expect(state.parentWorkspace).toBeUndefined();
    expect(state.restoreDisposition).toBe("WORKSPACE_UNAVAILABLE");
    expect(
      (await storage.archives.listSessions({ limit: 100, unassociated: true })).items.map(
        (i) => i.sessionId,
      ),
    ).toEqual([bad.id]);
    await expect(
      storage.archives.restore(state.target, state.ownArchive!.archiveId),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
    await storage.archives.archive({ type: "WORKSPACE", workspaceId: id }, createTimestampMs(3));
    await expect(
      storage.archives.snapshotDeletion({ type: "WORKSPACE", workspaceId: id }),
    ).rejects.toMatchObject({ code: "DATA_OWNERSHIP_CONFLICT" });
    const target = { type: "SESSION" as const, sessionId: bad.id };
    await storage.archives.purge(target, (await storage.archives.snapshotDeletion(target)).digest);
    expect(await storage.sessions.get(bad.id)).toBeNull();
    expect(await storage.workspaces.getById(id)).not.toBeNull();
  });
  it("imports only owned terminal Sessions and preserves the first archive episode", async () => {
    const storage = await fixture();
    const session = makeSession();
    const active = makeSession();
    await storage.sessions.insert(session);
    await storage.sessions.insert(active);
    await storage.runs.insert(makeRun(active.id));
    const foreignId = createSessionId();
    const result = await storage.archives.importLegacyMarkers({
      markers: [
        { sessionId: session.id, archivedAt: createTimestampMs(7) },
        { sessionId: foreignId, archivedAt: null },
        { sessionId: active.id, archivedAt: null },
      ],
    });
    expect(result.importedSessionIds).toEqual([session.id]);
    expect(result.rejected).toEqual([
      { sessionId: foreignId, reason: "NOT_OWNED" },
      { sessionId: active.id, reason: "ACTIVE_RUN_CONFLICT" },
    ]);
    const state = await storage.archives.getState({ type: "SESSION", sessionId: session.id });
    expect(state.ownArchive).toMatchObject({ archivedAt: 7, reason: "LEGACY_SESSION_MARKER" });
    expect(
      (
        await storage.archives.importLegacyMarkers({
          markers: [{ sessionId: session.id, archivedAt: createTimestampMs(99) }],
        })
      ).alreadyArchivedSessionIds,
    ).toEqual([session.id]);
    expect(await storage.archives.getState({ type: "SESSION", sessionId: session.id })).toEqual(
      state,
    );
  });
  it("rechecks evidence and defers active missing-registry histories until terminal", async () => {
    const storage = await fixture();
    const workspaceId = createWorkspaceId();
    const session = makeSession({ workspaceId });
    await storage.sessions.insert(session);
    const run = makeRun(session.id, { workspace: { id: workspaceId, path: "D:/遗留" } });
    await storage.runs.insert(run);
    const first = (await storage.archives.listLegacyArchiveCandidates()).items[0]!;
    expect(first.hasNonTerminalRun).toBe(true);
    expect(
      (
        await storage.archives.reconcileLegacyEntries([
          { sessionId: session.id, expectedEvidenceDigest: first.evidenceDigest },
        ])
      ).deferredSessionIds,
    ).toEqual([session.id]);
    await storage.runs.update({ ...run, status: "COMPLETED" });
    expect(
      (
        await storage.archives.reconcileLegacyEntries([
          { sessionId: session.id, expectedEvidenceDigest: first.evidenceDigest },
        ])
      ).deferredSessionIds,
    ).toEqual([session.id]);
    const next = (await storage.archives.listLegacyArchiveCandidates()).items[0]!;
    expect(
      (
        await storage.archives.reconcileLegacyEntries([
          { sessionId: session.id, expectedEvidenceDigest: next.evidenceDigest },
        ])
      ).migratedSessionIds,
    ).toEqual([session.id]);
    const selection = { type: "SESSION" as const, sessionId: session.id };
    expect((await storage.archives.getState(selection)).ownArchive?.archivedAt).toBeNull();
    await storage.archives.purge(
      selection,
      (await storage.archives.snapshotDeletion(selection)).digest,
    );
    expect((await storage.archives.listLegacyArchiveCandidates()).items).toEqual([]);
  });
  it("never archives a Workspace while an active sibling exists", async () => {
    const storage = await fixture();
    const id = createWorkspaceId();
    const stamp = createTimestampMs(1);
    const one = makeSession({ workspaceId: id });
    const two = makeSession({ workspaceId: id });
    await storage.sessions.insert(one);
    await storage.sessions.insert(two);
    await storage.runs.insert(makeRun(two.id, { workspace: { id, path: "D:/old" } }));
    const candidate = (await storage.archives.listLegacyArchiveCandidates()).items.find(
      (c) => c.session.id === one.id,
    )!;
    const result = await storage.archives.reconcileLegacyEntries([
      {
        sessionId: one.id,
        expectedEvidenceDigest: candidate.evidenceDigest,
        workspace: {
          id,
          canonicalPath: "D:/old",
          displayName: "old",
          createdAt: stamp,
          updatedAt: stamp,
          lastOpenedAt: stamp,
        },
      },
    ]);
    expect(result.deferredSessionIds).toEqual([one.id]);
    expect(await storage.workspaces.getById(id)).toBeNull();
  });
});
