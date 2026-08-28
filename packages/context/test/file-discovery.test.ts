import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId, type WorkspaceRef } from "@caelush/protocol";
import type { ProjectIntelligenceSnapshot } from "../src/snapshot.js";
import { CandidateFileDiscovery } from "../src/file-discovery.js";
import {
  LocalContextFileSystem,
  type ContextFileSystem,
  type ContextTextFile,
} from "../src/filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function snapshot(
  root: string,
  cwd = root,
  activePackagePath?: string,
): ProjectIntelligenceSnapshot {
  const workspace: WorkspaceRef = { id: createWorkspaceId(), path: root };
  return {
    workspace: { workspace, logicalRoot: root, realRoot: root, cwd, realCwd: cwd },
    projectRoot: { projectRoot: root, reason: "VCS_MARKER" },
    environment: {
      platform: process.platform,
      arch: process.arch,
      hostNodeVersion: process.version,
      pathStyle: path.sep === "\\" ? "WINDOWS" : "POSIX",
      workspaceRoot: root,
      projectRoot: root,
      cwd,
    },
    profile: {
      ecosystems: [],
      languageSignals: [],
      manifestEvidence: [],
      packageManager: { name: "UNKNOWN", evidencePaths: [] },
      tooling: [],
      isMonorepo: activePackagePath !== undefined,
      monorepoEvidence: [],
      ...(activePackagePath === undefined
        ? {}
        : {
            activePackage: {
              path: activePackagePath,
              relativePath: path.relative(root, activePackagePath),
              scripts: [],
            },
          }),
    },
    instructions: { entries: [], totalBytes: 0, maxBytes: 0 },
    diagnostics: [],
  };
}

class RecordingFileSystem implements ContextFileSystem {
  readonly readTextFilePaths: string[] = [];
  private readonly delegate = new LocalContextFileSystem();

  getMetadata(targetPath: string) {
    return this.delegate.getMetadata(targetPath);
  }

  async readTextFile(targetPath: string, options: { maxBytes: number }): Promise<ContextTextFile> {
    this.readTextFilePaths.push(targetPath);
    return this.delegate.readTextFile(targetPath, options);
  }

  readDirectory(targetPath: string) {
    return this.delegate.readDirectory(targetPath);
  }

  realpath(targetPath: string) {
    return this.delegate.realpath(targetPath);
  }
}

async function fixture(): Promise<{ root: string; cwd: string; app: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-file-discovery-"));
  temporaryDirectories.push(root);
  const app = path.join(root, "packages", "app");
  const cwd = path.join(app, "src");
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "*.ignored\n", "utf8");
  await writeFile(path.join(root, "root.ts"), "export {}", "utf8");
  await writeFile(path.join(root, "root.ignored"), "ignored", "utf8");
  await writeFile(path.join(app, "package.json"), '{"name":"app"}', "utf8");
  await writeFile(path.join(cwd, "active.ts"), "export {}", "utf8");
  return { root, cwd, app };
}

describe("CandidateFileDiscovery", () => {
  it("discovers only eligible metadata within the project root and ignores generated trees", async () => {
    const { root, cwd, app } = await fixture();
    await mkdir(path.join(root, "node_modules", "fake"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "fake", "index.ts"), "export {}", "utf8");
    await mkdir(path.join(root, ".worktrees", "duplicate"), { recursive: true });
    await writeFile(path.join(root, ".worktrees", "duplicate", "copy.ts"), "export {}", "utf8");
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "generated.js"), "generated", "utf8");

    const result = await new CandidateFileDiscovery({
      filesystem: new LocalContextFileSystem(),
    }).discover(snapshot(root, cwd, path.join(app, "package.json")));

    expect(result.candidates.map((candidate) => candidate.relativePath)).toEqual(
      expect.arrayContaining([
        "packages/app/package.json",
        "packages/app/src/active.ts",
        "root.ts",
      ]),
    );
    expect(result.stats.hardExcludedEntries).toBeGreaterThanOrEqual(3);
  });

  it("does not eagerly read source files and returns deterministic output", async () => {
    const { root, cwd, app } = await fixture();
    const filesystem = new RecordingFileSystem();
    const discovery = new CandidateFileDiscovery({ filesystem });

    const first = await discovery.discover(snapshot(root, cwd, path.join(app, "package.json")));
    const second = await discovery.discover(snapshot(root, cwd, path.join(app, "package.json")));

    expect(first.candidates).toEqual(second.candidates);
    expect(filesystem.readTextFilePaths).toEqual([
      path.join(root, ".gitignore"),
      path.join(root, ".gitignore"),
    ]);
  });

  it("reports bounded traversal instead of exceeding configured limits", async () => {
    const { root } = await fixture();
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeFile(path.join(root, `file-${index}.ts`), "export {}", "utf8"),
      ),
    );

    const result = await new CandidateFileDiscovery({
      filesystem: new LocalContextFileSystem(),
    }).discover(snapshot(root), { maxVisitedEntries: 2, maxCandidateFiles: 5, maxDepth: 32 });

    expect(result.stats.visitedEntries).toBe(2);
    expect(result.stats.truncatedByLimit).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DISCOVERY_LIMIT_REACHED" })]),
    );
  });

  it("does not follow directory or file symlinks", async ({ skip }) => {
    if (process.platform === "win32") skip();
    const { root } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "caelush-file-discovery-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "outside.ts"), "export {}", "utf8");
    await symlink(outside, path.join(root, "linked-directory"), "junction");
    await symlink(path.join(outside, "outside.ts"), path.join(root, "linked-file"), "file");

    const result = await new CandidateFileDiscovery({
      filesystem: new LocalContextFileSystem(),
    }).discover(snapshot(root));

    expect(result.candidates.map((candidate) => candidate.relativePath)).not.toEqual(
      expect.arrayContaining(["linked-directory/outside.ts", "linked-file"]),
    );
    expect(result.stats.symlinkSkipped).toBe(2);
  });
});
