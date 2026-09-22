import { createGitDiffTool } from "@caelush/coding-agent";
import { RuntimeGitError, RuntimeInvariantError } from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT, executionInput, gitFake, testSignal } from "./support/operations-fixtures.js";

/**
 * `git_diff` — the target Coding builtin.
 *
 * `GitOperations.diff` already carried an `args` bag before the errata, so this arm needed no contract
 * correction; only its owner moved. The tests therefore pin the scope/path passthrough, the bounded
 * reporting fields and the decode-replacement flag.
 */

function toolWith(diff: Parameters<typeof gitFake>[0]["diff"]) {
  const fake = gitFake({ status: async () => ({}) as never, diff });
  const definition = createGitDiffTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

function diff(result: Record<string, unknown>) {
  return async () => result as never;
}

const EMPTY = {
  diff: "",
  scope: "ALL",
  path: ".",
  truncated: false,
  bytesReturned: 0,
  omittedBytes: 0,
  hadDecodeReplacement: false,
};

describe("git_diff target builtin", () => {
  it("declares the frozen name, description, schema and defaults", () => {
    const { tool, definition } = toolWith(diff(EMPTY));

    expect(tool.name).toBe("git_diff");
    expect(tool.description).toBe("Git.");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["WORKTREE", "STAGED", "ALL"],
          default: "ALL",
          description: "Diff scope; defaults to ALL.",
        },
        path: { type: "string", minLength: 1, description: "Workspace-relative pathspec." },
      },
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "LOW",
      requiredCapabilities: ["GIT_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.effectProjector).toBeUndefined();
  });

  it("forwards each scope and the path through the canonical args bag", async () => {
    for (const scope of ["WORKTREE", "STAGED", "ALL"] as const) {
      const { tool, fake } = toolWith(diff({ ...EMPTY, scope }));
      const signal = testSignal();

      await tool.execute(executionInput({ scope, path: "src" }, { signal }));

      expect(fake.calls.diff).toEqual([
        { environment: ENVIRONMENT, args: { scope, path: "src" }, signal },
      ]);
    }
  });

  it("binds the default scope with an empty args bag, so the Tool never invents a pathspec", async () => {
    const { tool, fake } = toolWith(diff(EMPTY));

    await tool.execute(executionInput({}));

    // The Tool's *schema* advertises `ALL`, but the Runtime owns the default for an omitted scope.
    // Sending no key is what keeps one authority over the value.
    const call = fake.calls.diff[0] as { args: Record<string, unknown> };
    expect(call.args).toEqual({});
  });

  it("reports a bounded diff and its truncation metadata", async () => {
    const { tool } = toolWith(
      diff({
        diff: "--- a\n+++ b\n",
        scope: "WORKTREE",
        path: "src/a.ts",
        truncated: true,
        bytesReturned: 12,
        omittedBytes: 4096,
        hadDecodeReplacement: true,
      }),
    );

    await expect(tool.execute(executionInput({ scope: "WORKTREE", path: "src/a.ts" }))).resolves
      .toMatchObject({
        isError: false,
        content: "--- a\n+++ b\n",
        details: {
          ok: true,
          scope: "WORKTREE",
          path: "src/a.ts",
          truncated: true,
          bytesReturned: 12,
          omittedBytes: 4096,
          hadDecodeReplacement: true,
        },
      });
  });

  it("reports an empty diff as 'No changes.'", async () => {
    const { tool } = toolWith(diff(EMPTY));

    await expect(tool.execute(executionInput({}))).resolves.toMatchObject({
      isError: false,
      content: "No changes.",
    });
  });

  it("refuses an invalid scope or path without calling the port", async () => {
    const { tool, fake } = toolWith(diff(EMPTY));

    const badScope = await tool.execute(executionInput({ scope: "NOPE" }));
    expect(badScope).toMatchObject({
      isError: true,
      content: "Tool operation failed: INVALID_GIT_SCOPE.",
      details: { ok: false, error: "INVALID_GIT_SCOPE" },
    });

    const badPath = await tool.execute(executionInput({ path: 42 }));
    expect(badPath).toMatchObject({
      isError: true,
      content: "Tool operation failed: INVALID_GIT_PATH.",
      details: { error: "INVALID_GIT_PATH" },
    });

    expect(fake.calls.diff).toEqual([]);
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

  it("projects a DIFF resource access and a GIT_DIFF structural preview", () => {
    const { definition } = toolWith(diff(EMPTY));

    expect(definition.securityFactsProjector?.({ path: "src", scope: "STAGED" })).toEqual({
      resourceAccesses: [{ operation: "DIFF", path: "src" }],
      secretScanInputs: [],
      structuralPreview: { kind: "GIT_DIFF", path: "src", scope: "STAGED" },
    });
    expect(definition.securityFactsProjector?.({})).toMatchObject({
      resourceAccesses: [{ operation: "DIFF", path: "." }],
      structuralPreview: { kind: "GIT_DIFF", path: "." },
    });
  });
});
