import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import {
  createLocalProjectInspector,
  createLocalRelevantFilePlanner,
  type RelevantFileBudget,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; app: string; parser: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-relevant-planner-"));
  temporaryDirectories.push(root);
  const app = path.join(root, "packages", "app");
  const source = path.join(app, "src");
  await mkdir(path.join(root, ".git"));
  await mkdir(source, { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "dist/\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"repo","workspaces":["packages/*"]}',
    "utf8",
  );
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), "project instructions", "utf8");
  await writeFile(path.join(root, ".env"), "SECRET=do-not-read", "utf8");
  await writeFile(path.join(root, ".env.example"), "PORT=3000\n", "utf8");
  await writeFile(path.join(app, ".gitignore"), "ignored.ts\n", "utf8");
  await writeFile(path.join(app, "package.json"), '{"name":"active-app"}', "utf8");
  const parser = path.join(source, "parser.ts");
  await writeFile(
    parser,
    "export function parse(input: string): string {\n  return input.trim();\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(source, "parser.test.ts"),
    "import { parse } from './parser';\ntest('parser', () => parse('ok'));\n",
    "utf8",
  );
  await writeFile(path.join(source, "unrelated.ts"), "export const unrelated = true;\n", "utf8");
  await writeFile(path.join(source, "ignored.ts"), "should not be selected", "utf8");
  await writeFile(path.join(source, "image.png"), Buffer.from([0, 1, 2]));
  await mkdir(path.join(root, "node_modules", "fake"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "fake", "index.ts"), "fake", "utf8");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "parser.js"), "generated", "utf8");
  return { root, app, parser };
}

const budget: RelevantFileBudget = {
  maxSelectedFiles: 2,
  maxTotalTokens: 600,
  maxPerFileTokens: 400,
  minUsefulFileTokens: 1,
};

describe("RelevantFilePlanner", () => {
  it("plans task-relevant files from a real Phase 5A snapshot and preserves budget bounds", async () => {
    const { root, app, parser } = await fixture();
    const inspector = createLocalProjectInspector();
    const snapshot = await inspector.inspect({
      workspace: { id: createWorkspaceId(), path: root },
      cwd: path.join(app, "src"),
    });
    const planner = createLocalRelevantFilePlanner();

    const plan = await planner.plan({
      snapshot,
      query: { text: "Fix parser behavior", explicitPaths: ["packages/app/src/parser.ts"] },
      budget,
    });

    expect(plan.rankedCandidates[0]?.relativePath).toBe("packages/app/src/parser.ts");
    expect(plan.rankedCandidates[1]?.relativePath).toBe("packages/app/src/parser.test.ts");
    expect(plan.sections.map((section) => section.provenance.relativePath)).toEqual([
      "packages/app/src/parser.ts",
      "packages/app/src/parser.test.ts",
    ]);
    expect(plan.sections[0]?.provenance.path).toBe(parser);
    expect(plan.budget.estimatedTokensUsed).toBeLessThanOrEqual(600);
    expect(plan.budget.selectedFileCount).toBeLessThanOrEqual(2);
    expect(JSON.stringify(plan)).not.toContain("project instructions");
    expect(plan.rankedCandidates.map((candidate) => candidate.relativePath)).not.toEqual(
      expect.arrayContaining([
        "node_modules/fake/index.ts",
        ".worktrees/duplicate/src/parser.ts",
        "dist/parser.js",
        ".env",
        "image.png",
        "AGENTS.md",
        "packages/app/src/ignored.ts",
      ]),
    );
  });

  it("blocks a sensitive explicit path and reports it without adding the file", async () => {
    const { root, app } = await fixture();
    const snapshot = await createLocalProjectInspector().inspect({
      workspace: { id: createWorkspaceId(), path: root },
      cwd: app,
    });

    const plan = await createLocalRelevantFilePlanner().plan({
      snapshot,
      query: { text: "inspect env", explicitPaths: [".env"] },
      budget,
    });

    expect(plan.sections.map((section) => section.provenance.relativePath)).not.toContain(".env");
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SENSITIVE_AUTO_CONTEXT_BLOCKED" })]),
    );
  });

  it("returns deterministic ranked candidates and selected sections", async () => {
    const { root, app } = await fixture();
    const snapshot = await createLocalProjectInspector().inspect({
      workspace: { id: createWorkspaceId(), path: root },
      cwd: path.join(app, "src"),
    });
    const planner = createLocalRelevantFilePlanner();
    const input = { snapshot, query: { text: "parser" }, budget };

    const first = await planner.plan(input);
    const second = await planner.plan(input);

    expect(first.rankedCandidates).toEqual(second.rankedCandidates);
    expect(first.sections).toEqual(second.sections);
    expect(first.budget).toEqual(second.budget);
  });
});
