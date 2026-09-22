import { createFindFilesTool } from "@caelush/coding-agent";
import { RuntimeInvariantError, RuntimeInvalidRangeError } from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  executionInput,
  readOnlyFake,
  testSignal,
} from "./support/operations-fixtures.js";

/**
 * `find_files` — the target Coding builtin.
 *
 * Pattern validation is the Tool's own business rule: a glob is normalised, bounded and checked for
 * traversal *before* it reaches the port, so the Operation is never asked to repeat the check. These
 * tests pin both halves — what the Tool refuses without a call, and what it forwards when it does call.
 */

function toolWith(answers: Parameters<typeof readOnlyFake>[0]) {
  const fake = readOnlyFake(answers);
  const definition = createFindFilesTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

function found(path: string, files: readonly string[], truncated = false) {
  return async () => ({ path, files, truncated });
}

describe("find_files target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool, definition } = toolWith({ find: found(".", []) });

    expect(tool.name).toBe("find_files");
    expect(tool.description).toBe("Find workspace files.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Glob pattern for file discovery." },
        path: {
          type: "string",
          minLength: 1,
          default: ".",
          description: "Workspace-relative search directory; defaults to the workspace root '.'.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 100,
          description: "Maximum number of returned files; defaults to 100.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.effectProjector).toBeUndefined();
  });

  it("applies the declared defaults and forwards pattern, path, limit and signal", async () => {
    const { tool, fake } = toolWith({ find: found(".", ["a.ts", "b.ts"]) });
    const signal = testSignal();

    const result = await tool.execute(executionInput({ pattern: "*.ts" }, { signal }));

    expect(result).toMatchObject({
      isError: false,
      content: "a.ts\nb.ts",
      details: {
        ok: true,
        path: ".",
        pattern: "*.ts",
        count: 2,
        truncated: false,
        files: ["a.ts", "b.ts"],
      },
    });
    expect(fake.calls.findWithRoot).toEqual([
      { environment: ENVIRONMENT, pattern: "*.ts", path: ".", limit: 100, signal },
    ]);
  });

  it("normalises backslashes in the pattern before forwarding it", async () => {
    const { tool, fake } = toolWith({ find: found("src", []) });

    await tool.execute(executionInput({ pattern: "src\\**\\*.ts", path: "src" }));

    expect(fake.calls.findWithRoot[0]).toMatchObject({ pattern: "src/**/*.ts", path: "src" });
  });

  it("reports no matches as 'No files found.' and keeps the resolved root", async () => {
    const { tool } = toolWith({ find: found("src", []) });

    await expect(
      tool.execute(executionInput({ pattern: "*.rs", path: "src" })),
    ).resolves.toMatchObject({
      isError: false,
      content: "No files found.",
      details: { count: 0, path: "src" },
    });
  });

  it("reports truncation from the port", async () => {
    const { tool } = toolWith({ find: found(".", ["a.ts"], true) });

    await expect(
      tool.execute(executionInput({ pattern: "*.ts", limit: 1 })),
    ).resolves.toMatchObject({
      isError: false,
      details: { truncated: true, count: 1 },
    });
  });

  it("refuses an invalid pattern without calling the port", async () => {
    const { tool, fake } = toolWith({ find: found(".", []) });

    for (const pattern of [
      "",
      "x".repeat(2049),
      "/abs/*.ts",
      "C:/abs/*.ts",
      "../escape/*.ts",
      "src/../../escape/*.ts",
      42,
      undefined,
    ]) {
      const result = await tool.execute(executionInput({ pattern }));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: INVALID_PATTERN.",
        details: { ok: false, error: "INVALID_PATTERN" },
      });
    }
    expect(fake.calls.findWithRoot).toEqual([]);
  });

  it("refuses an out-of-range limit with INVALID_RANGE", async () => {
    const { tool, fake } = toolWith({ find: found(".", []) });

    for (const limit of [0, -1, 501, 1.5, "10"]) {
      const result = await tool.execute(executionInput({ pattern: "*.ts", limit }));
      expect(result).toMatchObject({ isError: true, details: { error: "INVALID_RANGE" } });
    }
    expect(fake.calls.findWithRoot).toEqual([]);
  });

  it("refuses a non-string path with INVALID_RANGE", async () => {
    const { tool } = toolWith({ find: found(".", []) });

    await expect(tool.execute(executionInput({ pattern: "*.ts", path: 7 }))).resolves.toMatchObject(
      {
        isError: true,
        details: { error: "INVALID_RANGE" },
      },
    );
  });

  it("maps a Runtime failure and keeps an invariant travelling", async () => {
    const failing = toolWith({
      find: async () => {
        throw new RuntimeInvalidRangeError("search path is not a directory");
      },
    }).tool;
    const invariant = toolWith({
      find: async () => {
        throw new RuntimeInvariantError("guarantee violated");
      },
    }).tool;

    await expect(failing.execute(executionInput({ pattern: "*.ts" }))).resolves.toMatchObject({
      isError: true,
      details: { error: "INVALID_RANGE" },
    });
    await expect(invariant.execute(executionInput({ pattern: "*.ts" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
  });

  it("projects a FILE_DISCOVERY structural preview with the default root", () => {
    const { definition } = toolWith({ find: found(".", []) });

    expect(definition.securityFactsProjector?.({ pattern: "*.ts" })).toEqual({
      resourceAccesses: [],
      secretScanInputs: [],
      structuralPreview: { kind: "FILE_DISCOVERY", path: ".", pattern: "*.ts" },
    });
  });
});
