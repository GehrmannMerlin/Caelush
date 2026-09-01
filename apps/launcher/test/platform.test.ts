import { describe, expect, it } from "vitest";
import {
  isSupportedPlatform,
  nodeVersionInRange,
  SUPPORTED_PLATFORM_MATRIX,
} from "../src/platform.js";

describe("launcher platform preflight", () => {
  it("accepts only Node 24.x", () => {
    expect(nodeVersionInRange("24.0.0")).toBe(true);
    expect(nodeVersionInRange("24.13.3")).toBe(true);
    expect(nodeVersionInRange("23.9.0")).toBe(false);
    expect(nodeVersionInRange("25.0.0")).toBe(false);
    expect(nodeVersionInRange("not-a-version")).toBe(false);
  });

  it("defines the four V1 target pairs", () => {
    expect(SUPPORTED_PLATFORM_MATRIX).toEqual([
      { platform: "win32", arch: "x64", label: "Windows x64" },
      { platform: "linux", arch: "x64", label: "Linux x64" },
      { platform: "darwin", arch: "arm64", label: "macOS arm64" },
      { platform: "darwin", arch: "x64", label: "macOS x64" },
    ]);
    expect(isSupportedPlatform("win32", "x64")).toBe(true);
    expect(isSupportedPlatform("win32", "arm64")).toBe(false);
  });
});
