import { describe, expect, it } from "vitest";

import type { ToolPreparationFailureFact } from "@caelush/agent";

import {
  describePatternFields,
  modelArgumentRejectionFact,
  preparationFailureFactFromRejection,
  resourceProgressTurn,
  toolFailurePatternKey,
  type ResourceProgressPattern,
} from "../src/resource-progress-classifier.js";

/**
 * The classifier turns accepted results into facts the resource window can count.
 *
 * The regression it exists for: a model sent `apply_patch` with the wrong field name 64 times while
 * changing the patch body every time. The old progress check compared whole request/result
 * fingerprints, so every new body looked like progress and nothing ever escalated.
 */

function rejection(overrides: { readonly content?: string; readonly issues?: unknown } = {}) {
  return {
    code: "TOOL_ARGUMENT_ERROR",
    disposition: "SAFE_FAILURE",
    content:
      overrides.content ?? "Arguments for apply_patch do not match its declared input schema.",
    details: {
      issues: overrides.issues ?? [
        {
          path: "",
          keyword: "required",
          property: "patch",
          message: "must have required property",
        },
        {
          path: "",
          keyword: "additionalProperties",
          property: "input",
          message: "must NOT have additional properties",
        },
      ],
    },
  };
}

function factFor(overrides: { readonly patchText?: string; readonly property?: string }) {
  const fact = preparationFailureFactFromRejection(rejection({ content: overrides.patchText }));
  if (fact === undefined) throw new Error("expected a preparation failure fact");
  if (overrides.property === undefined) return fact;
  return {
    ...fact,
    issues: [{ keyword: "required", property: overrides.property }],
  } satisfies ToolPreparationFailureFact;
}

describe("preparation failure classification", () => {
  it("gives the same pattern to 64 attempts whose patch bodies all differ", () => {
    const keys = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      keys.add(
        toolFailurePatternKey({
          toolName: "apply_patch",
          fact: factFor({ patchText: `invalid call ${String(index)}: ${"x".repeat(index)}` }),
        }),
      );
    }
    expect(keys.size).toBe(1);
  });

  it("separates a different field problem from the same rejection code", () => {
    const missingPatch = toolFailurePatternKey({
      toolName: "apply_patch",
      fact: factFor({}),
    });
    const missingOther = toolFailurePatternKey({
      toolName: "apply_patch",
      fact: factFor({ property: "content" }),
    });
    const otherTool = toolFailurePatternKey({
      toolName: "write_file",
      fact: factFor({}),
    });
    expect(new Set([missingPatch, missingOther, otherTool]).size).toBe(3);
  });

  it("does not depend on unstable array order", () => {
    const forward = toolFailurePatternKey({ toolName: "apply_patch", fact: factFor({}) });
    const reversed = toolFailurePatternKey({
      toolName: "apply_patch",
      fact: {
        ...factFor({}),
        issues: [...factFor({}).issues].reverse(),
      },
    });
    expect(reversed).toBe(forward);
  });

  it("counts one occurrence per batch even when the same mistake repeats inside it", () => {
    const fact = factFor({});
    const turn = resourceProgressTurn({
      turnId: "step-1",
      results: [
        { toolName: "apply_patch", isError: true, preparationFailure: fact },
        { toolName: "apply_patch", isError: true, preparationFailure: fact },
        { toolName: "apply_patch", isError: true, preparationFailure: fact },
      ],
    });
    expect(turn?.patterns).toHaveLength(1);
  });

  it("records a successful call as success rather than as a failure pattern", () => {
    const turn = resourceProgressTurn({
      turnId: "step-2",
      results: [
        { toolName: "apply_patch", isError: false },
        { toolName: "read_file", isError: false },
      ],
    });
    expect(turn).toMatchObject({
      patterns: [],
      succeededTools: ["apply_patch", "read_file"],
      classified: true,
    });
  });

  it("keeps a real execution failure out of the schema pattern namespace", () => {
    const turn = resourceProgressTurn({
      turnId: "step-3",
      results: [{ toolName: "exec_command", isError: true }],
    });
    expect(turn?.patterns).toEqual([]);
    expect(turn?.succeededTools).toEqual([]);
  });

  it("describes the declared fields without quoting an argument value", () => {
    const fact = factFor({});
    const pattern = {
      key: "k",
      toolName: "apply_patch",
      code: fact.code,
      fields: [
        { keyword: "required", name: "patch" },
        { keyword: "additionalProperties", name: "input" },
      ],
    } satisfies ResourceProgressPattern;
    expect(describePatternFields(pattern.fields)).toBe(
      'missing required "patch", unsupported "input"',
    );
  });

  it("gives malformed-argument attempts one pattern regardless of the argument byte count", () => {
    // Five rounds that only change whitespace are one repeated mistake. The durable fact therefore
    // carries no byte count at all, and its serialized form proves it.
    const fact = modelArgumentRejectionFact({
      code: "TOOL_ARGUMENTS_REJECTED",
      issueCode: "MALFORMED_JSON",
    });
    expect(JSON.stringify(fact)).not.toMatch(/argumentBytes|12|4096/);
    const keys = new Set(
      [0, 1, 2, 3, 4].map(() =>
        toolFailurePatternKey({
          toolName: "apply_patch",
          fact: modelArgumentRejectionFact({
            code: "TOOL_ARGUMENTS_REJECTED",
            issueCode: "MALFORMED_JSON",
          }),
        }),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("keeps the three parsing reasons apart and separate from a schema rejection", () => {
    const keys = new Set(
      (["MALFORMED_JSON", "EXPECTED_OBJECT", "INCOMPLETE_ARGUMENTS"] as const).map((issueCode) =>
        toolFailurePatternKey({
          toolName: "apply_patch",
          fact: modelArgumentRejectionFact({ code: "TOOL_ARGUMENTS_REJECTED", issueCode }),
        }),
      ),
    );
    expect(keys.size).toBe(3);
    expect(keys.has(toolFailurePatternKey({ toolName: "apply_patch", fact: factFor({}) }))).toBe(
      false,
    );
  });

  it("counts a malformed request as one pattern in the window", () => {
    const fact = modelArgumentRejectionFact({
      code: "TOOL_ARGUMENTS_REJECTED",
      issueCode: "MALFORMED_JSON",
    });
    const turn = resourceProgressTurn({
      turnId: "step-4",
      results: [{ toolName: "apply_patch", isError: true, preparationFailure: fact }],
    });
    expect(turn?.classified).toBe(true);
    expect(turn?.patterns).toHaveLength(1);
    expect(turn?.patterns[0]?.code).toBe("TOOL_ARGUMENTS_REJECTED");
    expect(describePatternFields(turn?.patterns[0]?.fields ?? [])).toBe(
      "arguments that are not valid JSON",
    );
  });
});
