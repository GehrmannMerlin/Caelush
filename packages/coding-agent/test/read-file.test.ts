import { createReadFileTool } from "@caelush/coding-agent";
import {
  RuntimeInvalidRangeError,
  RuntimeInvariantError,
  RuntimePathNotFoundError,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  executionInput,
  readFileAnswer,
  readFileKindAnswer,
  readOnlyFake,
  testSignal,
} from "./support/operations-fixtures.js";

/**
 * `read_file` — the target Coding builtin.
 *
 * The suite drives the real `AgentTool.execute` over a fake read port, so it proves the *Tool's*
 * behaviour without touching a filesystem. Every assertion is about something the Tool owns: its
 * schema, its defaults, its bounds, its failure codes, its details shape and the signal it forwards.
 *
 * `read_file` reaches the port through `readFileWithKind` rather than the frozen `ReadFileOperations`,
 * because it answers `NOT_A_FILE` for a path that resolved to something else and a Coding Tool may not
 * import the Runtime's error vocabulary to interpret a path kind. The extra probe is part of the
 * same-package read-only superset; the frozen interface is untouched.
 */

function toolWith(readFileWithKind: Parameters<typeof readOnlyFake>[0]["read"]) {
  const fake = readOnlyFake({ read: readFileWithKind });
  const definition = createReadFileTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

describe("read_file target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool } = toolWith(async () => readFileAnswer());

    expect(tool.name).toBe("read_file");
    expect(tool.description).toBe("Read workspace text.");
    expect(tool.executionMode).toBe("SEQUENTIAL");
    expect(tool.label).toBe("Read File");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
        offset: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "1-indexed first line to return; defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          default: 400,
          description: "Maximum number of returned lines; defaults to 400.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("declares LOW risk, FS_READ, the local runtime requirement and its overlay", () => {
    const { definition } = toolWith(async () => readFileAnswer());

    expect(definition.security).toEqual({
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("read_file");
    expect(definition.effectProjector).toBeDefined();
    expect(definition.securityFactsProjector).toBeDefined();
  });

  it("applies the declared defaults and forwards the environment, path and signal", async () => {
    const { tool, fake } = toolWith(async () => readFileAnswer({ lines: ["a", "b"] }));
    const signal = testSignal();

    const result = await tool.execute(executionInput({ path: "src/a.ts" }, { signal }));

    expect(result).toMatchObject({
      isError: false,
      content: "a\nb",
      details: {
        ok: true,
        path: "src/a.ts",
        offset: 1,
        linesReturned: 2,
        truncated: false,
        bytesReturned: 8,
        utf8Bom: false,
      },
    });
    expect(fake.calls.read).toEqual([
      { environment: ENVIRONMENT, path: "src/a.ts", offset: 1, limit: 400, signal },
    ]);
  });

  it("sends the caller's offset and limit unchanged", async () => {
    const { tool, fake } = toolWith(async () =>
      readFileAnswer({ lines: ["c"], truncated: true, nextOffset: 31 }),
    );

    const result = await tool.execute(executionInput({ path: "a.ts", offset: 30, limit: 1 }));

    expect(result).toMatchObject({
      isError: false,
      details: { offset: 30, truncated: true, nextOffset: 31, linesReturned: 1 },
    });
    expect(fake.calls.read[0]).toMatchObject({ offset: 30, limit: 1 });
  });

  it("reports an empty window as '(empty file)' and keeps the offset in details", async () => {
    const { tool } = toolWith(async () => readFileAnswer({ lines: [] }));

    await expect(tool.execute(executionInput({ path: "a.ts" }))).resolves.toMatchObject({
      isError: false,
      content: "(empty file)",
      details: { linesReturned: 0, offset: 1 },
    });
  });

  it("answers NOT_A_FILE for a path that resolved to a directory", async () => {
    // The regression this pins: the Runtime raises one `RuntimePathTypeError` for "wrong kind", and a
    // Tool may not import that vocabulary to tell "not a file" from "not a directory". The port reports
    // the resolved kind instead, and the Tool keeps the model-facing decision it always owned.
    const { tool } = toolWith(async () => readFileKindAnswer("DIRECTORY"));

    await expect(tool.execute(executionInput({ path: "src" }))).resolves.toMatchObject({
      isError: true,
      content: "Tool operation failed: NOT_A_FILE.",
      details: { ok: false, error: "NOT_A_FILE" },
    });
  });

  it("answers PATH_NOT_FOUND for a path that resolved to nothing", async () => {
    const { tool } = toolWith(async () => readFileKindAnswer("MISSING", "nope.ts"));

    await expect(tool.execute(executionInput({ path: "nope.ts" }))).resolves.toMatchObject({
      isError: true,
      content: "Tool operation failed: PATH_NOT_FOUND.",
      details: { ok: false, error: "PATH_NOT_FOUND" },
    });
  });

  it("maps a Runtime invalid range and a Runtime missing path to their codes", async () => {
    const outOfRange = toolWith(async () => {
      throw new RuntimeInvalidRangeError("line offset is outside the file");
    }).tool;
    const missing = toolWith(async () => {
      throw new RuntimePathNotFoundError("path does not exist");
    }).tool;

    await expect(
      outOfRange.execute(executionInput({ path: "a.ts", offset: 9999 })),
    ).resolves.toMatchObject({ isError: true, details: { error: "INVALID_RANGE" } });
    await expect(missing.execute(executionInput({ path: "nope.ts" }))).resolves.toMatchObject({
      isError: true,
      details: { error: "PATH_NOT_FOUND" },
    });
  });

  it("validates its own bounds before calling the port", async () => {
    const { tool, fake } = toolWith(async () => readFileAnswer());

    for (const value of [
      { path: "a.ts", offset: 0 },
      { path: "a.ts", offset: -1 },
      { path: "a.ts", limit: 0 },
      { path: "a.ts", limit: 2001 },
      { path: "a.ts", limit: 1.5 },
      { path: "a.ts", offset: 1.5 },
      {},
    ]) {
      const result = await tool.execute(executionInput(value));
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ ok: false, error: "INVALID_RANGE" });
    }
    expect(fake.calls.read).toEqual([]);
  });

  it("keeps a RuntimeInvariantError travelling rather than describing it to the model", async () => {
    const { tool } = toolWith(async () => {
      throw new RuntimeInvariantError("the runtime's own guarantee was violated");
    });

    await expect(tool.execute(executionInput({ path: "a.ts" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
  });

  it("produces FILE_READ on the resolved path, and nothing for a failure", () => {
    const { definition } = toolWith(async () => readFileAnswer());
    const request = { invocationId: "inv" as never, externalCallId: "c", args: {} };

    expect(
      definition.effectProjector?.({
        request,
        result: { content: "x", details: { ok: true, path: "src/a.ts" }, isError: false },
        now: 1,
      }),
    ).toEqual([{ type: "FILE_READ", path: "src/a.ts" }]);

    expect(
      definition.effectProjector?.({
        request,
        result: { content: "x", details: { ok: false, error: "PATH_NOT_FOUND" }, isError: true },
        now: 1,
      }),
    ).toEqual([]);
  });

  it("projects a READ resource access on the normalised requested path", () => {
    const { definition } = toolWith(async () => readFileAnswer());

    expect(definition.securityFactsProjector?.({ path: "src\\a.ts" })).toEqual({
      resourceAccesses: [{ operation: "READ", path: "src/a.ts" }],
      secretScanInputs: [],
      structuralPreview: { kind: "FILE_READ", path: "src/a.ts" },
    });
  });
});
