import { createSearchTextTool } from "@caelush/coding-agent";
import {
  RuntimeInvariantError,
  RuntimeSearchError,
  RuntimeSearchUnavailableError,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT,
  executionInput,
  readOnlyFake,
  testSignal,
} from "./support/operations-fixtures.js";

/**
 * `search_text` — the target Coding builtin.
 *
 * This Tool is why Phase 4E needed an errata, and these tests pin the corrected contract from the
 * *Tool's* side: `include` and `limit` must reach the port, because a Tool-side post-filter sees an
 * already-truncated list and cannot be equivalent.
 *
 * The decisive case is §9.3 of the errata — a fixture where a large file matches the pattern before the
 * `include` target would sort, `include = "z-target.ts"`, `limit = 100`. An implementation that filtered
 * tool-side would answer "No matches found." with `truncated: true`; the correct answer is the three
 * matches with `truncated: false`. The port-level version of that proof (that the glob really is a
 * ripgrep pre-filter) lives in the Runtime adapter suite, which uses a real `rg`.
 */

function toolWith(answers: Parameters<typeof readOnlyFake>[0]) {
  const fake = readOnlyFake(answers);
  const definition = createSearchTextTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

function matches(path: string, found: readonly { line: number; text: string }[], truncated = false) {
  return async () => ({
    path,
    matches: found.map((match) => ({ path: `${path}/x`, ...match })),
    truncated,
  });
}

describe("search_text target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool, definition } = toolWith({ search: matches(".", []) });

    expect(tool.name).toBe("search_text");
    expect(tool.description).toBe("Search workspace text.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        pattern: {
          type: "string",
          minLength: 1,
          description: "Ripgrep-compatible regular expression.",
        },
        path: {
          type: "string",
          minLength: 1,
          default: ".",
          description: "Workspace-relative search directory; defaults to the workspace root '.'.",
        },
        include: { type: "string", minLength: 1, description: "Optional file glob to include." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 100,
          description: "Maximum number of returned matches; defaults to 100.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"], executables: ["rg"] },
    });
    expect(definition.effectProjector).toBeUndefined();
  });

  it("forwards pattern, path, include, limit and the signal to the port", async () => {
    const { tool, fake } = toolWith({
      search: async () => ({
        path: "src",
        matches: [{ path: "src/a.ts", line: 2, text: "alpha" }],
        truncated: false,
      }),
    });
    const signal = testSignal();

    const result = await tool.execute(
      executionInput(
        { pattern: "alpha", path: "src", include: "*.ts", limit: 7 },
        { signal },
      ),
    );

    // `include` and `limit` reach the Operation: they are capability inputs, not presentation, and the
    // whole point of the corrected contract is that they are not applied tool-side.
    expect(fake.calls.search).toEqual([
      {
        environment: ENVIRONMENT,
        pattern: "alpha",
        path: "src",
        include: "*.ts",
        limit: 7,
        signal,
      },
    ]);
    expect(result).toMatchObject({
      isError: false,
      content: "src/a.ts:2: alpha",
      details: { path: "src", pattern: "alpha", count: 1, truncated: false },
    });
  });

  it("omits include entirely when it is not supplied", async () => {
    const { tool, fake } = toolWith({ search: matches(".", []) });

    await tool.execute(executionInput({ pattern: "alpha" }));

    expect(fake.calls.search[0]).toEqual({
      environment: ENVIRONMENT,
      pattern: "alpha",
      path: ".",
      limit: 100,
      signal: expect.anything(),
    });
    expect(Object.hasOwn(fake.calls.search[0] as object, "include")).toBe(false);
  });

  it("normalises backslashes in the include glob", async () => {
    const { tool, fake } = toolWith({ search: matches(".", []) });

    await tool.execute(executionInput({ pattern: "alpha", include: "src\\**\\*.ts" }));

    expect(fake.calls.search[0]).toMatchObject({ include: "src/**/*.ts" });
  });

  it("reports no matches as 'No matches found.'", async () => {
    const { tool } = toolWith({ search: matches(".", []) });

    await expect(tool.execute(executionInput({ pattern: "zzz" }))).resolves.toMatchObject({
      isError: false,
      content: "No matches found.",
      details: { count: 0, truncated: false },
    });
  });

  it("bounds one match's text with the truncation marker", async () => {
    const { tool } = toolWith({
      search: async () => ({
        path: ".",
        matches: [{ path: "a.ts", line: 1, text: "x".repeat(1500) }],
        truncated: false,
      }),
    });

    const result = await tool.execute(executionInput({ pattern: "x" }));

    const match = (result.details.matches as { text: string }[])[0]!;
    expect(match.text).toHaveLength(1000 + "... [match truncated]".length);
    expect(match.text.endsWith("... [match truncated]")).toBe(true);
  });

  it("reports truncation the port could prove", async () => {
    const { tool } = toolWith({
      search: async () => ({
        path: ".",
        matches: [{ path: "a.ts", line: 1, text: "alpha" }],
        truncated: true,
      }),
    });

    await expect(tool.execute(executionInput({ pattern: "alpha", limit: 1 }))).resolves.toMatchObject({
      isError: false,
      details: { truncated: true, count: 1 },
    });
  });

  it("refuses an invalid pattern, include or limit without calling the port", async () => {
    const { tool, fake } = toolWith({ search: matches(".", []) });

    for (const value of [
      { pattern: "" },
      { pattern: 42 },
      {},
      { pattern: "alpha", include: "" },
      { pattern: "alpha", include: "/abs/*.ts" },
      { pattern: "alpha", include: "../escape" },
      { pattern: "alpha", include: "x".repeat(2049) },
      { pattern: "alpha", include: 7 },
    ]) {
      const result = await tool.execute(executionInput(value));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: INVALID_PATTERN.",
        details: { ok: false, error: "INVALID_PATTERN" },
      });
    }
    for (const limit of [0, -1, 201, 2.5]) {
      const result = await tool.execute(executionInput({ pattern: "alpha", limit }));
      expect(result).toMatchObject({ isError: true, details: { error: "INVALID_RANGE" } });
    }
    expect(fake.calls.search).toEqual([]);
  });

  it("answers RIPGREP_UNAVAILABLE and INVALID_PATTERN from the Runtime's own errors", async () => {
    const unavailable = toolWith({
      search: async () => {
        throw new RuntimeSearchUnavailableError("ripgrep is unavailable");
      },
    }).tool;
    const badPattern = toolWith({
      search: async () => {
        throw new RuntimeSearchError("regex parse error");
      },
    }).tool;
    const invariant = toolWith({
      search: async () => {
        throw new RuntimeInvariantError("search escaped its root");
      },
    }).tool;

    await expect(unavailable.execute(executionInput({ pattern: "a" }))).resolves.toMatchObject({
      isError: true,
      content: "Tool operation failed: RIPGREP_UNAVAILABLE.",
      details: { error: "RIPGREP_UNAVAILABLE" },
    });
    await expect(badPattern.execute(executionInput({ pattern: "(" }))).resolves.toMatchObject({
      isError: true,
      details: { error: "INVALID_PATTERN" },
    });
    await expect(invariant.execute(executionInput({ pattern: "a" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
  });

  it("projects a SEARCH resource access and a GENERIC secret-scan input", () => {
    const { definition } = toolWith({ search: matches(".", []) });

    expect(definition.securityFactsProjector?.({ pattern: "token", include: "*.ts" })).toEqual({
      resourceAccesses: [{ operation: "SEARCH", path: "." }],
      secretScanInputs: [{ kind: "GENERIC", text: "token" }],
      structuralPreview: { kind: "TEXT_SEARCH", path: ".", include: "*.ts" },
    });
  });
});
