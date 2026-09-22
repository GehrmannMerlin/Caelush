import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolExecutionEnvironment } from "@caelush/agent";
import {
  createGitStatusTool,
  createRuntimeGitOperations,
  type GitOperations,
} from "@caelush/coding-agent";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * `git_status` against a real repository: the two errata regressions.
 *
 * ```text
 * path = "src"   must be a real Git pathspec, not a string prefix filter the Tool applies
 * limit = 250    must not be pinned to the Runtime's own default of 200
 * ```
 *
 * Both were impossible under the original frozen `GitOperations.status({ environment, signal })`,
 * which carried neither. A synthetic unit suite cannot prove either one: the pathspec lives inside the
 * `git status -- <path>` invocation, and the limit lives inside the Runtime's status parser.
 */

let parent: string;
let workspace: string;
let environment: ToolExecutionEnvironment;

async function git(args: readonly string[]): Promise<void> {
  await run("git", [...args], { cwd: workspace });
}

async function gitInit(configure: boolean): Promise<void> {
  await git(["init", "--quiet", "--initial-branch=main"]);
  if (configure) {
    await git(["config", "user.email", "test@caelush.local"]);
    await git(["config", "user.name", "Caelush Test"]);
    await git(["config", "commit.gpgsign", "false"]);
  }
}

function tool() {
  const operations: GitOperations = createRuntimeGitOperations(
    createLocalRuntimeResolver(new LocalRuntime()),
  );
  return createGitStatusTool(operations).tool;
}

function execute(args: Record<string, unknown>) {
  return tool().execute({
    identity: {
      runId: createRunId(),
      sessionId: createRunId() as never,
      sourceStepId: createStepId(),
      invocationId: createToolInvocationId(),
      externalCallId: "call",
    },
    args,
    environment,
    signal: new AbortController().signal,
    updates: { publish() {} },
  });
}

beforeAll(async () => {
  parent = await mkdtemp(path.join(os.tmpdir(), "caelush-4e-git-"));
  workspace = path.join(parent, "ws");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await gitInit(true);
  await writeFile(path.join(workspace, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(workspace, "src", "b.ts"), "export const b = 2;\n", "utf8");
  await writeFile(path.join(workspace, "docs", "a.md"), "# docs\n", "utf8");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "initial"]);
  // Three dirty paths, two under `src` and one under `docs`.
  await writeFile(path.join(workspace, "src", "a.ts"), "export const a = 99;\n", "utf8");
  await writeFile(path.join(workspace, "src", "b.ts"), "export const b = 99;\n", "utf8");
  await writeFile(path.join(workspace, "docs", "a.md"), "# docs changed\n", "utf8");

  environment = {
    workspace: { id: createWorkspaceId(), path: workspace },
    runtime: { id: "local", kind: "local" },
  };
}, 120_000);

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe("git_status path regression", () => {
  it("returns only src entries for path = 'src'", async () => {
    const result = await execute({ path: "src" });

    expect(result.isError).toBe(false);
    const entries = result.details.entries as readonly { path: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.path.startsWith("src/")).toBe(true);
    }
    expect(entries.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.details.truncated).toBe(false);
  });

  it("returns only the docs entry for path = 'docs'", async () => {
    const result = await execute({ path: "docs" });

    const entries = result.details.entries as readonly { path: string }[];
    expect(entries.map((entry) => entry.path)).toEqual(["docs/a.md"]);
  });

  it("returns every dirty path when no pathspec is given", async () => {
    const result = await execute({});

    const entries = result.details.entries as readonly { path: string }[];
    expect(entries.map((entry) => entry.path)).toEqual([
      "docs/a.md",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("reports the branch and a dirty tree", async () => {
    const result = await execute({});

    expect(result).toMatchObject({
      isError: false,
      details: { branch: "main", detached: false, clean: false, ahead: 0, behind: 0 },
    });
  });

  it("renders the 'XY path' content form", async () => {
    const result = await execute({ path: "src" });

    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("docs/a.md");
  });
});

describe("git_status limit regression", () => {
  it("returns 250 entries for limit = 250 rather than being pinned to 200", async () => {
    const manyParent = await mkdtemp(path.join(os.tmpdir(), "caelush-4e-git-many-"));
    const many = path.join(manyParent, "ws");
    const previousEnvironment = environment;
    try {
      await mkdir(path.join(many, "dirty"), { recursive: true });
      workspace = many;
      await gitInit(false);
      await git(["config", "user.email", "test@caelush.local"]);
      await git(["config", "user.name", "Caelush Test"]);
      await git(["config", "commit.gpgsign", "false"]);
      // One committed file, then 260 new untracked ones. A `.gitignore` would hide them: porcelain v2
      // reports ignored entries only under `--ignored`, which the Runtime deliberately does not pass.
      await writeFile(path.join(many, "dirty", "tracked.ts"), "x\n", "utf8");
      await git(["add", "."]);
      await git(["commit", "--quiet", "-m", "tracked"]);
      await Promise.all(
        Array.from({ length: 260 }, (_, index) =>
          writeFile(
            path.join(many, "dirty", `f${String(index).padStart(4, "0")}.ts`),
            "x\n",
            "utf8",
          ),
        ),
      );
      environment = {
        workspace: { id: createWorkspaceId(), path: many },
        runtime: { id: "local", kind: "local" },
      };

      const asked250 = await execute({ limit: 250 });

      expect(asked250.isError).toBe(false);
      // 260 files are dirty. A Runtime pinned to its own default of 200 would report 200.
      expect(asked250.details.entries as readonly unknown[]).toHaveLength(250);
      expect(asked250.details.truncated).toBe(true);

      const asked200 = await execute({ limit: 200 });
      expect(asked200.details.entries as readonly unknown[]).toHaveLength(200);
      expect(asked200.details.truncated).toBe(true);

      const asked1000 = await execute({ limit: 1000 });
      expect(asked1000.details.entries as readonly unknown[]).toHaveLength(260);
      expect(asked1000.details.truncated).toBe(false);
    } finally {
      workspace = path.join(parent, "ws");
      environment = previousEnvironment;
      await rm(manyParent, { recursive: true, force: true });
    }
  }, 180_000);

  it("reports a clean tree for a repository with no changes", async () => {
    const cleanParent = await mkdtemp(path.join(os.tmpdir(), "caelush-4e-git-clean-"));
    const clean = path.join(cleanParent, "ws");
    const previous = environment;
    const previousCwd = workspace;
    try {
      await mkdir(clean, { recursive: true });
      workspace = clean;
      await gitInit(false);
      environment = {
        workspace: { id: createWorkspaceId(), path: clean },
        runtime: { id: "local", kind: "local" },
      };

      const result = await execute({});

      expect(result).toMatchObject({
        isError: false,
        content: "Working tree is clean.",
        details: { clean: true, entries: [], truncated: false },
      });
    } finally {
      environment = previous;
      workspace = previousCwd;
      await rm(cleanParent, { recursive: true, force: true });
    }
  }, 120_000);

  it("answers a safe failure outside a repository", async () => {
    const looseParent = await mkdtemp(path.join(os.tmpdir(), "caelush-4e-git-none-"));
    const previous = environment;
    try {
      environment = {
        workspace: { id: createWorkspaceId(), path: looseParent },
        runtime: { id: "local", kind: "local" },
      };

      const result = await execute({});

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ ok: false });
    } finally {
      environment = previous;
      await rm(looseParent, { recursive: true, force: true });
    }
  }, 120_000);
});
