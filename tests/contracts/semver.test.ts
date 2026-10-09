import { describe, expect, it } from "vitest";
import { compareSemVer, isValidSemVer } from "../../scripts/contracts/semver.mjs";

describe("SemVer 2.0.0 contract helpers", () => {
  it.each([
    ["0.1.0", "0.2.0"],
    ["0.9.0", "1.0.0"],
    ["1.0.0-beta.1", "1.0.0-beta.2"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.9", "1.0.10"],
    ["1.9.0", "1.10.0"],
    ["1.0.0-alpha.2", "1.0.0-alpha.10"],
  ])("orders %s before %s", (lower, higher) => {
    expect(compareSemVer(lower, higher)).toBe(-1);
    expect(compareSemVer(higher, lower)).toBe(1);
  });

  it("ignores build metadata for precedence while preserving valid syntax", () => {
    expect(isValidSemVer("1.2.3-beta.1+build.17")).toBe(true);
    expect(compareSemVer("1.2.3+build.1", "1.2.3+build.2")).toBe(0);
  });

  it.each(["1.02.3", "01.2.3", "1.2", "v1.2.3", "1.0.0-01", "1.0.0+"])(
    "rejects invalid SemVer %s",
    (version) => expect(isValidSemVer(version)).toBe(false),
  );
});
