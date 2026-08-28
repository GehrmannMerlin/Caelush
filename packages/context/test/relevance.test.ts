import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import type { CandidateFile } from "../src/file-discovery.js";
import type { ProjectIntelligenceSnapshot } from "../src/snapshot.js";
import { RelevantPathRanker, tokenizeRelevantQuery } from "../src/relevance.js";

function snapshot(): ProjectIntelligenceSnapshot {
  const root = path.resolve("/repo");
  const cwd = path.join(root, "packages", "app", "src");
  return {
    workspace: {
      workspace: { id: createWorkspaceId(), path: root },
      logicalRoot: root,
      realRoot: root,
      cwd,
      realCwd: cwd,
    },
    projectRoot: { projectRoot: root, reason: "VCS_MARKER" },
    environment: {
      platform: "linux",
      arch: "x64",
      hostNodeVersion: "v24.0.0",
      pathStyle: "POSIX",
      workspaceRoot: root,
      projectRoot: root,
      cwd,
    },
    profile: {
      ecosystems: ["NODE"],
      languageSignals: ["TYPESCRIPT"],
      manifestEvidence: [],
      packageManager: { name: "pnpm", evidencePaths: [] },
      tooling: [],
      isMonorepo: true,
      monorepoEvidence: [],
      activePackage: {
        path: path.join(root, "packages", "app", "package.json"),
        relativePath: "packages/app/package.json",
        scripts: [],
      },
    },
    instructions: { entries: [], totalBytes: 0, maxBytes: 0 },
    diagnostics: [],
  };
}

function candidate(
  relativePath: string,
  depth = relativePath.split("/").length - 1,
): CandidateFile {
  const root = path.resolve("/repo");
  const fileName = path.basename(relativePath);
  const extension = path.extname(fileName).toLowerCase();
  return {
    path: path.join(root, relativePath),
    relativePath,
    fileName,
    ...(extension === "" ? {} : { extension }),
    depth,
  };
}

describe("RelevantPathRanker", () => {
  it("tokenizes ASCII, camelCase, separators, and Unicode deterministically", () => {
    expect(tokenizeRelevantQuery("Fix parserHTTP_错误.ts")).toEqual([
      "fix",
      "parser",
      "http",
      "错误",
      "ts",
    ]);
    expect(tokenizeRelevantQuery("a x")).toEqual([]);
  });

  it("ranks an explicit path above related test and unrelated files with reasons", () => {
    const ranked = new RelevantPathRanker().rank(
      [
        candidate("packages/app/src/parser.ts", 3),
        candidate("packages/app/src/parser.test.ts", 3),
        candidate("packages/app/src/unrelated.ts", 3),
      ],
      { text: "Fix parser behavior", explicitPaths: ["packages/app/src/parser.ts"] },
      snapshot(),
    );

    expect(ranked[0]).toMatchObject({
      relativePath: "packages/app/src/parser.ts",
      score: 1000 + 140 + 120 + 80 + 220 - 6,
      reasons: expect.arrayContaining([
        "EXPLICIT_PATH_EXACT",
        "CWD_SUBTREE",
        "ACTIVE_PACKAGE",
        "SAME_DIRECTORY_AS_CWD",
      ]),
    });
    expect(ranked[1]).toMatchObject({
      relativePath: "packages/app/src/parser.test.ts",
      reasons: expect.arrayContaining(["TEST_SOURCE_PAIR", "QUERY_STEM"]),
    });
    expect(ranked.at(-1)?.relativePath).toBe("packages/app/src/unrelated.ts");
  });

  it("uses the strongest query match per term and applies structural signals", () => {
    const ranked = new RelevantPathRanker().rank(
      [
        candidate("packages/app/src/main.ts", 3),
        candidate("packages/other/parser-helper.ts", 2),
        candidate("deep/nested/parser-helper.ts", 3),
        candidate("README.md", 0),
      ],
      { text: "parser helper" },
      snapshot(),
    );

    expect(
      ranked.find((entry) => entry.relativePath === "packages/other/parser-helper.ts"),
    ).toMatchObject({
      reasons: expect.arrayContaining(["QUERY_PATH_SEGMENT"]),
    });
    expect(ranked.find((entry) => entry.relativePath === "README.md")).toMatchObject({
      reasons: expect.arrayContaining(["PROJECT_DOCUMENT"]),
    });
    expect(
      ranked.find((entry) => entry.relativePath === "packages/other/parser-helper.ts"),
    ).toBeDefined();
    expect(
      ranked.find((entry) => entry.relativePath === "deep/nested/parser-helper.ts")?.score,
    ).toBeLessThan(
      ranked.find((entry) => entry.relativePath === "packages/other/parser-helper.ts")?.score ?? 0,
    );
  });

  it("supports reverse test/source pairing, floors scores, caps output, and breaks ties stably", () => {
    const candidates = [
      candidate("z.ts", 20),
      candidate("a.ts", 20),
      candidate("parser.ts", 20),
      candidate("parser.spec.ts", 20),
    ];
    const ranked = new RelevantPathRanker({ maxRankedCandidatesReturned: 4 }).rank(
      candidates,
      { text: "no-match", explicitPaths: ["parser.spec.ts"] },
      snapshot(),
    );

    expect(ranked).toHaveLength(4);
    expect(ranked.find((entry) => entry.relativePath === "parser.ts")?.reasons).toContain(
      "TEST_SOURCE_PAIR",
    );
    expect(ranked.every((entry) => entry.score >= 0)).toBe(true);
    expect(ranked.slice(-2).map((entry) => entry.relativePath)).toEqual(["a.ts", "z.ts"]);
  });
});
