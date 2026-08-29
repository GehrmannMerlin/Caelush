import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalRuntimeFileDiscovery,
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
