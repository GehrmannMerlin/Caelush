import type { JsonObject } from "@caelush/ai";
import {
  DefaultAgentToolRegistryBuilder,
  ToolPreparationInfrastructureError,
  canonicalJsonString,
  createToolCallPreparer,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";
import {
  APPLY_PATCH_ARGUMENT_EXAMPLE,
  applyPatchInputSchema,
  computeToolSecurityEffectIdentity,
  createApplyPatchTool,
  createLegacyNumericArgumentNormalization,
  isApplyPatchInputCompatibilityShape,
  normalizeApplyPatchArguments,
  projectApplyPatchSecurityFacts,
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

/**
 * The production composition, not the Tool in isolation.
 *
 * `apps/daemon` registers the Preparer with BOTH the Tool's own `prepareArguments` hook and the
 * registration-level numeric normalization. Testing one hook alone is what let the historical
 * regression through: the first hook returned a frozen object and the second assumed it could write
 * to its input.
 */
function prepareInProduction(args: JsonObject) {
  return createToolCallPreparer(registry(), {
    normalization: createLegacyNumericArgumentNormalization(),
  }).prepare({
    externalCallId: "call-patch-1",
    toolName: "apply_patch",
    args,
  });
}

/**
 * Arguments whose canonical serialization is exactly `targetBytes` UTF-8 bytes.
 *
 * A byte bound can only be tested at its own boundary: a "very large" string proves that *some* limit
 * exists, not that the limit is 262,144 bytes rather than, say, 65,536. The filler mixes a three-byte
 * character with ASCII so every remainder is reachable.
 */
function argsOfJsonBytes(key: "input" | "patch", targetBytes: number): JsonObject {
  const empty = { [key]: "" };
  const remaining = targetBytes - Buffer.byteLength(canonicalJsonString(empty), "utf8");
  const multiByte = Math.floor(remaining / 3);
  const text = "中".repeat(multiByte) + "x".repeat(remaining - multiByte * 3);
  const args = { [key]: text };
  expect(Buffer.byteLength(canonicalJsonString(args), "utf8")).toBe(targetBytes);
  return args;
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

  /**
   * The exact historical failure shape, through the exact production chain.
   *
   * A model sent `apply_patch({ input: "<41 KB patch>" })`. The Tool's hook canonicalized it into a
   * frozen `{ patch }`; the next hook wrote to that frozen object and threw, which failed the whole
   * Run before any invocation existed. The correct behavior is a normal READY outcome with one key.
   */
  it("prepares the exact input alias with the production numeric normalizer", () => {
    const args: JsonObject = { input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch };
    const outcome = prepareInProduction(args);

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") return;
    expect(Object.keys(outcome.call.args)).toEqual(["patch"]);
    expect(outcome.call.args).toEqual({ patch: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    // The model's own argument object is not a scratch buffer for either hook.
    expect(args).toEqual({ input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
  });

  it("gives both spellings one identity through the production composition", () => {
    const canonical = prepareInProduction({ patch: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    const drifted = prepareInProduction({ input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    expect(canonical.kind).toBe("READY");
    expect(drifted.kind).toBe("READY");
    if (canonical.kind !== "READY" || drifted.kind !== "READY") return;
    expect(drifted.call.args).toEqual(canonical.call.args);
    // Preparing twice must not accumulate state in the frozen normalization object.
    const repeated = prepareInProduction({ input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    expect(repeated.kind).toBe("READY");
    if (repeated.kind !== "READY") return;
    expect(repeated.call.args).toEqual(drifted.call.args);
  });

  /**
   * The compatibility must not change what the call *is*. Approval reuse is keyed on the projected
   * effect identity, so a drifted spelling that produced a different digest would re-prompt the user
   * for a patch they already approved.
   */
  it("gives both spellings one security effect identity", () => {
    const canonical = prepareInProduction({ patch: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    const drifted = prepareInProduction({ input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch });
    if (canonical.kind !== "READY" || drifted.kind !== "READY") {
      throw new Error("both spellings must prepare");
    }

    const canonicalFacts = projectApplyPatchSecurityFacts(canonical.call.args);
    const driftedFacts = projectApplyPatchSecurityFacts(drifted.call.args);

    expect(computeToolSecurityEffectIdentity(driftedFacts)).toEqual(
      computeToolSecurityEffectIdentity(canonicalFacts),
    );
    expect(canonicalFacts.resourceAccesses.length).toBeGreaterThan(0);
  });

  /**
   * The byte bound is the Preparer's, and it is measured in UTF-8 bytes of the canonical
   * serialization — not in characters, not in UTF-16 code units. Both spellings are measured before
   * and after normalization, so an alias cannot be a way around the limit.
   */
  it("bounds both spellings at exactly 262,144 UTF-8 bytes", () => {
    const max = 256 * 1024;
    for (const key of ["patch", "input"] as const) {
      const atLimit = prepareInProduction(argsOfJsonBytes(key, max));
      expect(atLimit.kind, `${key} at the limit`).toBe("READY");

      const overLimit = prepareInProduction(argsOfJsonBytes(key, max + 1));
      expect(overLimit.kind, `${key} over the limit`).toBe("REJECTED");
      if (overLimit.kind !== "REJECTED") return;
      expect(overLimit.feedback.code).toBe("TOOL_ARGUMENTS_TOO_LARGE");
    }
  });

  it("measures multi-byte patch text in bytes, not in characters", () => {
    // 100,000 CJK characters: well under the limit by `String.length`, over it by UTF-8 bytes.
    const text = "中".repeat(100_000);
    expect(text.length).toBeLessThan(256 * 1024);
    expect(prepareInProduction({ patch: text }).kind).toBe("REJECTED");
    expect(prepareInProduction({ input: text }).kind).toBe("REJECTED");
  });

  it("keeps a model argument error a rejection under the production composition", () => {
    const outcome = prepareInProduction({ input: "*** Begin Patch", patch: "*** Begin Patch" });
    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") return;
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
  });

  it("never reports the production composition as an infrastructure failure", () => {
    const shapes: JsonObject[] = [
      { input: APPLY_PATCH_ARGUMENT_EXAMPLE.patch },
      { patch: APPLY_PATCH_ARGUMENT_EXAMPLE.patch },
      { input: "" },
      { input: 42 } as unknown as JsonObject,
      { input: "*** Begin Patch", extra: true },
    ];
    for (const shape of shapes) {
      let thrown: unknown;
      try {
        prepareInProduction(shape);
      } catch (error) {
        thrown = error;
      }
      expect(
        thrown,
        `unexpected infrastructure failure for ${JSON.stringify(shape)}`,
      ).toBeUndefined();
      expect(thrown instanceof ToolPreparationInfrastructureError).toBe(false);
    }
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
