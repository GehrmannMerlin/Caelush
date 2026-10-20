import type { JsonObject } from "@caelush/ai";
import { DefaultAgentToolRegistryBuilder, createToolCallPreparer } from "@caelush/agent";
import { describe, expect, it } from "vitest";
import {
  APPLY_PATCH_ARGUMENT_EXAMPLE,
  applyPatchInputSchema,
  createApplyPatchTool,
  isApplyPatchInputCompatibilityShape,
  normalizeApplyPatchArguments,
  type PatchOperations,
} from "../src/index.js";

/**
 * The one bounded argument compatibility `apply_patch` performs.
 *
 * ```text
 * raw model arguments
 *   → the Tool's prepareArguments hook      (this file's subject)
 *   → canonical byte bound
 *   → the real input schema
 *   → canonical fingerprint / approval identity
 *   → Guard, Security, handler              (which only ever see `patch`)
 * ```
 *
 * The tests run through the real Preparer, because "the shape is normalized" is not the property that
 * matters — "the same call, prepared, validated and admitted identically" is. A handler-level alias
 * would pass a unit test and still hand Security a shape it never agreed to analyze.
 */

const operations: PatchOperations = {
  apply: async () => {
    throw new Error("preparation tests never execute the patch");
  },
} as unknown as PatchOperations;

function registry() {
  const { tool } = createApplyPatchTool(operations);
  const builder = new DefaultAgentToolRegistryBuilder();
  builder.register(tool);
  return builder.build();
}

function prepare(args: JsonObject) {
  return createToolCallPreparer(registry()).prepare({
    externalCallId: "call-patch-1",
    toolName: "apply_patch",
    args,
  });
}

describe("apply_patch argument compatibility", () => {
  it("compiles the documented example against the real schema", () => {
    const { inputValidator } = registry().resolve("apply_patch")!;
    expect(inputValidator.validate(APPLY_PATCH_ARGUMENT_EXAMPLE).valid).toBe(true);
  });

  it("prepares the canonical shape unchanged", () => {
    const outcome = prepare({ ...APPLY_PATCH_ARGUMENT_EXAMPLE });
    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(outcome.call.args).toEqual({ patch: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
  });

  it("prepares the known {input} drift into the identical canonical arguments", () => {
    const canonical = prepare({ patch: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    const drifted = prepare({ input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    expect(drifted.kind).toBe("READY");
    if (canonical.kind !== "READY" || drifted.kind !== "READY") return;
    // The whole point: one identity, one set of arguments, whichever spelling arrived.
    expect(drifted.call.args).toEqual(canonical.call.args);
  });

  it("refuses a shape carrying both keys instead of choosing a document", () => {
    const outcome = prepare({ input: "*** Begin Patch", patch: "*** Begin Patch" });
    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") return;
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
    expect(outcome.feedback.content).toContain("patch");
  });

  it("refuses an unknown extra field alongside input", () => {
    const outcome = prepare({ input: "*** Begin Patch", reason: "retry" });
    expect(outcome.kind).toBe("REJECTED");
  });

  it("refuses a non-string input", () => {
    expect(prepare({ input: 42 } as unknown as JsonObject).kind).toBe("REJECTED");
    expect(prepare({ input: null } as unknown as JsonObject).kind).toBe("REJECTED");
    expect(prepare({ input: { patch: "x" } } as unknown as JsonObject).kind).toBe("REJECTED");
  });

  it("refuses an empty document after normalization", () => {
    const outcome = prepare({ input: "" });
    expect(outcome.kind).toBe("REJECTED");
  });

  it("refuses an oversized document before and after normalization", () => {
    const huge = "x".repeat(300 * 1024);
    expect(prepare({ patch: huge }).kind).toBe("REJECTED");
    expect(prepare({ input: huge }).kind).toBe("REJECTED");
  });

  it("keeps the compatibility check narrow", () => {
    expect(isApplyPatchInputCompatibilityShape({ input: "x" })).toBe(true);
    expect(isApplyPatchInputCompatibilityShape({ input: "x", patch: "y" })).toBe(false);
    expect(isApplyPatchInputCompatibilityShape({ input: "x", extra: 1 })).toBe(false);
    expect(isApplyPatchInputCompatibilityShape({ input: 1 })).toBe(false);
    expect(isApplyPatchInputCompatibilityShape({ patch: "x" })).toBe(false);
    expect(normalizeApplyPatchArguments({ input: "x", patch: "y" })).toEqual({
      input: "x",
      patch: "y",
    });
  });

  it("declares the canonical key and no alternative in the schema", () => {
    const properties = (applyPatchInputSchema as { readonly properties: JsonObject }).properties;
    expect(Object.keys(properties)).toEqual(["patch"]);
    expect((applyPatchInputSchema as { readonly required: readonly string[] }).required).toEqual([
      "patch",
    ]);
  });
});
