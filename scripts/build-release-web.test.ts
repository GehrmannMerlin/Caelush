import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyWebAssets } from "./build-release.mjs";

describe("release Web assets", () => {
  it("copies the built Web application into the fixed artifact web directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-web-"));
    const source = join(root, "apps", "web", "dist");
    const destination = join(root, "deploy");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "index.html"), "<html>web</html>");
    await mkdir(join(source, "assets"));
    await writeFile(join(source, "assets", "app.js"), "bundle");

    await copyWebAssets(root, destination);

    expect(await readFile(join(destination, "web", "index.html"), "utf8")).toBe("<html>web</html>");
    expect(await readFile(join(destination, "web", "assets", "app.js"), "utf8")).toBe("bundle");
    await rm(root, { recursive: true, force: true });
  });

  it("fails closed when the production Web build is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "caelush-release-web-missing-"));
    await expect(copyWebAssets(root, join(root, "deploy"))).rejects.toThrow(
      "Production Web assets are unavailable. Run the Web build first.",
    );
    await rm(root, { recursive: true, force: true });
  });
});
