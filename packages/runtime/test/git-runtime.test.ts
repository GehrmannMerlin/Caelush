import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  LocalRuntime,
  RuntimeGitError,
  RuntimeBoundaryError,
  parseGitStatus,
} from "../src/index.js";

const execGit = promisify(execFile);
const runGit = (cwd: string, args: string[]) => execGit("git", args, { cwd });
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-git-runtime-"));
  temporaryDirectories.push(parent);
  const workspace = path.join(parent, "repo", "nested");
  await mkdir(workspace, { recursive: true });
  const repo = path.dirname(workspace);
  await runGit(repo, ["init", "-q"]);
  await runGit(repo, ["config", "user.email", "test@example.com"]);
  await runGit(repo, ["config", "user.name", "Caelush Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "before\n", "utf8");
  await runGit(repo, ["add", "tracked.txt"]);
  await runGit(repo, ["commit", "-qm", "initial"]);
  return { repo, workspace };
}

describe("LocalGitService", () => {
  it("detects parent repositories and limits status to the Agent Workspace", async () => {
    const { repo, workspace } = await repository();
    await writeFile(path.join(repo, "outside.txt"), "must not be returned\n", "utf8");
    await writeFile(path.join(workspace, "new file.txt"), "new\n", "utf8");
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });
    await expect(scope.git.status({})).resolves.toMatchObject({
      clean: false,
      entries: [{ path: "new file.txt", kind: "UNTRACKED" }],
    });
    const result = await scope.git.status({});
    expect(JSON.stringify(result)).not.toContain(repo);
    expect(JSON.stringify(result)).not.toContain("outside.txt");
  });

  it("returns worktree and staged diffs without allowing path escape", async () => {
    const { workspace } = await repository();
    await writeFile(path.join(workspace, "nested.txt"), "nested\n", "utf8");
    const scope = await new LocalRuntime().openWorkspace({
      id: createWorkspaceId(),
      path: workspace,
    });
    await expect(scope.git.diff({})).resolves.toMatchObject({ scope: "ALL", truncated: false });
    await expect(scope.git.status({ path: "../" })).rejects.toBeInstanceOf(RuntimeGitError);
    expect(() => scope.pathResolver.resolveLexical("../outside")).toThrow(RuntimeBoundaryError);
  });

  it("maps a missing git executable to a typed unavailable error", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-git-no-repo-"));
    temporaryDirectories.push(parent);
    const runtime = new LocalRuntime();
    const scope = await runtime.openWorkspace({ id: createWorkspaceId(), path: parent });
    await expect(scope.git.status({})).rejects.toBeInstanceOf(RuntimeGitError);
    await expect(scope.git.status({})).rejects.toMatchObject({ code: "NOT_A_GIT_REPOSITORY" });
  });
});

describe("parseGitStatus", () => {
  it("parses branch state, tracked, untracked and unmerged records", () => {
    const parsed = parseGitStatus(
      "# branch.head main\0# branch.ab +2 -1\0" +
        "1 .M N... 100644 100644 100644 abc def file name.txt\0" +
        "? new file.txt\0" +
        "u UU N... 100644 100644 100644 100644 a b c d conflict.txt\0",
      20,
    );
    expect(parsed).toMatchObject({ branch: "main", ahead: 2, behind: 1, clean: false });
    expect(parsed.entries.map((entry) => entry.kind)).toEqual(["UNMERGED", "TRACKED", "UNTRACKED"]);
  });

  it("marks explicit truncation", () => {
    const parsed = parseGitStatus("# branch.head main\0? a\0? b\0", 1);
    expect(parsed).toMatchObject({ truncated: true, entries: [{ path: "a" }] });
  });
});
