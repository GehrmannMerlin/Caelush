import { describe, expect, it } from "vitest";
import {
  expandPermissionPreset,
  getPermissionPresetCatalog,
  verifyPolicyDigest,
} from "../src/index.js";

describe("permission preset catalog", () => {
  it("publishes exactly the three selectable product presets", () => {
    expect(getPermissionPresetCatalog().map((preset) => preset.id)).toEqual([
      "VIEW_ONLY",
      "WORKSPACE_WRITE",
      "FULL_ACCESS",
    ]);
    expect(getPermissionPresetCatalog().map((preset) => preset.version)).toEqual([1, 1, 1]);
  });

  it.each([
    ["VIEW_ONLY", "READ_ONLY", "ON_BOUNDARY", "WORKSPACE_READ_ONLY", "READ_ONLY"],
    ["WORKSPACE_WRITE", "PROJECT_ACCESS", "ON_BOUNDARY", "WORKSPACE_READ_WRITE", "WORKSPACE_WRITE"],
    ["FULL_ACCESS", "FULL_ACCESS", "NEVER_ASK", "HOST_USER_SCOPE", "UNRESTRICTED"],
  ] as const)(
    "expands %s without allowing client-side policy composition",
    (id, permissionProfile, approvalPolicy, filesystemBoundary, processBoundary) => {
      const snapshot = expandPermissionPreset({
        presetId: id,
        expectedVersion: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        preset: { id, version: 1 },
        permissionProfile,
        approvalPolicy,
        filesystemBoundary,
        processBoundary,
      });
      expect(() => verifyPolicyDigest(snapshot)).not.toThrow();
    },
  );

  it("rejects stale or unknown preset versions", () => {
    expect(() =>
      expandPermissionPreset({
        presetId: "WORKSPACE_WRITE",
        expectedVersion: 2,
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toThrow(/version/i);
    expect(() =>
      expandPermissionPreset({
        presetId: "LEGACY_CUSTOM" as never,
        expectedVersion: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toThrow(/preset/i);
  });
});
