import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalRuntimeFileDiscovery,
  LocalRipgrepRunner,
  LocalTextSearchFallback,
  RuntimeInvariantError,
  parseRipgrepJson,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalRuntimeFileDiscovery", () => {
  it("finds sorted files without following or entering hard exclusions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-discovery-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "src", "z.ts"), "z", "utf8");
    await writeFile(path.join(root, "src", "a.ts"), "a", "utf8");
    await writeFile(path.join(root, "node_modules", "ignored.ts"), "ignored", "utf8");

    await expect(
      new LocalRuntimeFileDiscovery().find({ cwd: root, pattern: "**/*.ts", limit: 10 }),
    ).resolves.toEqual({
      files: ["src/a.ts", "src/z.ts"],
      truncated: false,
    });
  });
});

describe("parseRipgrepJson", () => {
  it("parses match events and rejects malformed backend output", () => {
    const event = JSON.stringify({
      type: "match",
      data: { path: { text: "src/a.ts" }, lines: { text: "AgentLoop\n" }, line_number: 4 },
    });
    expect(parseRipgrepJson(event)).toEqual([{ path: "src/a.ts", line: 4, text: "AgentLoop" }]);
    expect(() => parseRipgrepJson("not-json")).toThrow(RuntimeInvariantError);
  });
});

describe("LocalTextSearchFallback", () => {
  it("searches bounded workspace files with hard exclusions and include globs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-search-fallback-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "needle one\nneedle two\n", "utf8");
    await writeFile(path.join(root, "src", "b.ts"), "needle three\n", "utf8");
    await writeFile(path.join(root, "node_modules", "ignored.ts"), "needle hidden\n", "utf8");

    await expect(
      new LocalTextSearchFallback().search({
        cwd: root,
        pattern: "needle",
        include: "src/**/*.ts",
        limit: 2,
      }),
    ).resolves.toMatchObject({
      matches: [
        { path: "src/a.ts", line: 1, text: "needle one" },
        { path: "src/a.ts", line: 2, text: "needle two" },
      ],
      truncated: true,
    });
  });

  it("keeps the default runner usable when rg cannot be started", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-search-runner-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "fixture.ts"), "needle\n", "utf8");
    const unavailableSpawn = (() => {
      const error = new Error("rg missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }) as typeof import("node:child_process").spawn;

    await expect(
      new LocalRipgrepRunner({ spawn: unavailableSpawn }).search({
        cwd: root,
        pattern: "needle",
        limit: 1,
      }),
    ).resolves.toMatchObject({ matches: [{ path: "fixture.ts", line: 1, text: "needle" }] });
  });

  it("does not spawn an unbound ripgrep helper when the process boundary is required", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-search-boundary-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "fixture.ts"), "needle\n", "utf8");
    let spawnCalls = 0;
    const runner = new LocalRipgrepRunner({
      spawn: (() => {
        spawnCalls += 1;
        throw new Error("unbound helper must not spawn");
      }) as typeof import("node:child_process").spawn,
    });

    await expect(
      runner.search({
        cwd: root,
        pattern: "needle",
        limit: 1,
        requireProcessBoundary: true,
        resolveTarget: async (absolutePath) => ({ canonicalPath: absolutePath, kind: "FILE" }),
      }),
    ).resolves.toMatchObject({ matches: [{ path: "fixture.ts", line: 1, text: "needle" }] });
    expect(spawnCalls).toBe(0);
  });

  it("does not let the child close event override an asynchronous missing-rg fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-search-async-runner-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "fixture.ts"), "needle\n", "utf8");
    const unavailableSpawn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      queueMicrotask(() => {
        const error = new Error("rg missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        child.emit("error", error);
        child.emit("close", null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(
      new LocalRipgrepRunner({ spawn: unavailableSpawn }).search({
        cwd: root,
        pattern: "needle",
        limit: 1,
      }),
    ).resolves.toMatchObject({ matches: [{ path: "fixture.ts", line: 1, text: "needle" }] });
  });

  it("honors cancellation before walking the workspace", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new LocalTextSearchFallback().search({
        cwd: os.tmpdir(),
        pattern: "needle",
        limit: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow("search was cancelled");
  });
});
