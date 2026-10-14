import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import webConfig from "../../../web/vite.config.js";
import { resolveDesktopWebRoot } from "../../src/main/daemon/resources.js";

vi.mock("../../src/main/build-config.js", () => ({ BUILD_CONFIGURATION: {} }));

describe("independent Web/Desktop build outputs", () => {
  it("keeps each output outside the other target's cleanable directory", () => {
    if (typeof webConfig !== "function") throw new Error("expected a mode-aware config");
    const webRoot = fileURLToPath(new URL("../../../web/", import.meta.url));
    const normal = webConfig({ command: "build", mode: "production" });
    const desktop = webConfig({ command: "build", mode: "desktop" });
    const normalOutput = path.resolve(webRoot, normal.build?.outDir ?? "dist");
    const desktopOutput = path.resolve(webRoot, desktop.build?.outDir ?? "dist");
    expect(path.relative(normalOutput, desktopOutput).startsWith(`..${path.sep}`)).toBe(true);
    expect(path.relative(desktopOutput, normalOutput).startsWith(`..${path.sep}`)).toBe(true);
    const appPath = fileURLToPath(new URL("../../", import.meta.url));
    expect(resolveDesktopWebRoot({ packaged: false, appPath, resourcesPath: "unused" })).toBe(
      desktopOutput,
    );
  });
});
