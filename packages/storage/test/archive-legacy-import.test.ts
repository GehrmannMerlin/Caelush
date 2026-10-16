import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import { createSessionId, createTimestampMs, createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";
const stores: CaelushStorage[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
async function fixture() {
  const storage = await openCaelushStorage({
    path: ":memory:",
    archivePolicy: { isTerminalRunStatus },
  });
  stores.push(storage);
  return storage;
}
describe("legacy archive import", () => {
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
