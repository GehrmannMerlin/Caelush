import { describe, expect, it } from "vitest";
import { createSessionId, createWorkspaceId } from "@caelush/protocol";
import {
  PermissionPresetSelectionStore,
  SessionSelectionStore,
} from "../src/application/session-persistence.js";

describe("SessionSelectionStore", () => {
  it("stores only a schema-valid member SessionId and drops invalid or non-member values", () => {
    const storage = new Map<string, string>();
    const store = new SessionSelectionStore(storage);
    const workspace = createWorkspaceId();
    const member = createSessionId();
    store.setCandidates(workspace, [member]);

    store.write(workspace, member);
    expect(store.read(workspace)).toBe(member);
    store.write(workspace, "not-a-session-id");
    expect(store.read(workspace)).toBeUndefined();
    storage.set(`caelush:selected-session:${workspace}`, JSON.stringify(createSessionId()));
    expect(store.read(workspace)).toBeUndefined();
    expect(
      [...storage.values()].some((value) => value.includes("Timeline") || value.includes("Run")),
    ).toBe(false);
  });

  it("isolates selections by WorkspaceId even when paths match", () => {
    const storage = new Map<string, string>();
    const store = new SessionSelectionStore(storage);
    const workspaceA = createWorkspaceId();
    const workspaceB = createWorkspaceId();
    const memberA = createSessionId();
    const memberB = createSessionId();
    store.setCandidates(workspaceA, [memberA]);
    store.setCandidates(workspaceB, [memberB]);

    store.write(workspaceA, memberA);
    store.write(workspaceB, memberB);

    expect(store.read(workspaceA)).toBe(memberA);
    expect(store.read(workspaceB)).toBe(memberB);
    expect(storage.has(`caelush:selected-session:${workspaceA}`)).toBe(true);
    expect(storage.has(`caelush:selected-session:${workspaceB}`)).toBe(true);
  });
});

describe("PermissionPresetSelectionStore", () => {
  it("persists only the server-owned preset identity and version", () => {
    const storage = new Map<string, string>();
    const store = new PermissionPresetSelectionStore(storage);
    const workspace = createWorkspaceId();
    const selection = { id: "FULL_ACCESS" as const, expectedVersion: 1 };

    store.write(workspace, selection);

    expect(store.read(workspace)).toEqual(selection);
    const raw = storage.get(`caelush:selected-permission-preset:${workspace}`);
    expect(raw).toBe(JSON.stringify(selection));
    expect(raw).not.toContain("permissionProfile");
    expect(raw).not.toContain("approvalPolicy");
  });

  it("drops malformed or stale selections instead of promoting them", () => {
    const storage = new Map<string, string>();
    const store = new PermissionPresetSelectionStore(storage);
    const workspace = createWorkspaceId();
    const key = `caelush:selected-permission-preset:${workspace}`;

    storage.set(key, JSON.stringify({ id: "LEGACY_CUSTOM", expectedVersion: 1 }));
    expect(store.read(workspace)).toBeUndefined();
    expect(storage.has(key)).toBe(false);

    storage.set(key, "not-json");
    expect(store.read(workspace)).toBeUndefined();
    expect(storage.has(key)).toBe(false);
  });
});
