import { createApplyPatchTool } from "@caelush/coding-agent";
import { ToolExecutionUncertainError } from "@caelush/agent";
import {
  RuntimeInvariantError,
  RuntimePatchError,
  RuntimePatchUncertainError,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT, executionInput, patchFake, testSignal } from "./support/operations-fixtures.js";

/**
 * `apply_patch` — the target Coding builtin.
 *
 * The uncertain boundary is the whole reason this Tool is careful: `RuntimePatchUncertainError` must
 * become the canonical `ToolExecutionUncertainError` from `@caelush/agent`, whose vocabulary the
 * executor already understands, and never an ordinary failure. A model told "the patch failed" would
 * patch again on top of a workspace whose state nobody observed.
 */

function toolWith(apply: Parameters<typeof patchFake>[0]) {
  const fake = patchFake(apply);
  const definition = createApplyPatchTool(fake.operations);
  return { tool: definition.tool, definition, fake };
}

function applied(changeCount: number, changes: readonly Record<string, unknown>[] = []) {
  return async () => ({ changeCount, changes: changes as never });
}

describe("apply_patch target builtin", () => {
  it("declares the frozen name, description, schema and risk metadata", () => {
    const { tool, definition } = toolWith(applied(0));

    expect(tool.name).toBe("apply_patch");
    expect(tool.description).toBe("Apply workspace patch.");
    expect(tool.executionMode).toBe("SEQUENTIAL");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        patch: { type: "string", minLength: 1, description: "The complete patch document." },
      },
      required: ["patch"],
      additionalProperties: false,
    });
    expect(definition.security).toEqual({
      riskLevel: "HIGH",
      requiredCapabilities: ["FS_WRITE", "FS_DELETE"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(definition.promptSnippet).toContain("apply_patch");
    expect(definition.effectProjector).toBeDefined();
  });

  it("applies a valid patch and reports its changes field for field", async () => {
    const changes = [
      { kind: "ADD", path: "a.ts", additions: 3, deletions: 0 },
      { kind: "UPDATE", path: "b.ts", additions: 1, deletions: 2 },
    ];
    const { tool, fake } = toolWith(applied(2, changes));
    const signal = testSignal();

    const result = await tool.execute(executionInput({ patch: "*** Begin Patch" }, { signal }));

    expect(result).toMatchObject({
      isError: false,
      content: "Patch applied.",
      details: { ok: true, changeCount: 2, changes },
    });
    expect(fake.calls[0]).toEqual({
      environment: ENVIRONMENT,
      patch: "*** Begin Patch",
      signal,
    });
  });

  it("refuses an empty or non-string patch without calling the port", async () => {
    const { tool, fake } = toolWith(applied(0));

    for (const patch of ["", 42, undefined, null]) {
      const result = await tool.execute(executionInput({ patch }));
      expect(result).toMatchObject({
        isError: true,
        content: "Tool operation failed: INVALID_PATCH.",
        details: { ok: false, error: "INVALID_PATCH" },
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it("maps an ordinary Runtime patch failure to its safe code", async () => {
    const { tool } = toolWith(async () => {
      throw new RuntimePatchError("PATCH_STALE", "the source changed");
    });

    await expect(tool.execute(executionInput({ patch: "x" }))).resolves.toMatchObject({
      isError: true,
      details: { ok: false, error: "PATCH_STALE" },
    });
  });

  it("converts an uncertain patch into the canonical uncertain signal", async () => {
    const { tool } = toolWith(async () => {
      throw new RuntimePatchUncertainError("rollback failed");
    });

    // Not `isError: true` — the executor must see the canonical uncertain error class, which it turns
    // into `FAILED` with the `UNCERTAIN_SIDE_EFFECT` marker and a batch-level trailing-call barrier.
    await expect(tool.execute(executionInput({ patch: "x" }))).rejects.toBeInstanceOf(
      ToolExecutionUncertainError,
    );
  });

  it("keeps a RuntimeInvariantError and an unknown error travelling", async () => {
    const invariant = toolWith(async () => {
      throw new RuntimeInvariantError("guarantee violated");
    }).tool;
    const unknown = toolWith(async () => {
      throw new Error("something else entirely");
    }).tool;

    await expect(invariant.execute(executionInput({ patch: "x" }))).rejects.toBeInstanceOf(
      RuntimeInvariantError,
    );
    await expect(unknown.execute(executionInput({ patch: "x" }))).rejects.toThrow(
      "something else entirely",
    );
  });

  it("produces one FILE_CHANGE per reported change and nothing on failure", () => {
    const { definition } = toolWith(applied(0));
    const request = { invocationId: "inv" as never, externalCallId: "c", args: {} };

    expect(
      definition.effectProjector?.({
        request,
        result: {
          content: "Patch applied.",
          details: {
            ok: true,
            changes: [
              { kind: "ADD", path: "a.ts", additions: 3, deletions: 0 },
              { kind: "UPDATE", path: "b.ts", additions: 1, deletions: 2 },
              {
                kind: "MOVE",
                path: "c.ts",
                fromPath: "old.ts",
                toPath: "c.ts",
                additions: 0,
                deletions: 0,
              },
              { kind: "DELETE", path: "d.ts", additions: 0, deletions: 4 },
            ],
          },
          isError: false,
        },
        now: 1,
      }),
    ).toEqual([
      { type: "FILE_CHANGE", summary: { path: "a.ts", changeType: "CREATED", additions: 3, deletions: 0 } },
      { type: "FILE_CHANGE", summary: { path: "b.ts", changeType: "MODIFIED", additions: 1, deletions: 2 } },
      {
        type: "FILE_CHANGE",
        fromPath: "old.ts",
        toPath: "c.ts",
        summary: { path: "c.ts", changeType: "MOVED", additions: 0, deletions: 0 },
      },
      { type: "FILE_CHANGE", summary: { path: "d.ts", changeType: "DELETED", additions: 0, deletions: 4 } },
    ]);

    expect(
      definition.effectProjector?.({
        request,
        result: { content: "x", details: { ok: false, error: "PATCH_STALE" }, isError: true },
        now: 1,
      }),
    ).toEqual([]);
  });

  it("projects the patch targets and a PATCH secret-scan input", () => {
    const { definition } = toolWith(applied(0));
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+one",
      "*** Update File: b.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n");

    const facts = definition.securityFactsProjector?.({ patch });
    expect(facts?.secretScanInputs).toEqual([{ kind: "PATCH", text: patch }]);
    expect(facts?.resourceAccesses).toEqual([
      { operation: "WRITE", path: "a.ts" },
      { operation: "WRITE", path: "b.ts" },
      { operation: "DELETE", path: "c.ts" },
    ]);
    expect(facts?.structuralPreview).toMatchObject({ kind: "PATCH" });
  });

  it("fails the projection closed for an invalid patch body", () => {
    const { definition } = toolWith(applied(0));

    expect(() => definition.securityFactsProjector?.({ patch: "" })).toThrow();
    expect(() => definition.securityFactsProjector?.({})).toThrow();
  });
});
