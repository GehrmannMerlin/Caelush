import { describe, expect, it } from "vitest";
import { classifyExecutionContainment, requiresUnconfinedProcess } from "../src/index.js";

describe("execution containment", () => {
  it.each([
    [[], "STRUCTURED_WORKSPACE"],
    [["FS_READ"], "STRUCTURED_WORKSPACE"],
    [["FS_WRITE", "FS_DELETE"], "STRUCTURED_WORKSPACE"],
    [["GIT_READ"], "STRUCTURED_WORKSPACE"],
    [["SHELL_EXEC"], "UNCONFINED_PROCESS"],
    [["PROCESS_START"], "UNCONFINED_PROCESS"],
    [["PROCESS_KILL"], "UNCONFINED_PROCESS"],
  ] as const)("classifies %j from capability metadata", (required, expected) => {
    expect(classifyExecutionContainment(required)).toBe(expected);
    expect(requiresUnconfinedProcess(required)).toBe(expected === "UNCONFINED_PROCESS");
  });

  it("does not depend on a Tool name", () => {
    expect(classifyExecutionContainment(["SHELL_EXEC"])).toBe("UNCONFINED_PROCESS");
  });
});
