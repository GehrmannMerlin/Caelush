import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "../src/version.js";
import { HELP_TEXT } from "../src/help.js";

const execFileAsync = promisify(execFile);

describe("static product commands", () => {
  it("uses package metadata as the product version", () => {
    expect(PRODUCT_VERSION).toBe("0.1.0");
  });

  it("documents the product command and all supported launch forms", () => {
    for (const fragment of [
      "caelush",
      "caelush --continue",
      "caelush --resume",
      "caelush --resume <SESSION_ID>",
      "caelush --print <PROMPT>",
      "caelush doctor",
      "--help",
      "--version",
    ]) {
      expect(HELP_TEXT).toContain(fragment);
    }
  });

  it("keeps the Windows shim on the executable development-aware launcher entry", () => {
    const shim = readFileSync(join(import.meta.dirname, "..", "bin", "caelush.cmd"), "utf8");
    expect(shim).toContain("%~dp0caelush");
    expect(shim).not.toContain("dist\\index.js");
  });

  it("does not mistake a release bundle inside the repository for a source checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-launcher-bundle-layout-"));
    const bundle = join(root, "release-artifacts", "caelush-test");
    const bundleBin = join(bundle, "bin");
    const bundleDist = join(bundle, "dist");
    await mkdir(bundleBin, { recursive: true });
    await mkdir(bundleDist, { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await cp(join(import.meta.dirname, "..", "bin", "caelush"), join(bundleBin, "caelush"));
    await writeFile(join(bundle, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(
      join(bundleDist, "index.js"),
      "export async function main() { return 0; }\n",
      "utf8",
    );
    await writeFile(
      join(root, "scripts", "build-sandbox-runner.mjs"),
      'throw new Error("release bundle imported the source helper");\n',
      "utf8",
    );

    try {
      const result = await execFileAsync(process.execPath, [join(bundleBin, "caelush"), "doctor"]);
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
