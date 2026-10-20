import { ToolSchemaRuntime, renderToolSchemaFeedback } from "@caelush/agent";
import {
  APPLY_PATCH_ARGUMENT_EXAMPLE,
  APPLY_PATCH_PROMPT_SNIPPET,
  applyPatchInputSchema,
} from "@caelush/coding-agent";
import { describe, expect, it } from "vitest";

/**
 * `apply_patch` guidance is only useful if it is the schema.
 *
 * The historical failure was 64 calls of `{"input": "..."}` against a schema that declares exactly
 * one field, `patch`. The fix is not a longer description — it is an example that the real compiled
 * schema accepts, and feedback that names the field the model actually has to change.
 */
describe("apply_patch argument guidance", () => {
  it("documents an argument object the real schema accepts", () => {
    const runtime = new ToolSchemaRuntime();
    const compiled = runtime.compile(applyPatchInputSchema as never);

    expect(compiled.validate(APPLY_PATCH_ARGUMENT_EXAMPLE)).toEqual({ valid: true });
    expect(Object.keys(APPLY_PATCH_ARGUMENT_EXAMPLE)).toEqual(["patch"]);
  });

  it("publishes the canonical shape in the bounded prompt snippet", () => {
    expect(APPLY_PATCH_PROMPT_SNIPPET).toContain("apply_patch");
    expect(APPLY_PATCH_PROMPT_SNIPPET).toContain('"patch"');
    expect(APPLY_PATCH_PROMPT_SNIPPET).toContain("there is no input field");
    expect(Buffer.byteLength(APPLY_PATCH_PROMPT_SNIPPET, "utf8")).toBeLessThan(4096);
  });

  it("tells a model why the historical input-only call is rejected", () => {
    const compiled = new ToolSchemaRuntime().compile(applyPatchInputSchema as never);
    const validation = compiled.validate({ input: "*** Begin Patch\n*** End Patch" });
    if (validation.valid) throw new Error("expected the input-only call to be invalid");

    const feedback = renderToolSchemaFeedback({
      toolName: "apply_patch",
      issues: validation.issues,
      ...(validation.truncatedIssueCount === undefined
        ? {}
        : { truncatedIssueCount: validation.truncatedIssueCount }),
    });

    expect(feedback).toContain('missing required field "patch"');
    expect(feedback).toContain('unsupported field "input"');
    expect(feedback).toContain('declared fields are "patch"');
    expect(feedback).not.toContain("*** Begin Patch");
  });
});
