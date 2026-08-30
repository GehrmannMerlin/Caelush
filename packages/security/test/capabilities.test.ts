import { describe, expect, it } from "vitest";
import { resolveGrantedCapabilities } from "../src/index.js";

describe("granted capability resolver", () => {
  it.each([
    ["READ_ONLY", ["FS_READ", "GIT_READ"]],
    [
      "PROJECT_ACCESS",
      ["FS_READ", "FS_WRITE", "FS_DELETE", "SHELL_EXEC", "PROCESS_START", "PROCESS_KILL", "GIT_READ"],
    ],
    [
      "FULL_ACCESS",
      [
        "FS_READ",
        "FS_WRITE",
        "FS_DELETE",
        "SHELL_EXEC",
        "PROCESS_START",
        "PROCESS_KILL",
        "GIT_READ",
        "WEB_SEARCH",
        "WEB_FETCH",
        "OUTSIDE_WORKSPACE",
      ],
    ],
  ] as const)("resolves the %s capability matrix", (profile, expected) => {
    const granted = resolveGrantedCapabilities(profile);
    expect([...granted]).toEqual(expected);
    expect(resolveGrantedCapabilities(profile)).toEqual(granted);
  });

  it("does not expose a mutable capability set", () => {
    const granted = resolveGrantedCapabilities("READ_ONLY");
    expect(Object.isFrozen(granted)).toBe(true);
    expect(() => (granted as Set<string>).add("FS_WRITE")).toThrow();
    expect(granted.has("FS_WRITE")).toBe(false);
  });
});
