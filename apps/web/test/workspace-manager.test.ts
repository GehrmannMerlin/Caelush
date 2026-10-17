import { describe, expect, it, vi } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  WebWorkspaceManager,
  WorkspaceSelectionStore,
} from "../src/application/workspace-manager.js";

function workspace(name: string) {
  const id = createWorkspaceId();
  return {
    id,
    canonicalPath: `D:/workspace/${name}`,
    displayName: name,
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 2,
  };
}

describe("WebWorkspaceManager", () => {
  it("archives through the authoritative API and preserves a rejected Workspace", async () => {
    const target = workspace("archive");
    let reject = true;
    let items = [target];
    const client = {
      listWorkspaces: async () => ({ items }),
      listWorkspaceSessions: async () => ({ items: [] }),
      createWorkspace: vi.fn(),
      archiveWorkspace: async () => {
        if (reject) throw new Error("rejected");
        items = [];
        return {} as never;
      },
    };
    const manager = new WebWorkspaceManager({ client });
    await manager.loadWorkspaces();
    await expect(manager.archiveWorkspace(target.id)).rejects.toThrow();
    expect(manager.getSnapshot().workspaces).toEqual([target]);
    reject = false;
    await manager.archiveWorkspace(target.id);
    expect(manager.getSnapshot().workspaces).toEqual([]);
  });
  it("discards a superseded Workspace response", async () => {
    const target = workspace("stale");
    let release!: (response: { items: (typeof target)[] }) => void;
    let calls = 0;
    const delayed = new Promise<{ items: (typeof target)[] }>((resolve) => {
      release = resolve;
    });
    const manager = new WebWorkspaceManager({
      client: {
        listWorkspaces: async () => (++calls === 1 ? delayed : { items: [] }),
        listWorkspaceSessions: async () => ({ items: [] }),
        createWorkspace: vi.fn(),
        archiveWorkspace: vi.fn(),
      },
    });
    const old = manager.loadWorkspaces();
    await manager.loadWorkspaces();
    release({ items: [target] });
    await old;
    expect(manager.getSnapshot().workspaces).toEqual([]);
  });
  it("keeps selected Workspaces without Session history collapsed unless explicitly expanded", async () => {
    const first = workspace("first");
    const second = workspace("second");
    const client = {
      listWorkspaces: vi.fn(async () => ({ items: [first, second] })),
      listWorkspaceSessions: vi.fn(async () => ({ items: [] })),
      createWorkspace: vi.fn(),
      archiveWorkspace: vi.fn(),
    };
    const storage = new Map<string, string>();
    const manager = new WebWorkspaceManager({
      client,
      selectionStore: new WorkspaceSelectionStore(storage),
      initialWorkspaceId: second.id,
    });

    await manager.loadWorkspaces();
    expect(manager.getSnapshot()).toMatchObject({
      status: "READY",
      selectedWorkspaceId: second.id,
      expandedWorkspaceIds: [],
    });
    expect(client.listWorkspaceSessions).toHaveBeenCalledWith(second.id);

    manager.expandWorkspace(first.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).toContain(first.id);
    manager.toggleWorkspaceExpanded(first.id);
    await manager.selectWorkspace(first.id);
    expect(manager.getSnapshot().selectedWorkspaceId).toBe(first.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).not.toContain(first.id);

    await manager.loadWorkspaces();
    expect(manager.getSnapshot().selectedWorkspaceId).toBe(first.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).not.toContain(first.id);

    manager.expandWorkspace(first.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).toContain(first.id);
    await manager.loadWorkspaces();
    expect(manager.getSnapshot().expandedWorkspaceIds).toContain(first.id);
    expect(storage.get("caelush:selected-workspace")).toContain(first.id);
  });

  it("still auto-expands the selected Workspace when Session history exists", async () => {
    const first = workspace("first");
    const second = workspace("second");
    const history = { session: { id: "session-1" }, lastActivityAt: 1 } as never;
    const manager = new WebWorkspaceManager({
      client: {
        listWorkspaces: async () => ({ items: [first, second] }),
        listWorkspaceSessions: async (workspaceId) => ({
          items: workspaceId === second.id ? [history] : [],
        }),
        createWorkspace: vi.fn(),
        archiveWorkspace: vi.fn(),
      },
    });

    await manager.loadWorkspaces();
    expect(manager.getSnapshot().expandedWorkspaceIds).not.toContain(first.id);

    await manager.selectWorkspace(second.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).toContain(second.id);
  });

  it("expands an empty Workspace when selection is part of starting a Session", async () => {
    const selected = workspace("selected");
    const target = workspace("new-session");
    const manager = new WebWorkspaceManager({
      client: {
        listWorkspaces: async () => ({ items: [selected, target] }),
        listWorkspaceSessions: async () => ({ items: [] }),
        createWorkspace: vi.fn(),
        archiveWorkspace: vi.fn(),
      },
    });

    await manager.loadWorkspaces();
    expect(manager.getSnapshot().expandedWorkspaceIds).not.toContain(target.id);

    await manager.selectWorkspace(target.id, { expand: true });
    expect(manager.getSnapshot().selectedWorkspaceId).toBe(target.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).toContain(target.id);
  });

  it("registers a Workspace, selects it, and reloads its summaries", async () => {
    const first = workspace("first");
    const created = workspace("created");
    const client = {
      listWorkspaces: vi.fn(async () => ({ items: [first, created] })),
      listWorkspaceSessions: vi.fn(async () => ({ items: [] })),
      createWorkspace: vi.fn(async () => created),
      archiveWorkspace: vi.fn(),
    };
    const manager = new WebWorkspaceManager({ client });

    await manager.loadWorkspaces();
    await expect(manager.registerWorkspace("D:/workspace/created")).resolves.toEqual(created);
    expect(manager.getSnapshot()).toMatchObject({
      selectedWorkspaceId: created.id,
    });
    expect(manager.getSnapshot().expandedWorkspaceIds).not.toContain(created.id);
    expect(client.createWorkspace).toHaveBeenCalledWith({ path: "D:/workspace/created" });
  });

  it("delegates native folder selection without registering a workspace", async () => {
    const client = {
      listWorkspaces: vi.fn(async () => ({ items: [] })),
      listWorkspaceSessions: vi.fn(async () => ({ items: [] })),
      createWorkspace: vi.fn(),
      archiveWorkspace: vi.fn(),
      pickWorkspaceDirectory: vi.fn(async () => ({
        status: "SELECTED" as const,
        path: "D:/workspace/selected",
      })),
    };
    const manager = new WebWorkspaceManager({ client });

    await expect(manager.pickWorkspaceDirectory()).resolves.toEqual({
      status: "SELECTED",
      path: "D:/workspace/selected",
    });
    expect(client.createWorkspace).not.toHaveBeenCalled();
  });
});
