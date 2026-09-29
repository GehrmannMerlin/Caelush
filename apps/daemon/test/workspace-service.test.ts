import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspacePathError, WorkspaceService } from "../src/workspaces/workspace-service.js";

let storage: CaelushStorage | undefined;
let root: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createService(): Promise<WorkspaceService> {
  root = await mkdtemp(join(tmpdir(), "caelush-workspace-service-"));
  storage = await openCaelushStorage({ path: join(root, "caelush.db") });
  return new WorkspaceService({ repository: storage.workspaces, now: () => 100 });
}

describe("WorkspaceService", () => {
  it("uses one stable identity for equivalent canonical paths", async () => {
    const service = await createService();
    const project = await mkdtemp(join(root!, "project-"));

    const first = await service.registerWorkspace({ path: project });
    const second = await service.registerWorkspace({ path: join(project, ".") });

    expect(second.workspace).toEqual(first.workspace);
    expect(second.created).toBe(false);
    expect((await service.listWorkspaces()).map((item) => item.id)).toEqual([first.workspace.id]);
  });

  it.each(["missing", "file"]) (
    "rejects a %s path before creating a Registry record",
    async (kind) => {
      const service = await createService();
      const candidate =
        kind === "file" ? join(root!, "workspace.txt") : join(root!, "missing-directory");
      if (kind === "file") await writeFile(candidate, "not a directory");

      await expect(service.registerWorkspace({ path: candidate })).rejects.toBeInstanceOf(
        WorkspacePathError,
      );
      await expect(service.listWorkspaces()).resolves.toEqual([]);
    },
  );

  it("requires an absolute path", async () => {
    const service = await createService();
    await expect(service.registerWorkspace({ path: "relative/project" })).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  it("forgets a Workspace without deleting its directory", async () => {
    const service = await createService();
    const project = await mkdtemp(join(root!, "project-"));
    await mkdir(join(project, "src"));
    const workspace = await service.registerWorkspace({ path: project });

    await service.removeWorkspace(workspace.workspace.id);

    expect(await service.getWorkspace(workspace.workspace.id)).toBeNull();
    await expect(import("node:fs/promises").then(({ access }) => access(join(project, "src")))).resolves.toBeUndefined();
  });
});
