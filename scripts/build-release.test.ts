import { describe, expect, it } from "vitest";
import { getPlatformArtifactName, rewriteWorkspaceDependencies } from "./build-release.mjs";

describe("release bundle helpers", () => {
  it("names artifacts by product version and target platform", () => {
    expect(getPlatformArtifactName("0.1.0", "win32", "x64")).toBe("caelush-v0.1.0-windows-x64.tgz");
    expect(getPlatformArtifactName("0.1.0", "darwin", "arm64")).toBe(
      "caelush-v0.1.0-macos-arm64.tgz",
    );
  });

  it("rewrites workspace ranges to concrete versions for a pnpm-free artifact", () => {
    const manifest = {
      name: "@caelush/launcher",
      version: "0.1.0",
      dependencies: { "@caelush/cli": "workspace:*", fastify: "5.12.1" },
    };
    expect(rewriteWorkspaceDependencies(manifest, { "@caelush/cli": "0.1.0" })).toEqual({
      ...manifest,
      dependencies: { "@caelush/cli": "0.1.0", fastify: "5.12.1" },
    });
  });
});
