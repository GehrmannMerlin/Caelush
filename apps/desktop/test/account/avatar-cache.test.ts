import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopAccountAvatarCache } from "../../src/main/account/avatar-cache.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop account avatar cache", () => {
  it("encrypts bounded WebP files and clears all revisions for an account", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-avatar-cache-"));
    roots.push(root);
    const directory = path.join(root, "avatars");
    const cache = new DesktopAccountAvatarCache(directory, {
      encrypt: async (value) => new Uint8Array(Buffer.from(value, "utf8")),
      decrypt: async (value) => Buffer.from(value).toString("utf8"),
    });
    const avatar = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const userId = "11111111-1111-4111-8111-111111111111";

    await cache.write(userId, "revision-1", avatar);
    await cache.write(userId, "revision-2", avatar);
    const files = await readdir(directory);
    const stored = await readFile(path.join(directory, files[0] ?? ""));
    expect(stored.includes(Buffer.from("RIFF"))).toBe(false);
    expect(await cache.read(userId, "revision-2")).toEqual(avatar);

    await cache.clear(userId);
    expect(await cache.read(userId, "revision-2")).toBeNull();
    await expect(cache.write(userId, "bad", new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
