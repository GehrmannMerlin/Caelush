import { describe, expect, it } from "vitest";

import { createCodingToolComposition } from "./support/coding-tool-composition.js";

/**
 * The Coding catalog's scheduling declarations.
 *
 * The batch coordinator may only let a call run after an earlier call in the same batch failed when
 * the Tool proves it cannot depend on unobserved state. That proof has to survive the two copies the
 * production path makes — `createDefaultCodingTools` and the registry's frozen clone — so these
 * assertions read the **registry**, not the definition array.
 *
 * The classes themselves are a product statement:
 *
 * ```text
 * reads and Git queries   READ_ONLY      safe after a failure
 * plan bookkeeping        CONTROL_STATE  safe after a failure; it writes no workspace state
 * apply_patch             MAY_MUTATE     withheld after a failure
 * process / shell tools   UNKNOWN        withheld after a failure; the arguments cannot prove safety
 * ```
 */
describe("Coding Tool scheduling facts", () => {
  const { registry } = createCodingToolComposition();

  it.each([
    "read_file",
    "list_directory",
    "find_files",
    "search_text",
    "git_status",
    "git_diff",
    "read_attachment",
  ])("declares %s as read-only through the frozen registry", (name) => {
    expect(registry.resolve(name)?.tool.scheduling).toEqual({ class: "READ_ONLY" });
  });

  it("declares plan bookkeeping as control state and patch application as a mutation", () => {
    expect(registry.resolve("update_plan")?.tool.scheduling).toEqual({ class: "CONTROL_STATE" });
    expect(registry.resolve("apply_patch")?.tool.scheduling).toEqual({ class: "MAY_MUTATE" });
  });

  it.each(["exec_command", "write_stdin", "stop_process"])(
    "declares %s as unknown rather than guessing from its arguments",
    (name) => {
      expect(registry.resolve(name)?.tool.scheduling).toEqual({ class: "UNKNOWN" });
    },
  );
});
