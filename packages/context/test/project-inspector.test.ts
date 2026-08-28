import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { createLocalProjectInspector } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("builds a deterministic project intelligence snapshot without scanning source files", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "caelush-context-inspector-"));
  temporaryDirectories.push(workspace);
  const app = path.join(workspace, "packages", "app");
  const cwd = path.join(app, "src");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(workspace, ".git"));
  await writeFile(path.join(workspace, "package.json"), '{"name":"repo","packageManager":"pnpm@11.21.0","workspaces":["packages/*"],"scripts":{"test":"vitest"}}', "utf8");
  await writeFile(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(path.join(app, "package.json"), '{"name":"active-app"}', "utf8");
  await writeFile(path.join(workspace, "AGENTS.md"), "root rules", "utf8");
  await writeFile(path.join(app, "AGENTS.md"), "app rules", "utf8");
  await writeFile(path.join(app, "src", "source.ts"), "this is not an instruction", "utf8");
  await mkdir(path.join(workspace, "node_modules"));
  await writeFile(path.join(workspace, "node_modules", "AGENTS.md"), "must not be discovered", "utf8");

  const inspector = createLocalProjectInspector();
  const input = { workspace: { id: createWorkspaceId(), path: workspace }, cwd };
  const first = await inspector.inspect(input);
  const second = await inspector.inspect(input);

  expect(first).toEqual(second);
  expect(first.workspace.realRoot).toBe(await inspector.inspect({ workspace: input.workspace }).then((result) => result.workspace.realRoot));
  expect(first.projectRoot).toMatchObject({ projectRoot: workspace, reason: "VCS_MARKER" });
  expect(first.environment).toMatchObject({ projectRoot: workspace, workspaceRoot: workspace });
  expect(first.profile).toMatchObject({
    ecosystems: ["NODE"],
    packageManager: { name: "pnpm", versionHint: "11.21.0" },
    isMonorepo: true,
    rootPackage: { name: "repo" },
    activePackage: { name: "active-app" },
  });
  expect(first.instructions.entries.map((entry) => entry.content)).toEqual(["root rules", "app rules"]);
  expect(JSON.stringify(first)).not.toContain("must not be discovered");
  expect(JSON.stringify(first)).not.toContain("this is not an instruction");
});
