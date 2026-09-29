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
  it("loads, persists, expands, and selects Workspace-scoped Session summaries", async () => {
    const first = workspace("first");
    const second = workspace("second");
    const client = {
      listWorkspaces: vi.fn(async () => ({ items: [first, second] })),
      listWorkspaceSessions: vi.fn(async () => ({ items: [] })),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
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
      expandedWorkspaceIds: [second.id],
    });
    expect(client.listWorkspaceSessions).toHaveBeenCalledWith(second.id);

    manager.toggleWorkspaceExpanded(first.id);
    expect(manager.getSnapshot().expandedWorkspaceIds).toContain(first.id);
    await manager.selectWorkspace(first.id);
    expect(manager.getSnapshot().selectedWorkspaceId).toBe(first.id);
    expect(storage.get("caelush:selected-workspace")).toContain(first.id);
  });

  it("registers a Workspace, selects it, and reloads its summaries", async () => {
    const first = workspace("first");
    const created = workspace("created");
    const client = {
      listWorkspaces: vi.fn(async () => ({ items: [first, created] })),
      listWorkspaceSessions: vi.fn(async () => ({ items: [] })),
      createWorkspace: vi.fn(async () => created),
      deleteWorkspace: vi.fn(),
    };
    const manager = new WebWorkspaceManager({ client });

    await manager.loadWorkspaces();
    await expect(manager.registerWorkspace("D:/workspace/created")).resolves.toEqual(created);
    expect(manager.getSnapshot()).toMatchObject({
      selectedWorkspaceId: created.id,
      expandedWorkspaceIds: [created.id],
    });
    expect(client.createWorkspace).toHaveBeenCalledWith({ path: "D:/workspace/created" });
  });

  it("delegates native folder selection without registering a workspace", async () => {
    const client = {
      listWorkspaces: vi.fn(async () => ({ items: [] })),
      listWorkspaceSessions: vi.fn(async () => ({ items: [] })),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
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
