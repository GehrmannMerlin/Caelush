import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAppearanceStore } from "../../src/main/appearance/appearance-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeAppearanceFile() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-appearance-test-"));
  roots.push(root);
  return { root, filePath: path.join(root, "appearance.json") };
}

describe("Desktop appearance store", () => {
  it("defaults a missing preference file to light", async () => {
    const { filePath } = await makeAppearanceFile();

    await expect(new DesktopAppearanceStore(filePath).read()).resolves.toBe("light");
  });

  it("recovers to light from invalid JSON, versions, and preference values", async () => {
    const { filePath } = await makeAppearanceFile();
    const store = new DesktopAppearanceStore(filePath);

    for (const value of [
      "{",
      JSON.stringify({ version: 2, preference: "dark" }),
      JSON.stringify({ version: 1, preference: "sepia" }),
      JSON.stringify({ version: 1, preference: "system", unexpected: true }),
    ]) {
      await writeFile(filePath, value);
      await expect(store.read()).resolves.toBe("light");
    }
  });

  it.each(["light", "dark", "system"] as const)(
    "round-trips the %s preference",
    async (preference) => {
      const { filePath } = await makeAppearanceFile();
      const store = new DesktopAppearanceStore(filePath);

      await store.write(preference);

      await expect(store.read()).resolves.toBe(preference);
      await expect(readFile(filePath, "utf8")).resolves.toBe(
        JSON.stringify({ version: 1, preference }),
      );
    },
  );

  it("keeps the previous document intact when atomic replacement fails", async () => {
    const { root, filePath } = await makeAppearanceFile();
    const existing = JSON.stringify({ version: 1, preference: "light" });
    await writeFile(filePath, existing);
    const store = new DesktopAppearanceStore(filePath, {
      rename: async () => {
        throw new Error("replacement failed");
      },
    });

    await expect(store.write("dark")).rejects.toThrow("replacement failed");

    await expect(readFile(filePath, "utf8")).resolves.toBe(existing);
    await expect(readdir(root)).resolves.toEqual(["appearance.json"]);
  });
});
