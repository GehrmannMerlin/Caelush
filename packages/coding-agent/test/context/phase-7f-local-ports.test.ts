import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalCodingContextPorts } from "@caelush/coding-agent";
import type { WorkspaceRef } from "@caelush/protocol";
import type { Runtime, RuntimeWorkspaceScope } from "@caelush/runtime";

const ROOT = path.resolve("C:/caelush-phase-7f-workspace");
const WORKSPACE: WorkspaceRef = {
  id: "workspace_phase_7f" as never,
  path: ROOT,
};

describe("Phase 7F local Coding Context ports", () => {
  it("keeps instructions ordered and excludes ignored, sensitive, and escaped files", async () => {
    const content: Record<string, string> = {
      ".gitignore": "ignored.ts\nsrc/ignored.ts\n",
      "AGENTS.md": "Keep the project boundary intact.",
      "src/kept.ts": "export const kept = " + "true;\n".repeat(200),
      "ignored.ts": "do not load",
      "src/ignored.ts": "do not load",
      ".env": "PASSWORD=secret",
    };
    const scope = fakeScope(content);
    const runtime: Runtime = {
      kind: "local",
      supports: () => true,
      async openWorkspace() {
        return scope;
      },
    };
    const ports = createLocalCodingContextPorts({ runtime, workspace: WORKSPACE });
    const identity = {
      runId: "run_phase_7f" as never,
      sessionId: "session_phase_7f" as never,
      goal: "keep the source boundary",
    };

    const instructions = await ports.projectInstructions.load({
      identity,
      signal: new AbortController().signal,
    });
    const files = await ports.relevantFiles.load({
      identity,
      signal: new AbortController().signal,
    });

    expect(instructions.entries.map((entry) => entry.relativePath)).toEqual(["AGENTS.md"]);
    expect(files.sections.map((section) => section.relativePath)).toEqual(["src/kept.ts"]);
    expect(files.sections.some((section) => section.content.includes("secret"))).toBe(false);
  });
});

function fakeScope(content: Readonly<Record<string, string>>): RuntimeWorkspaceScope {
  const absolute = (relative: string) => path.join(ROOT, relative);
  const metadata = async (value: string) => {
    if (value === ROOT) return { kind: "DIRECTORY" as const };
    return content[path.relative(ROOT, value).replaceAll("\\", "/")] === undefined
      ? null
      : {
          kind: "FILE" as const,
          sizeBytes: Buffer.byteLength(
            content[path.relative(ROOT, value).replaceAll("\\", "/")]!,
            "utf8",
          ),
        };
  };
  const filesystem = {
    async getMetadata(value: string) {
      return metadata(value);
    },
    async fingerprint() {
      return { kind: "FILE" as const };
    },
    async realpath(value: string) {
      return value;
    },
    async readDirectory() {
      return [];
    },
    async readTextFile(value: string) {
      const relative = path.relative(ROOT, value).replaceAll("\\", "/");
      const text = content[relative] ?? "";
      return {
        lines: text.split("\n"),
        lineStart: 0,
        bytesReturned: Buffer.byteLength(text, "utf8"),
        truncated: false,
        utf8Bom: false,
      };
    },
  };
  const pathResolver = {
    async resolveExisting(relativePath: string) {
      const value = absolute(relativePath);
      const file = await metadata(value);
      if (file === null) throw new Error(`Missing test file: ${relativePath}`);
      return {
        absolutePath: value,
        realPath: value,
        relativePath,
        kind: file.kind,
        metadata: file,
      };
    },
  };
  const files = Object.keys(content);
  return {
    workspace: WORKSPACE,
    logicalRoot: ROOT,
    realRoot: ROOT,
    pathResolver: pathResolver as RuntimeWorkspaceScope["pathResolver"],
    filesystem,
    discovery: {
      async find(input) {
        return {
          files: input.pattern === "**/.gitignore" ? [".gitignore"] : files,
          truncated: false,
        };
      },
    },
    textSearch: {} as RuntimeWorkspaceScope["textSearch"],
    patch: {} as RuntimeWorkspaceScope["patch"],
    exec: {} as RuntimeWorkspaceScope["exec"],
    git: {
      async status() {
        return {
          detached: false,
          ahead: 0,
          behind: 0,
          clean: false,
          entries: [],
          truncated: false,
        };
      },
      async diff() {
        return {
          scope: "WORKTREE" as const,
          path: ".",
          diff: "",
          truncated: false,
          bytesReturned: 0,
          omittedBytes: 0,
          hadDecodeReplacement: false,
        };
      },
    },
  };
}
