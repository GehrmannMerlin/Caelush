import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProfileManager,
  profileIdForUser,
  WindowsProfilePermissions,
} from "../../src/main/profiles/profile-manager.js";

const roots: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-profile-test-"));
  roots.push(root);
  return root;
}

function manager(rootDirectory: string) {
  return new ProfileManager({
    localAppDataDirectory: rootDirectory,
    platform: "win32",
    permissions: {
      async secureDirectory() {},
      async verifyDirectory() {},
      async secureFile() {},
      async verifyFile() {},
    },
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
}

afterEach(async () => {
  vi.mocked(fs.realpath).mockRestore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop account profile isolation", () => {
  it("resolves the managed root when only its children are redirected by the Windows host", async () => {
    const root = await createRoot();
    const physical = path.join(root, "physical");
    const logical = path.join(root, "logical");
    await mkdir(path.join(physical, "Local"), { recursive: true });
    await symlink(physical, logical, "junction");
    const localAppData = path.join(logical, "Local");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.realpath).mockImplementation(async (value, options) => {
      if (String(value) === localAppData) return localAppData;
      return actual.realpath(value, options);
    });
    const profile = await manager(localAppData).selectForUser(
      "9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0",
    );
    expect(profile.rootDirectory).toBe(
      path.join(await actual.realpath(physical), "Local", "Caelush", "profiles", profile.profileId),
    );
  });

  it("resolves an OS-provided AppData root through a redirected ancestor before enforcing containment", async () => {
    const root = await createRoot();
    const physical = path.join(root, "physical");
    const logical = path.join(root, "logical");
    await mkdir(path.join(physical, "Local"), { recursive: true });
    await symlink(physical, logical, "junction");
    const profiles = manager(path.join(logical, "Local"));
    const profile = await profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0");
    expect(profile.rootDirectory).toBe(
      path.join(await realpath(physical), "Local", "Caelush", "profiles", profile.profileId),
    );
    await expect(profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0")).resolves.toEqual(
      profile,
    );
  });

  it("continues rejecting a symlink supplied as the AppData root itself", async () => {
    const root = await createRoot();
    const physical = path.join(root, "physical");
    const logical = path.join(root, "logical");
    await mkdir(physical);
    await symlink(physical, logical, "junction");
    await expect(
      manager(logical).selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0"),
    ).rejects.toMatchObject({ code: "PROFILE_PATH_UNSAFE" });
  });

  it("derives stable opaque profiles and creates independent storage trees", async () => {
    const localAppData = await createRoot();
    const profiles = manager(localAppData);
    const userA = await profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0");
    const userB = await profiles.selectForUser("12a7745d-1206-4e92-91c6-44ad5b419e4f");

    expect(userA.profileId).toBe(profileIdForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0"));
    expect(userA.profileId).not.toContain("9a8773e9");
    expect(userA.rootDirectory).not.toBe(userB.rootDirectory);
    expect(userA.databasePath).not.toBe(userB.databasePath);
    expect(userA.databasePath).toBe(path.join(userA.rootDirectory, "caelush.db"));
    expect(userA.logsDirectory).toBe(path.join(userA.rootDirectory, "logs"));
    expect(userA.runsDirectory).toBe(path.join(userA.rootDirectory, "runs"));
    const metadata = JSON.parse(
      await (await import("node:fs/promises")).readFile(userA.metadataPath, "utf8"),
    );
    expect(metadata).toEqual({
      schemaVersion: 1,
      profileId: userA.profileId,
      createdAt: "2026-10-10T00:00:00.000Z",
    });
    expect(JSON.stringify(metadata)).not.toMatch(/token|private.?key|credential|@/iu);
    await expect(profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0")).resolves.toEqual(
      userA,
    );
  });

  it("rejects invalid Cloud user identifiers and mismatched existing metadata", async () => {
    const localAppData = await createRoot();
    const profiles = manager(localAppData);
    await expect(profiles.selectForUser("../../outside")).rejects.toMatchObject({
      code: "PROFILE_ID_INVALID",
    });

    const profile = await profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0");
    await writeFile(
      profile.metadataPath,
      JSON.stringify({ schemaVersion: 1, profileId: "u_" + "0".repeat(64), createdAt: "bad" }),
    );
    await expect(
      profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0"),
    ).rejects.toMatchObject({ code: "PROFILE_METADATA_INVALID" });
  });

  it("rejects a profile tree redirected outside the local data root", async () => {
    const localAppData = await createRoot();
    const outside = await createRoot();
    const profilesPath = path.join(localAppData, "Caelush", "profiles");
    await mkdir(path.dirname(profilesPath), { recursive: true });
    await symlink(outside, profilesPath, "junction");

    await expect(
      manager(localAppData).selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0"),
    ).rejects.toMatchObject({ code: "PROFILE_PATH_UNSAFE" });
  });

  it("creates profiles with the real current-Windows-user ACL policy", async () => {
    if (process.platform !== "win32") return;
    const localAppData = await createRoot();
    const profiles = new ProfileManager({
      localAppDataDirectory: localAppData,
      platform: "win32",
      permissions: new WindowsProfilePermissions("win32", process.env),
    });

    await expect(
      profiles.selectForUser("9a8773e9-17e4-4ee0-9f9d-b4cfa3e29af0"),
    ).resolves.toMatchObject({
      profileId: expect.stringMatching(/^u_[a-f0-9]{64}$/u),
      rootDirectory: expect.stringContaining("profiles"),
    });
  });
});
