import { afterEach, describe, expect, it, vi } from "vitest";
import { CaelushClientHttpError } from "@caelush/client";
import { createSessionId, type ArchiveSessionListResponse } from "@caelush/protocol";
import { WebArchiveManager, type ArchivePageClient } from "../src/application/archive-manager.js";
const managers: WebArchiveManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.useRealTimers();
});
const empty: ArchiveSessionListResponse = {
  items: [],
  matchedCount: 0,
  totalCounts: { sessions: 0, workspaces: 0 },
  catalogRevision: 1,
};
function client(): ArchivePageClient {
  return {
    listArchivedSessions: vi.fn(async () => empty),
    listArchivedWorkspaces: vi.fn(async () => empty),
    getArchiveState: vi.fn(),
    restoreSession: vi.fn(),
    restoreWorkspace: vi.fn(),
    previewArchiveDeletion: vi.fn(),
    permanentlyDeleteArchives: vi.fn(),
    getSessionTranscript: vi.fn(async () => ({ items: [] })),
  };
}
describe("archive page manager", () => {
  it("merges page identities and includes Workspace filters from later pages", async () => {
    const api = client();
    const one = {
      sessionId: createSessionId(),
      title: "one",
      group: { key: "one", displayName: "one", matchedCount: 1 },
    } as never;
    const two = {
      sessionId: createSessionId(),
      title: "two",
      group: { key: "two", displayName: "two", matchedCount: 1 },
    } as never;
    api.listArchivedSessions = vi.fn(async (query) =>
      query?.cursor
        ? {
            ...empty,
            items: [one, two],
            matchedCount: 2,
            totalCounts: { sessions: 2, workspaces: 2 },
          }
        : {
            ...empty,
            items: [one],
            matchedCount: 2,
            nextCursor: "second",
            totalCounts: { sessions: 2, workspaces: 2 },
          },
    );
    const manager = new WebArchiveManager(api);
    managers.push(manager);
    await manager.refresh();
    await manager.loadMore();
    await Promise.resolve();
    expect(manager.getSnapshot().sessions?.items).toHaveLength(2);
    expect(manager.getWorkspaceOptions().map((group) => group.key)).toEqual(["one", "two"]);
  });
  it("debounces search 250ms and refreshes only while visible and alive", async () => {
    vi.useFakeTimers();
    let visible = true;
    const api = client();
    const manager = new WebArchiveManager(api, { isVisible: () => visible });
    managers.push(manager);
    await manager.refresh();
    manager.setFilter({ query: "中文 %_" });
    await vi.advanceTimersByTimeAsync(249);
    expect(api.listArchivedSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.listArchivedSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "中文 %_" }),
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(4750);
    expect(api.listArchivedSessions).toHaveBeenCalledTimes(3);
    visible = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.listArchivedSessions).toHaveBeenCalledTimes(3);
    manager.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.listArchivedSessions).toHaveBeenCalledTimes(3);
  });
  it("discards old queries and keeps deletion scopes attached to their tab", async () => {
    const api = client();
    let release!: (value: ArchiveSessionListResponse) => void;
    const slow = new Promise<ArchiveSessionListResponse>((resolve) => {
      release = resolve;
    });
    api.listArchivedSessions = vi.fn(async () => slow);
    const manager = new WebArchiveManager(api);
    managers.push(manager);
    const first = manager.refresh();
    manager.setTab("WORKSPACES");
    await manager.refresh();
    release({ ...empty, matchedCount: 99 });
    await first;
    expect(manager.getSnapshot().tab).toBe("WORKSPACES");
    expect(manager.getSnapshot().sessions).toBeUndefined();
    expect(() => manager.setFilter({ unassociated: true })).toThrow();
  });
  it("requires a new preview after stale or expired confirmation and never changes scope", async () => {
    const api = client();
    const selection = { type: "SESSION_FILTER" as const, filter: { query: "name" } };
    api.previewArchiveDeletion = vi.fn(async () => ({
      counts: { workspaces: 0, sessions: 101, runs: 3 },
      samples: [],
      confirmationToken: "fixed-scope",
      expiresAt: (Date.now() + 600000) as never,
    }));
    api.permanentlyDeleteArchives = vi.fn(async () => {
      throw new CaelushClientHttpError({
        status: 409,
        code: "ARCHIVE_SELECTION_CHANGED",
        message: "stale",
      });
    });
    const manager = new WebArchiveManager(api);
    managers.push(manager);
    await manager.previewDeletion(selection);
    await manager.confirmDeletion();
    expect(api.permanentlyDeleteArchives).toHaveBeenCalledWith(
      { confirmationToken: "fixed-scope" },
      expect.anything(),
    );
    expect(manager.getSnapshot().deletion).toMatchObject({
      selection,
      status: "ERROR",
      preview: undefined,
      error: { code: "ARCHIVE_SELECTION_CHANGED" },
    });
    await manager.confirmDeletion();
    expect(api.permanentlyDeleteArchives).toHaveBeenCalledTimes(1);
  });
  it("opens paged history without restoring or executing anything", async () => {
    const api = client();
    const sessionId = createSessionId();
    api.getArchiveState = vi.fn(async () => ({
      target: { type: "SESSION", sessionId },
      archived: false,
      restoreDisposition: "NOT_ARCHIVED",
    }));
    const manager = new WebArchiveManager(api);
    managers.push(manager);
    await manager.openHistory(sessionId);
    expect(manager.getSnapshot().history?.sessionId).toBe(sessionId);
    expect(api.restoreSession).not.toHaveBeenCalled();
    expect(api.restoreWorkspace).not.toHaveBeenCalled();
    manager.closeHistory();
    expect(manager.getSnapshot().history).toBeUndefined();
  });
});
