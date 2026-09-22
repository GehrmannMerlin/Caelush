import { createGitStatusTool } from "@caelush/coding-agent";
import { RuntimeGitError, RuntimeInvariantError } from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT, executionInput, gitFake, testSignal } from "./support/operations-fixtures.js";

/**
 * `git_status` — the target Coding builtin.
 *
 * `path` is a real Git pathspec and `limit` drives Runtime status parsing, so the Tool must pass both
 * through and must never interpret a pathspec itself: no `startsWith`, no glob matching, no prefix
 * filter. Git's pathspec semantics include glob and `:(magic)` forms no string comparison reproduces,
 * which is precisely why the frozen `GitOperations.status` needed the errata that gave it `args`.
 */

function toolWith(status: Parameters<typeof gitFake>[0]["status"]) {
  const fake = gitFake({ status });
  const definition = createGitStatusTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

function status(result: Record<string, unknown>) {
  return async () => result as never;
}

const CLEAN = {
  branch: "main",
  detached: false,
  ahead: 0,
  behind: 0,
  clean: true,
  entries: [],
  truncated: false,
};

describe("git_status target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool, definition } = toolWith(status(CLEAN));

    expect(tool.name).toBe("git_status");
    expect(tool.description).toBe("Git.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative pathspec." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 200,
          description: "Maximum number of status entries; defaults to 200.",
        },
      },
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "LOW",
      requiredCapabilities: ["GIT_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("git_status");
    expect(definition.effectProjector).toBeUndefined();
  });

  it("passes the pathspec and limit through as a canonical args bag", async () => {
    const { tool, fake } = toolWith(status(CLEAN));
    const signal = testSignal();

    await tool.execute(executionInput({ path: "src", limit: 250 }, { signal }));

    // `path` reaches Git: the Tool does not filter entries itself, and `limit` is forwarded so a request
    // for 250 is not pinned to the Runtime's own default of 200.
    expect(fake.calls.status).toEqual([
      { environment: ENVIRONMENT, args: { path: "src", limit: 250 }, signal },
    ]);
  });

  it("omits the pathspec from args when the caller did not supply one", async () => {
    const { tool, fake } = toolWith(status(CLEAN));

    await tool.execute(executionInput({}));

    const call = fake.calls.status[0] as { args: Record<string, unknown> };
    expect(call.args).toEqual({ limit: 200 });
    expect(Object.hasOwn(call.args, "path")).toBe(false);
  });

  it("reports a clean tree", async () => {
    const { tool } = toolWith(status(CLEAN));

    await expect(tool.execute(executionInput({}))).resolves.toMatchObject({
      isError: false,
      content: "Working tree is clean.",
      details: {
        ok: true,
        branch: "main",
        detached: false,
        ahead: 0,
        behind: 0,
        clean: true,
        entries: [],
        truncated: false,
      },
    });
  });

  it("renders a dirty tree as 'XY path' lines in the Runtime's order", async () => {
    const entries = [
      { indexStatus: "M", worktreeStatus: ".", path: "src/a.ts" },
      { indexStatus: "?", worktreeStatus: "?", path: "docs/a.md" },
    ];
    const { tool } = toolWith(
      status({ ...CLEAN, clean: false, entries, truncated: true, ahead: 2, behind: 1 }),
    );

    const result = await tool.execute(executionInput({}));

    expect(result).toMatchObject({
      isError: false,
      content: "M. src/a.ts\n?? docs/a.md",
      details: { clean: false, truncated: true, ahead: 2, behind: 1, entries },
    });
  });

  it("reports a detached head and a missing branch without inventing either", async () => {
    const detached = toolWith(
      status({ detached: true, ahead: 0, behind: 0, clean: true, entries: [], truncated: false }),
    ).tool;

    const result = await detached.execute(executionInput({}));

    expect(result).toMatchObject({ isError: false, details: { detached: true } });
    expect(result.details).not.toHaveProperty("branch");
  });

  it("refuses a malformed pathspec or limit without calling the port", async () => {
    const { tool, fake } = toolWith(status(CLEAN));

    const badPath = await tool.execute(executionInput({ path: 42 }));
    expect(badPath).toMatchObject({
      isError: true,
      content: "Tool operation failed: INVALID_GIT_PATH.",
      details: { ok: false, error: "INVALID_GIT_PATH" },
    });

    for (const limit of [0, -1, 1001, 1.5]) {
      const result = await tool.execute(executionInput({ limit }));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: INVALID_GIT_SCOPE.",
        details: { error: "INVALID_GIT_SCOPE" },
      });
    }
    expect(fake.calls.status).toEqual([]);
  });

  it("maps a Git failure to its safe code and keeps an invariant travelling", async () => {
    const notARepo = toolWith(async () => {
      throw new RuntimeGitError("NOT_A_REPOSITORY", "no repository");
    }).tool;
    const invariant = toolWith(async () => {
      throw new RuntimeInvariantError("guarantee violated");
    }).tool;

    await expect(notARepo.execute(executionInput({}))).resolves.toMatchObject({
      isError: true,
      details: { ok: false, error: "NOT_A_REPOSITORY" },
    });
    await expect(invariant.execute(executionInput({}))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
  });

  it("projects a GIT_STATUS structural preview and no resource access", () => {
    const { definition } = toolWith(status(CLEAN));

    expect(definition.securityFactsProjector?.({ path: "src\\a.ts" })).toEqual({
      resourceAccesses: [],
      secretScanInputs: [],
      structuralPreview: { kind: "GIT_STATUS", path: "src/a.ts" },
    });
    expect(definition.securityFactsProjector?.({})).toMatchObject({
      structuralPreview: { kind: "GIT_STATUS", path: "." },
    });
  });
});
