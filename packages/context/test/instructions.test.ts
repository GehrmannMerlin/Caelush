import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { ContextInstructionError } from "../src/errors.js";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { ProjectInstructionDiscovery } from "../src/instructions.js";
import { WorkspaceScopeResolver } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function instructionFixture(): Promise<{ root: string; cwd: string; scope: Awaited<ReturnType<WorkspaceScopeResolver["resolve"]>> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "caelush-context-instructions-"));
  const cwd = path.join(root, "packages", "app");
  await mkdir(cwd, { recursive: true });
  temporaryDirectories.push(root);
  const scope = await new WorkspaceScopeResolver(new LocalContextFileSystem()).resolve(
    { id: createWorkspaceId(), path: root },
    cwd,
  );
  return { root, cwd, scope };
}

describe("ProjectInstructionDiscovery", () => {
  it("loads instructions from project root to cwd with specific files later", async () => {
    const { root, cwd, scope } = await instructionFixture();
    await writeFile(path.join(root, "AGENTS.md"), "root rules", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "child rules", "utf8");

    const result = await new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(scope, root, cwd);

    expect(result.entries.map((entry) => entry.content)).toEqual(["root rules", "child rules"]);
    expect(result.entries.map((entry) => entry.depth)).toEqual([0, 2]);
    expect(result.totalBytes).toBe(Buffer.byteLength("root ruleschild rules"));
  });

  it("uses override, AGENTS, and CLAUDE fallback precedence per directory", async () => {
    const { root, cwd, scope } = await instructionFixture();
    await writeFile(path.join(root, "AGENTS.override.md"), "override", "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "agents", "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), "claude", "utf8");
    await writeFile(path.join(cwd, "CLAUDE.md"), "child claude", "utf8");

    await expect(new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(scope, root, cwd)).resolves.toMatchObject({
      entries: [
        { content: "override", kind: "OVERRIDE" },
        { content: "child claude", kind: "FALLBACK" },
      ],
    });
  });

  it("treats an empty override as the winning candidate", async () => {
    const { root, cwd, scope } = await instructionFixture();
    await writeFile(path.join(cwd, "AGENTS.override.md"), "\n\t", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "must not load", "utf8");

    await expect(new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(scope, root, cwd)).resolves.toMatchObject({
      entries: [],
    });
  });

  it("enforces the total byte budget and stops later files", async () => {
    const { root, cwd, scope } = await instructionFixture();
    await writeFile(path.join(root, "AGENTS.md"), "a".repeat(32769), "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "later", "utf8");

    const result = await new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(scope, root, cwd);

    expect(result.totalBytes).toBe(32768);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.truncated).toBe(true);
  });

  it("truncates multibyte content at a valid UTF-8 boundary", async () => {
    const { root, cwd, scope } = await instructionFixture();
    await writeFile(path.join(root, "AGENTS.md"), "你好世界", "utf8");

    const result = await new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(scope, root, cwd, {
      maxBytes: 5,
    });

    expect(result.entries[0]).toMatchObject({ content: "你", bytes: 3, truncated: true });
    expect(result.totalBytes).toBe(3);
  });

  it("fails closed for invalid UTF-8 and symlink escapes", async ({ skip }) => {
    const invalid = await instructionFixture();
    await writeFile(path.join(invalid.root, "AGENTS.md"), Buffer.from([0xff, 0xfe]));
    await expect(new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(invalid.scope, invalid.root, invalid.cwd)).rejects.toBeInstanceOf(
      ContextInstructionError,
    );

    const escaped = await instructionFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "caelush-context-instruction-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "rules.md"), "outside", "utf8");
    try {
      await symlink(path.join(outside, "rules.md"), path.join(escaped.root, "AGENTS.md"), "file");
    } catch (error) {
      skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    await expect(new ProjectInstructionDiscovery(new LocalContextFileSystem()).discover(escaped.scope, escaped.root, escaped.cwd)).rejects.toBeInstanceOf(
      ContextInstructionError,
    );
  });
});
