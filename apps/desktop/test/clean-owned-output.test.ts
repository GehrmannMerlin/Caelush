import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanDesktopDevelopmentOutput,
  cleanDesktopReleaseOutput,
} from "../scripts/clean-owned-output.mjs";
import { assertOwnedOutputPath } from "../scripts/owned-output-path.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-output-clean-test-"));
  roots.push(root);
  const app = path.join(root, "apps", "desktop");
  await mkdir(app, { recursive: true });
  return { root, app };
}
async function put(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "keep-or-remove");
}

describe("owned Desktop output cleanup", () => {
  it("also removes the packaging resource copy without touching development state", async () => {
    const { root, app } = await fixture();
    const packed = path.join(app, ".build-resources", "daemon", "package.json");
    const dev = path.join(app, ".stage", "daemon", "node.exe");
    await Promise.all([put(packed), put(dev)]);
    await cleanDesktopReleaseOutput(root);
    await expect(readFile(packed)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(dev, "utf8")).resolves.toBe("keep-or-remove");
  });

  it("removes installers while preserving development files and other release outputs", async () => {
    const { root, app } = await fixture();
    const installer = path.join(root, "release-artifacts", "desktop", "setup.exe");
    const dev = path.join(app, "dist", "main", "index.js");
    const other = path.join(root, "release-artifacts", "sandbox", "runner.exe");
    await Promise.all([put(installer), put(dev), put(other)]);
    expect(await cleanDesktopReleaseOutput(root)).toEqual([path.dirname(installer)]);
    await expect(readFile(installer)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(dev, "utf8")).resolves.toBe("keep-or-remove");
    await expect(readFile(other, "utf8")).resolves.toBe("keep-or-remove");
  });

  it("cleans rebuildable development output and preserves source, dependencies, and profile data", async () => {
    const { app } = await fixture();
    const generated = [
      "dist/main/index.js",
      ".stage/daemon/node.exe",
      ".stage/web/index.html",
      ".stage/electron-runtime/current/electron.exe",
    ];
    const retained = [
      "src/main/index.ts",
      "node_modules/electron/electron.exe",
      ".stage/development/electron-user-data/credentials.dpapi",
    ];
    await Promise.all([...generated, ...retained].map((file) => put(path.join(app, file))));
    await cleanDesktopDevelopmentOutput(app);
    for (const file of generated)
      await expect(readFile(path.join(app, file))).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of retained)
      await expect(readFile(path.join(app, file), "utf8")).resolves.toBe("keep-or-remove");
  });

  it("supports a dry run and missing outputs", async () => {
    const { root } = await fixture();
    expect(await cleanDesktopReleaseOutput(root)).toEqual([]);
    const installer = path.join(root, "release-artifacts", "desktop", "setup.exe");
    await put(installer);
    expect(await cleanDesktopReleaseOutput(root, { dryRun: true })).toEqual([
      path.dirname(installer),
    ]);
    await expect(readFile(installer, "utf8")).resolves.toBe("keep-or-remove");
  });

  it("refuses an output root or a target outside it", async () => {
    const { root } = await fixture();
    await expect(assertOwnedOutputPath(root, root)).rejects.toThrow(/owned/i);
    await expect(assertOwnedOutputPath(root, path.join(root, "..", "outside"))).rejects.toThrow(
      /owned/i,
    );
  });

  it("validates every target before deleting and rejects linked output", async () => {
    const { root, app } = await fixture();
    const retained = path.join(root, "retained", "important");
    await put(retained);
    await put(path.join(app, "dist", "main.js"));
    await mkdir(path.join(app, ".stage"));
    await symlink(
      path.dirname(retained),
      path.join(app, ".stage", "daemon"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(cleanDesktopDevelopmentOutput(app)).rejects.toThrow(/symbolic link|junction/i);
    await expect(readFile(retained, "utf8")).resolves.toBe("keep-or-remove");
    await expect(readFile(path.join(app, "dist", "main.js"), "utf8")).resolves.toBe(
      "keep-or-remove",
    );
  });
});
