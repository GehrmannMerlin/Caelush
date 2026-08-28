import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { ProjectRootDetector } from "../src/project-root.js";
import { WorkspaceScopeResolver } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scopeFixture(): Promise<{ root: string; cwd: string; scope: Awaited<ReturnType<WorkspaceScopeResolver["resolve"]>> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-context-root-"));
  const cwd = path.join(root, "packages", "app", "src");
  await mkdir(cwd, { recursive: true });
  temporaryDirectories.push(root);
  const resolver = new WorkspaceScopeResolver(new LocalContextFileSystem());
  const scope = await resolver.resolve({ id: createWorkspaceId(), path: root }, cwd);
  return { root, cwd, scope };
}

describe("ProjectRootDetector", () => {
  it("selects the nearest .git directory or worktree file", async () => {
    const first = await scopeFixture();
    await mkdir(path.join(first.root, ".git"));
    const detector = new ProjectRootDetector(new LocalContextFileSystem());
    await expect(detector.detect(first.scope)).resolves.toMatchObject({
      projectRoot: first.root,
      reason: "VCS_MARKER",
      marker: ".git",
    });

    const second = await scopeFixture();
    await writeFile(path.join(second.root, ".git"), "gitdir: ../.git/worktrees/app\n", "utf8");
    await expect(detector.detect(second.scope)).resolves.toMatchObject({
      projectRoot: second.root,
      reason: "VCS_MARKER",
      marker: ".git",
    });
  });

  it("selects a nested git root before an outer git root", async () => {
    const { root, cwd, scope } = await scopeFixture();
    const nestedRoot = path.join(root, "packages");
    await mkdir(path.join(nestedRoot, ".git"));

    await expect(new ProjectRootDetector(new LocalContextFileSystem()).detect(scope)).resolves.toMatchObject({
      projectRoot: nestedRoot,
      reason: "VCS_MARKER",
    });
    expect(cwd).toContain("app");
  });

  it("prefers workspace markers over a nearer package manifest", async () => {
    const { root, scope } = await scopeFixture();
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    await writeFile(path.join(root, "packages", "app", "package.json"), '{"name":"app"}', "utf8");

    await expect(new ProjectRootDetector(new LocalContextFileSystem()).detect(scope)).resolves.toMatchObject({
      projectRoot: root,
      reason: "WORKSPACE_MARKER",
      marker: "pnpm-workspace.yaml",
    });
  });

  it("recognizes package.json workspaces and known project manifests", async () => {
    const workspace = await scopeFixture();
    await writeFile(path.join(workspace.root, "package.json"), '{"workspaces":["packages/*"]}', "utf8");
    await expect(new ProjectRootDetector(new LocalContextFileSystem()).detect(workspace.scope)).resolves.toMatchObject({
      projectRoot: workspace.root,
      reason: "WORKSPACE_MARKER",
      marker: "package.json#workspaces",
    });

    const manifest = await scopeFixture();
    await writeFile(path.join(manifest.root, "packages", "app", "Cargo.toml"), "[package]\nname=\"app\"\n", "utf8");
    await expect(new ProjectRootDetector(new LocalContextFileSystem()).detect(manifest.scope)).resolves.toMatchObject({
      projectRoot: path.join(manifest.root, "packages", "app"),
      reason: "PROJECT_MANIFEST",
      marker: "Cargo.toml",
    });
  });

  it("falls back to cwd and never searches above the workspace root", async () => {
    const { root, cwd, scope } = await scopeFixture();
    await writeFile(path.join(path.dirname(root), ".git"), "outside", "utf8");

    await expect(new ProjectRootDetector(new LocalContextFileSystem()).detect(scope)).resolves.toEqual({
      projectRoot: cwd,
      reason: "CWD_FALLBACK",
    });
  });
});
