import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStaticFile } from "../../src/main/protocol/static-resources.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-static-test-"));
  roots.push(root);
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "desktop");
  await writeFile(path.join(root, "assets", "app.js"), "app");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("caelush-app static resource mapping", () => {
  it("maps only files inside the renderer root", async () => {
    const root = await createRoot();
    expect(await resolveStaticFile(root, "/")).toBe(path.join(root, "index.html"));
    expect(await resolveStaticFile(root, "/assets/app.js")).toBe(
      path.join(root, "assets", "app.js"),
    );
    expect(await resolveStaticFile(root, "/missing.js")).toBeNull();
  });

  it("rejects encoded traversal, Windows paths, backslashes, and malformed escapes", async () => {
    const root = await createRoot();
    for (const requestPath of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/C:/Windows/win.ini",
      "/%5c%5cserver/share/file",
      "/bad%escape.js",
    ]) {
      await expect(resolveStaticFile(root, requestPath)).resolves.toBeNull();
    }
  });
});
