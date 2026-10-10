import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWorkspaceFileService } from "../../src/main/workspace/file-service.js";

const WORKSPACE_ID = createWorkspaceId();
const PROFILE_ID = `u_${"a".repeat(64)}`;
const USER_ID = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const GENERATION_ID = "9f16de4b-87a8-4f34-9504-a9a55e4f3d32";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-d5-workspace-"));
  roots.push(root);
  return root;
}

function serviceFor(rootPath: string, overrides: { readonly profileId?: string } = {}) {
  const controller = new AbortController();
  const lease = {
    baseUrl: "http://127.0.0.1:49123",
    hostToken: "h".repeat(43),
    signal: controller.signal,
    userId: USER_ID,
    profileId: overrides.profileId ?? PROFILE_ID,
    generationId: GENERATION_ID,
    profile: {
      profileId: overrides.profileId ?? PROFILE_ID,
      rootDirectory: "C:\\Caelush\\profiles\\test",
      databasePath: "C:\\Caelush\\profiles\\test\\caelush.db",
      runsDirectory: "C:\\Caelush\\profiles\\test\\runs",
      logsDirectory: "C:\\Caelush\\profiles\\test\\logs",
      backupsDirectory: "C:\\Caelush\\profiles\\test\\backups",
      browserDirectory: "C:\\Caelush\\profiles\\test\\browser",
      downloadsDirectory: "C:\\Caelush\\profiles\\test\\downloads",
      metadataPath: "C:\\Caelush\\profiles\\test\\profile.json",
    },
    release: vi.fn(),
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`http://127.0.0.1:49123/api/v1/workspaces/${WORKSPACE_ID}`);
    expect(new Headers(init?.headers).get("x-caelush-host-token")).toBe("h".repeat(43));
    return Response.json({
      id: WORKSPACE_ID,
      canonicalPath: rootPath,
      displayName: "Test Workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    });
  });
  return {
    service: new DesktopWorkspaceFileService({
      acquireLease: () => lease,
      fetcher: fetcher as typeof fetch,
      platform: process.platform,
    }),
    lease,
    fetcher,
    controller,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop workspace file authority", () => {
  it("loads only a Daemon registered Workspace and returns a bounded directory page", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "hello.ts"), "export const greeting = '你好';\n");
    const { service, lease, fetcher } = serviceFor(root);

    const result = await service.listEntries({ workspaceId: WORKSPACE_ID, relativePath: "" });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(result.items.map((item) => item.name)).toEqual(["src"]);
    expect(result.items[0]?.kind).toBe("DIRECTORY");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("previews bounded UTF-8 text and reports binary files without decoding them", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "readme.md"), "# 项目\n欢迎回来\n", "utf8");
    await writeFile(path.join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const { service } = serviceFor(root);

    const text = await service.previewText({
      workspaceId: WORKSPACE_ID,
      relativePath: "readme.md",
    });
    const binary = await service.previewText({
      workspaceId: WORKSPACE_ID,
      relativePath: "image.png",
    });

    expect(text).toMatchObject({ supported: true, text: "# 项目\n欢迎回来\n" });
    expect(binary).toMatchObject({ supported: false, reason: "BINARY" });
  });

  it.each(["../outside.txt", "%2e%2e/outside.txt", "C:/outside.txt", "src\\..\\outside.txt"])(
    "rejects traversal and absolute path form %s before file access",
    async (relativePath) => {
      const root = await makeRoot();
      await writeFile(path.join(root, "inside.txt"), "safe");
      const { service } = serviceFor(root);

      await expect(
        service.previewText({ workspaceId: WORKSPACE_ID, relativePath }),
      ).rejects.toMatchObject({ code: "PATH_INVALID" });
    },
  );

  it("rejects an out-of-root junction instead of following it", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(path.join(outside, "secret.txt"), "never read");
    const junctionPath = path.join(root, "outside-link");
    try {
      await symlink(outside, junctionPath, "junction");
    } catch (error) {
      if (process.platform === "win32") throw error;
      return;
    }
    const { service } = serviceFor(root);

    await expect(
      service.previewText({ workspaceId: WORKSPACE_ID, relativePath: "outside-link/secret.txt" }),
    ).rejects.toMatchObject({ code: "PATH_REPARSE_POINT" });
    const page = await service.listEntries({
      workspaceId: WORKSPACE_ID,
      relativePath: "",
      limit: 500,
    });
    expect(page.items.find((item) => item.name === "outside-link")?.kind).toBe("SYMLINK");
  });

  it("rejects large files and caps each directory response at 500 entries", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "large.txt"), Buffer.alloc(1_048_577, 0x61));
    for (let index = 0; index < 503; index += 1) {
      await writeFile(path.join(root, `item-${String(index).padStart(3, "0")}.txt`), "x");
    }
    const { service } = serviceFor(root);

    await expect(
      service.previewText({ workspaceId: WORKSPACE_ID, relativePath: "large.txt" }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    const page = await service.listEntries({
      workspaceId: WORKSPACE_ID,
      relativePath: "",
      limit: 500,
    });
    expect(page.items).toHaveLength(500);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(500);
  });

  it("rejects stale generation leases and always releases them", async () => {
    const root = await makeRoot();
    const { service, lease, fetcher, controller } = serviceFor(root);
    controller.abort();

    await expect(
      service.listEntries({ workspaceId: WORKSPACE_ID, relativePath: "" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_AUTHORIZED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("does not trust a Renderer supplied root or accept another profile's Workspace record", async () => {
    const root = await makeRoot();
    const { service } = serviceFor(root, { profileId: `u_${"b".repeat(64)}` });

    const authorized = await service.authorizeWorkspace(WORKSPACE_ID);

    expect(authorized.rootPath).toBe(root);
    expect(authorized.profileId).toBe(`u_${"b".repeat(64)}`);
    expect((await readdir(root)).length).toBe(0);
  });
});
