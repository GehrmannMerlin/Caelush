import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { releaseDirectoryLayout, waitForChildClose } from "../scripts/package-windows-release.mjs";
import { electronBuilderArguments, stripSourceMapsFromTree } from "../scripts/package-windows.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "..", "..");
const RELEASE_SCRIPT = path.join(APP_ROOT, "scripts", "package-windows-release.mjs");
const COMMON_PACKAGE_SCRIPT = path.join(APP_ROOT, "scripts", "package-windows.mjs");
const BUILDER_CONFIG = path.join(APP_ROOT, "electron-builder.config.cjs");
const require = createRequire(import.meta.url);
const TEMP_DIRECTORIES: string[] = [];

afterEach(async () => {
  await Promise.all(
    TEMP_DIRECTORIES.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function sanitizedEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CAELUSH_")) delete environment[key];
  }
  return { ...environment, ...overrides };
}

function resolveArtifactName(overrides: NodeJS.ProcessEnv) {
  const source = `process.stdout.write(require(${JSON.stringify(BUILDER_CONFIG)}).artifactName)`;
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: APP_ROOT,
    env: sanitizedEnvironment(overrides),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("Desktop Windows release packaging entry", () => {
  it("explicitly disables all Electron Builder publishing", () => {
    const args = electronBuilderArguments("nsis");
    const publishIndex = args.indexOf("--publish");

    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(args[publishIndex + 1]).toBe("never");
    expect(require(BUILDER_CONFIG).publish).toBeNull();
  });

  it("keeps the prepared temp directory outside the pipeline's new work root", () => {
    const buildRoot = path.join(tmpdir(), "caelush-release-build");
    const layout = releaseDirectoryLayout(buildRoot);

    expect(layout.tempRoot).toBe(path.join(buildRoot, "temp"));
    expect(layout.workRoot).toBe(path.join(buildRoot, "work"));
    expect(path.relative(layout.workRoot, layout.tempRoot).startsWith("..")).toBe(true);
  });

  it("removes production source maps and references while preserving runtime and native files", async () => {
    const stageRoot = await mkdtemp(path.join(tmpdir(), "caelush-production-stage-"));
    TEMP_DIRECTORIES.push(stageRoot);
    const runtimeDirectory = path.join(stageRoot, "daemon", "runtime");
    const nativeDirectory = path.join(stageRoot, "daemon", "node_modules", "node-pty");
    await mkdir(runtimeDirectory, { recursive: true });
    await mkdir(nativeDirectory, { recursive: true });
    const runtimePath = path.join(runtimeDirectory, "index.js");
    const runtimeMapPath = `${runtimePath}.map`;
    const declarationMapPath = path.join(runtimeDirectory, "index.d.ts.map");
    const nativePath = path.join(nativeDirectory, "conpty.node");
    const nativeBytes = Buffer.from([0, 1, 2, 255]);
    await writeFile(
      runtimePath,
      "export const runtime = true;\n//# sourceMappingURL=index.js.map\n",
    );
    await writeFile(runtimeMapPath, "{}\n");
    await writeFile(declarationMapPath, "{}\n");
    await writeFile(nativePath, nativeBytes);

    await stripSourceMapsFromTree(stageRoot);

    expect(await readFile(runtimePath, "utf8")).toBe("export const runtime = true;\n");
    expect(existsSync(runtimeMapPath)).toBe(false);
    expect(existsSync(declarationMapPath)).toBe(false);
    expect(await readFile(nativePath)).toEqual(nativeBytes);
  });

  it("waits for child output streams to close before finishing the pipeline", async () => {
    const child = new EventEmitter();
    const completion = waitForChildClose(child);
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", 0, null);
    await expect(completion).resolves.toEqual({ code: 0, signal: null });
  });

  it("uses the public stable installer name only for production stable builds", () => {
    expect(
      resolveArtifactName({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
        CAELUSH_DESKTOP_CHANNEL: "stable",
      }),
    ).toBe("Caelush-${version}-win-x64-Setup.${ext}");
    expect(
      resolveArtifactName({
        CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
        CAELUSH_DESKTOP_CHANNEL: "dev",
      }),
    ).toBe("Caelush-${version}-dev-win-x64-Setup.${ext}");
  });

  it("does not start fixtures or create output when the shared pipeline is imported", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "caelush-package-import-"));
    TEMP_DIRECTORIES.push(directory);
    const outputRoot = path.join(directory, "build-output");
    const resourceRoot = path.join(outputRoot, "resources");
    const source = `await import(${JSON.stringify(pathToFileURL(COMMON_PACKAGE_SCRIPT).href)})`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: REPOSITORY_ROOT,
      env: sanitizedEnvironment({
        CAELUSH_DESKTOP_OUTPUT_ROOT: outputRoot,
        CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT: resourceRoot,
      }),
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(outputRoot)).toBe(false);
  });

  it("rejects a missing external config before creating any release output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "caelush-release-entry-"));
    TEMP_DIRECTORIES.push(directory);
    const missingConfig = path.join(directory, "missing-production.json");
    const result = spawnSync(process.execPath, [RELEASE_SCRIPT, "--config", missingConfig], {
      cwd: REPOSITORY_ROOT,
      env: sanitizedEnvironment(),
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RELEASE_CONFIG_READ_FAILED");
    expect(result.stdout).not.toContain("RELEASE_BUILD_ROOT=");
  });
});
