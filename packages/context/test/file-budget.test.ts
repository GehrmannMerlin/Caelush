import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBudgetSelector, defaultRelevantFileBudget } from "../src/file-budget.js";
import type { RelevantFileCandidate } from "../src/relevance.js";
import { LocalContextFileSystem } from "../src/filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function candidate(root: string, relativePath: string, score = 100): RelevantFileCandidate {
  const fileName = path.basename(relativePath);
  return {
    path: path.join(root, relativePath),
    relativePath,
    fileName,
    extension: path.extname(fileName),
    depth: relativePath.split(path.sep).length - 1,
    score,
    reasons: ["QUERY_BASENAME"],
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-file-budget-"));
  temporaryDirectories.push(root);
  return root;
}

describe("FileBudgetSelector", () => {
  it("uses default values and never exceeds file, total, or count budgets", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.ts"), "a", "utf8");
    await writeFile(path.join(root, "b.ts"), "bbbbbbbbbbbb", "utf8");
    await writeFile(path.join(root, "c.ts"), "c", "utf8");
    const selector = new FileBudgetSelector({
      filesystem: new LocalContextFileSystem(),
      estimator: { estimateText: (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 3) },
    });

    expect(defaultRelevantFileBudget).toEqual({
      maxSelectedFiles: 12,
      maxTotalTokens: 12000,
      maxPerFileTokens: 4000,
      minUsefulFileTokens: 128,
    });
    const result = await selector.select(
      [candidate(root, "a.ts", 3), candidate(root, "b.ts", 2), candidate(root, "c.ts", 1)],
      { maxSelectedFiles: 2, maxTotalTokens: 5, maxPerFileTokens: 4, minUsefulFileTokens: 1 },
    );

    expect(result.sections).toHaveLength(2);
    expect(result.budget.selectedFileCount).toBe(2);
    expect(result.budget.estimatedTokensUsed).toBeLessThanOrEqual(5);
    expect(result.sections.every((section) => section.estimatedTokens <= 4)).toBe(true);
  });

  it("truncates large content at a UTF-8 and line-safe boundary without adding a marker", async () => {
    const root = await fixture();
    const text = "你好 world\n第二行内容\n第三行内容";
    await writeFile(path.join(root, "large.ts"), text, "utf8");
    const selector = new FileBudgetSelector({
      filesystem: new LocalContextFileSystem(),
      estimator: { estimateText: (value) => Math.ceil(Buffer.byteLength(value, "utf8") / 3) },
    });

    const result = await selector.select([candidate(root, "large.ts")], {
      maxSelectedFiles: 1,
      maxTotalTokens: 5,
      maxPerFileTokens: 5,
      minUsefulFileTokens: 1,
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({
      truncated: true,
      content: expect.not.stringContaining("truncated"),
    });
    expect(result.sections[0]?.content.endsWith("\n")).toBe(true);
    expect(result.sections[0]?.estimatedTokens).toBeLessThanOrEqual(5);
    expect(Buffer.from(result.sections[0]?.content ?? "", "utf8").toString("utf8")).toBe(
      result.sections[0]?.content,
    );
  });

  it("skips empty, whitespace-only, NUL, invalid UTF-8, and unreadable files with diagnostics", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "empty.ts"), "", "utf8");
    await writeFile(path.join(root, "space.ts"), " \n\t", "utf8");
    await writeFile(path.join(root, "nul.ts"), Buffer.from([97, 0, 98]));
    await writeFile(path.join(root, "invalid.ts"), Buffer.from([0xff, 0xfe]));
    const selector = new FileBudgetSelector({
      filesystem: new LocalContextFileSystem(),
      estimator: { estimateText: (value) => Math.max(1, value.length) },
    });

    const result = await selector.select(
      [
        candidate(root, "empty.ts"),
        candidate(root, "space.ts"),
        candidate(root, "nul.ts"),
        candidate(root, "invalid.ts"),
        candidate(root, "missing.ts"),
      ],
      { maxSelectedFiles: 5, maxTotalTokens: 20, maxPerFileTokens: 10, minUsefulFileTokens: 1 },
    );

    expect(result.sections).toEqual([]);
    expect(result.nonTextSkipped).toBe(2);
    expect(result.readFailures).toBe(1);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NON_TEXT_FILE_SKIPPED" }),
        expect.objectContaining({ code: "FILE_READ_FAILURE" }),
      ]),
    );
  });

  it("uses an injected estimator when fitting content to a per-file budget", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "custom.ts"), "abcdef", "utf8");
    const selector = new FileBudgetSelector({
      filesystem: new LocalContextFileSystem(),
      estimator: { estimateText: (value) => value.length },
    });

    const result = await selector.select([candidate(root, "custom.ts")], {
      maxSelectedFiles: 1,
      maxTotalTokens: 2,
      maxPerFileTokens: 2,
      minUsefulFileTokens: 1,
    });

    expect(result.sections[0]?.estimatedTokens).toBeLessThanOrEqual(2);
    expect(result.sections[0]?.content).toHaveLength(2);
  });
});
