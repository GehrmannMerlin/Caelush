import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextIgnoreError } from "../src/errors.js";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { IgnorePolicy } from "../src/ignore-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; policy: IgnorePolicy }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-ignore-policy-"));
  temporaryDirectories.push(root);
  return {
    root,
    policy: new IgnorePolicy({
      filesystem: new LocalContextFileSystem(),
      projectRoot: root,
      workspaceRoot: root,
    }),
  };
}

describe("IgnorePolicy", () => {
  it("applies root gitignore rules, negation, anchored paths, and Windows separators", async () => {
    const { root, policy } = await fixture();
    await writeFile(
      path.join(root, ".gitignore"),
      "*.log\n!keep.log\n/root-only.txt\nnested/ignored.txt\n",
      "utf8",
    );
    await mkdir(path.join(root, "nested"));

    await expect(policy.decide(path.join(root, "error.log"), "FILE")).resolves.toMatchObject({
      ignored: true,
    });
    await expect(policy.decide(path.join(root, "keep.log"), "FILE")).resolves.toMatchObject({
      ignored: false,
    });
    await expect(
      policy.decide(path.join(root, "child", "root-only.txt"), "FILE"),
    ).resolves.toMatchObject({ ignored: false });
    await expect(
      policy.decide(path.join(root, "nested", "ignored.txt"), "FILE"),
    ).resolves.toMatchObject({ ignored: true });
    await expect(policy.decide(`${root}\\nested\\ignored.txt`, "FILE")).resolves.toMatchObject({
      ignored: true,
    });
  });

  it("applies nested gitignore rules relative to the nested directory", async () => {
    const { root, policy } = await fixture();
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, ".gitignore"), "*.tmp\n!keep.tmp\n", "utf8");

    await expect(policy.decide(path.join(nested, "cache.tmp"), "FILE")).resolves.toMatchObject({
      ignored: true,
    });
    await expect(policy.decide(path.join(nested, "keep.tmp"), "FILE")).resolves.toMatchObject({
      ignored: false,
    });
    await expect(
      policy.decide(path.join(nested, "src", "cache.tmp"), "FILE"),
    ).resolves.toMatchObject({
      ignored: true,
    });
  });

  it("keeps hard exclusions excluded even when gitignore negates them", async () => {
    const { root, policy } = await fixture();
    await writeFile(
      path.join(root, ".gitignore"),
      "!node_modules/foo.ts\n!dist/output.js\n",
      "utf8",
    );

    await expect(
      policy.decide(path.join(root, "node_modules", "foo.ts"), "FILE"),
    ).resolves.toMatchObject({ hardExcluded: true, ignored: true });
    await expect(
      policy.decide(path.join(root, "dist", "output.js"), "FILE"),
    ).resolves.toMatchObject({
      hardExcluded: true,
      ignored: true,
    });
  });

  it("blocks common sensitive paths while allowing environment templates", async () => {
    const { root, policy } = await fixture();
    for (const filename of [
      ".env",
      ".env.local",
      ".env.production.local",
      ".npmrc",
      "id_ed25519",
      "server.pem",
    ]) {
      await expect(policy.decide(path.join(root, filename), "FILE")).resolves.toMatchObject({
        sensitive: true,
        ignored: true,
      });
    }
    for (const filename of [".env.example", ".env.sample", ".env.template"]) {
      await expect(policy.decide(path.join(root, filename), "FILE")).resolves.toMatchObject({
        sensitive: false,
        ignored: false,
      });
    }
  });

  it("blocks known binary extensions and the gitignore file itself", async () => {
    const { root, policy } = await fixture();
    await expect(policy.decide(path.join(root, "image.PNG"), "FILE")).resolves.toMatchObject({
      binary: true,
      ignored: true,
    });
    await expect(policy.decide(path.join(root, ".gitignore"), "FILE")).resolves.toMatchObject({
      ignored: true,
    });
  });

  it("fails closed when a gitignore layer is oversized or unreadable", async () => {
    const { root, policy } = await fixture();
    await writeFile(path.join(root, ".gitignore"), "x".repeat(131073), "utf8");
    await expect(policy.decide(path.join(root, "source.ts"), "FILE")).rejects.toBeInstanceOf(
      ContextIgnoreError,
    );
  });
});
