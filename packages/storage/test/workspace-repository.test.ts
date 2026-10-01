import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimestampMs, createWorkspaceId, type WorkspaceRecord } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteWorkspaceRepository } from "../src/repositories/workspace-repository.js";

const resources: Array<{
  readonly database: Awaited<ReturnType<typeof openCaelushDatabase>>;
  readonly root: string;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "caelush-workspace-repository-"));
  const database = await openCaelushDatabase({ path: join(root, "caelush.db") });
  await migrateCaelushDatabase(database);
  const repository = new SqliteWorkspaceRepository(database);
  resources.push({ database, root });
  return { database, repository, root };
}

function record(path: string, lastOpenedAt: number): WorkspaceRecord {
  const id = createWorkspaceId();
  return {
    id,
    canonicalPath: path,
    displayName: path.split(/[\\/]/).at(-1) ?? path,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(lastOpenedAt),
    lastOpenedAt: createTimestampMs(lastOpenedAt),
  };
}

describe("WorkspaceRepository", () => {
  it("persists explicit Workspace columns and lists by most recent open", async () => {
    const { repository } = await createRepository();
    const older = record("D:/workspace/older", 10);
    const newer = record("D:/workspace/newer", 20);

    await repository.insert(older);
    await repository.insert(newer);

    expect(await repository.getById(older.id)).toEqual(older);
    expect(await repository.getByCanonicalPath(newer.canonicalPath)).toEqual(newer);
    expect(await repository.list()).toEqual([newer, older]);
  });

  it("forgets only the registry row and never touches workspace files", async () => {
    const { repository, root } = await createRepository();
    const project = await mkdtemp(join(root, "project-"));
    const marker = join(project, "keep.txt");
    await writeFile(marker, "keep");
    const workspace = record(project, 1);
    await repository.insert(workspace);

    await repository.remove(workspace.id);

    expect(await repository.getById(workspace.id)).toBeNull();
    await expect(
      import("node:fs/promises").then(({ access }) => access(marker)),
    ).resolves.toBeUndefined();
  });
});
