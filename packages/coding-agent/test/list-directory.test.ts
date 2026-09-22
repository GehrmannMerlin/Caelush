import { createListDirectoryTool } from "@caelush/coding-agent";
import {
  RuntimeInvalidRangeError,
  RuntimeInvariantError,
  RuntimePathNotFoundError,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  entry,
  executionInput,
  listDirectoryAnswer,
  readOnlyFake,
  testSignal,
} from "./support/operations-fixtures.js";

/**
 * `list_directory` — the target Coding builtin.
 *
 * The `offset` reconciliation is the load-bearing part: the frozen `ListDirectoryOperations.list` has
 * no `offset`, so the Tool asks the port for `offset - 1 + limit + 1` entries and slices the window
 * itself. The extra entry is what makes `truncated` and `nextOffset` decidable from the returned list
 * rather than guessed, and these tests pin that arithmetic exactly.
 */

function toolWith(
  answer: Parameters<typeof readOnlyFake>[0]["listDirectoryWithKind"],
) {
  const fake = readOnlyFake({ listDirectoryWithKind: answer });
  const definition = createListDirectoryTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

describe("list_directory target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool } = toolWith(async () => listDirectoryAnswer({}));

    expect(tool.name).toBe("list_directory");
    expect(tool.description).toBe("List dir.");
    expect(tool.executionMode).toBe("SEQUENTIAL");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Workspace-relative directory path; use '.' for the workspace root.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "1-indexed first entry to return; defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 200,
          description: "Maximum number of returned entries; defaults to 200.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
    expect(tool.label).toBe("List Directory");
  });

  it("declares LOW risk and FS_READ", () => {
    const { definition } = toolWith(async () => listDirectoryAnswer({}));

    expect(definition.security).toEqual({
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("list_directory");
  });

  it("suffixes directories with '/' and symlinks with '@', and lists files bare", async () => {
    const { tool } = toolWith(async () =>
      listDirectoryAnswer({
        entries: [
          entry("src", "DIRECTORY"),
          entry("link", "SYMLINK"),
          entry("a.ts", "FILE"),
        ],
      }),
    );

    const result = await tool.execute(executionInput({ path: "." }));

    expect(result).toMatchObject({
      isError: false,
      content: "src/\nlink@\na.ts",
      details: { count: 3, truncated: false, path: "." },
    });
  });

  it("reports an empty directory as '(empty directory)'", async () => {
    const { tool } = toolWith(async () => listDirectoryAnswer({ entries: [] }));

    await expect(tool.execute(executionInput({ path: "empty" }))).resolves.toMatchObject({
      isError: false,
      content: "(empty directory)",
      details: { count: 0, truncated: false },
    });
  });

  it("asks for offset - 1 + limit + 1 entries so truncation is provable", async () => {
    const { tool, fake } = toolWith(async () =>
      listDirectoryAnswer({
        entries: [entry("a"), entry("b"), entry("c"), entry("d"), entry("e")],
      }),
    );

    const result = await tool.execute(executionInput({ path: "src", offset: 2, limit: 2 }));

    // The probe asks for 2 - 1 + 2 + 1 = 4 entries; the window after the offset has 3, so the Tool can
    // prove one more follows.
    expect(fake.calls.listDirectoryWithKind[0]).toMatchObject({ limit: 4 });
    expect(result).toMatchObject({
      isError: false,
      content: "b\nc",
      details: { offset: 2, count: 2, truncated: true, nextOffset: 4 },
    });
  });

  it("does not report truncation when the window reaches the end exactly", async () => {
    const { tool } = toolWith(async () =>
      listDirectoryAnswer({ entries: [entry("a"), entry("b"), entry("c")] }),
    );

    const result = await tool.execute(executionInput({ path: "src", offset: 2, limit: 2 }));

    expect(result).toMatchObject({
      isError: false,
      content: "b\nc",
      details: { offset: 2, count: 2, truncated: false },
    });
    expect(result.details).not.toHaveProperty("nextOffset");
  });

  it("returns an empty page past the end without a fabricated nextOffset", async () => {
    const { tool } = toolWith(async () => listDirectoryAnswer({ entries: [entry("a")] }));

    const result = await tool.execute(executionInput({ path: "src", offset: 9, limit: 2 }));

    expect(result).toMatchObject({
      isError: false,
      content: "(empty directory)",
      details: { offset: 9, count: 0, truncated: false },
    });
  });

  it("answers NOT_A_DIRECTORY when the path resolved to a file", async () => {
    const { tool } = toolWith(async () =>
      listDirectoryAnswer({ path: "docs.md", kind: "FILE", entries: [] }),
    );

    await expect(tool.execute(executionInput({ path: "docs.md" }))).resolves.toMatchObject({
      isError: true,
      content: "Tool operation failed: NOT_A_DIRECTORY.",
      details: { ok: false, error: "NOT_A_DIRECTORY" },
    });
  });

  it("answers PATH_NOT_FOUND when nothing resolved at the path", async () => {
    const { tool } = toolWith(async () =>
      listDirectoryAnswer({ path: "nope", kind: "MISSING", entries: [] }),
    );

    await expect(tool.execute(executionInput({ path: "nope" }))).resolves.toMatchObject({
      isError: true,
      content: "Tool operation failed: PATH_NOT_FOUND.",
      details: { ok: false, error: "PATH_NOT_FOUND" },
    });
  });

  it("maps a Runtime failure to its own code and forwards the signal and environment", async () => {
    const signal = testSignal();
    const failing = toolWith(async () => {
      throw new RuntimePathNotFoundError("path does not exist");
    }).tool;
    const invariant = toolWith(async () => {
      throw new RuntimeInvariantError("guarantee violated");
    }).tool;
    const range = toolWith(async () => {
      throw new RuntimeInvalidRangeError("bad window");
    }).tool;

    await expect(failing.execute(executionInput({ path: "x" }))).resolves.toMatchObject({
      isError: true,
      details: { error: "PATH_NOT_FOUND" },
    });
    await expect(invariant.execute(executionInput({ path: "x" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
    await expect(range.execute(executionInput({ path: "x" }))).resolves.toMatchObject({
      isError: true,
      details: { error: "INVALID_RANGE" },
    });

    const { tool, fake } = toolWith(async () => listDirectoryAnswer({ entries: [] }));
    await tool.execute(executionInput({ path: "." }, { signal }));
    expect(fake.calls.listDirectoryWithKind[0]).toMatchObject({ environment: ENVIRONMENT, signal });
  });

  it("validates its own bounds before calling the port", async () => {
    const { tool, fake } = toolWith(async () => listDirectoryAnswer({ entries: [] }));

    for (const value of [
      { path: "." , offset: 0 },
      { path: ".", limit: 0 },
      { path: ".", limit: 501 },
      { path: ".", limit: 2.5 },
      { offset: 1 },
    ]) {
      const result = await tool.execute(executionInput(value));
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ ok: false, error: "INVALID_RANGE" });
    }
    expect(fake.calls.listDirectoryWithKind).toEqual([]);
  });

  it("produces no effect and no state change", () => {
    const { definition } = toolWith(async () => listDirectoryAnswer({ entries: [] }));

    expect(definition.effectProjector).toBeUndefined();
    expect(definition.securityFactsProjector?.({ path: "src" })).toEqual({
      resourceAccesses: [],
      secretScanInputs: [],
      structuralPreview: { kind: "DIRECTORY_LIST", path: "src" },
    });
  });
});
