import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDesktopBuildReady,
  prepareDesktopStartSandbox,
  resolveDesktopDevelopmentConfiguration,
} from "../../scripts/development-launch.mjs";
import { createRendererTrust } from "../../src/main/windows/security-policy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop development launch", () => {
  it("builds the static account renderer before starting the dev app", async () => {
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { scripts: Record<string, string> };
    const devScript = packageJson.scripts.dev;
    const rendererBuildIndex = devScript.indexOf("vite build");
    const devLaunchIndex = devScript.indexOf("node scripts/dev.mjs");

    expect(rendererBuildIndex).toBeGreaterThanOrEqual(0);
    expect(devLaunchIndex).toBeGreaterThan(rendererBuildIndex);
  });

  it("discovers the existing sandbox runner without invoking a native build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-start-sandbox-test-"));
    roots.push(root);
    const result = await prepareDesktopStartSandbox({
      platform: "win32",
      repositoryRoot: path.join(root, "repo"),
      homeDirectory: path.join(root, "home"),
      environment: {},
      build: async () => {
        throw new Error("start must not build");
      },
      discover: async () => ({
        binaryPath: path.join(root, "home", "runner.exe"),
        manifestPath: path.join(root, "home", "runner.json"),
      }),
    });
    expect(result.status).toBe("CONFIGURED");
    expect(result.environment.CAELUSH_SANDBOX_RUNNER_PATH).toBe(
      path.join(root, "home", "runner.exe"),
    );
  });

  it("uses the same isolated profile and browser data for dev and start", () => {
    const appRoot = path.resolve("desktop-launch-fixture");
    const configuration = resolveDesktopDevelopmentConfiguration(appRoot, [], {});
    expect(configuration.dataRoot).toBe(path.join(appRoot, ".stage", "development"));
    expect(configuration.userDataDirectory).toBe(
      path.join(appRoot, ".stage", "development", "electron-user-data"),
    );
    expect(configuration.runtimeCacheRoot).toBe(path.join(appRoot, ".stage", "electron-runtime"));
    const origin = `http://127.0.0.1:${configuration.rendererPort}`;
    expect(createRendererTrust(false, origin, true)).toEqual({
      developmentOrigin: origin,
      allowLoginIpc: true,
    });
  });

  it("preserves an explicit isolated profile override", () => {
    const appRoot = path.resolve("desktop-launch-fixture");
    const dataRoot = path.resolve("custom-desktop-profile");
    const configuration = resolveDesktopDevelopmentConfiguration(
      appRoot,
      ["--isolated-data-dir", dataRoot],
      {},
    );
    expect(configuration.dataRoot).toBe(dataRoot);
    expect(configuration.runtimeCacheRoot).toBe(path.join(dataRoot, "temp", "electron-runtime"));
    expect(configuration.rendererPort).toBe(5174);
  });

  it("rejects a relative data directory before opening processes", () => {
    expect(() =>
      resolveDesktopDevelopmentConfiguration(
        path.resolve("fixture"),
        ["--isolated-data-dir", "relative"],
        {},
      ),
    ).toThrow(/absolute/i);
  });

  it("reports missing build artifacts with the rebuild command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-launch-test-"));
    roots.push(root);
    await expect(assertDesktopBuildReady(path.join(root, "apps", "desktop"))).rejects.toThrow(
      /pnpm.*@caelush\/desktop.*build/,
    );
  });

  it("accepts an existing build without generating or rebuilding files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-launch-test-"));
    roots.push(root);
    const appRoot = path.join(root, "apps", "desktop");
    for (const name of [
      "dist/main/index.js",
      "dist/preload/index.cjs",
      "dist/renderer/index.html",
      ".stage/daemon/node.exe",
      ".stage/daemon/user-terminal-helper.mjs",
      "../daemon/dist/desktop-entry.js",
      ".stage/web/index.html",
    ]) {
      const target = path.join(appRoot, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "built");
    }
    await expect(assertDesktopBuildReady(appRoot)).resolves.toBeUndefined();
  });
});
