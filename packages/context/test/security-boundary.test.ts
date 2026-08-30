import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LocalContextFileSystem } from "../src/filesystem.js";
import { IgnorePolicy } from "../src/ignore-policy.js";
import { CandidateFileDiscovery } from "../src/file-discovery.js";
import { ContextBuilder } from "../src/context-builder.js";
import type { ProjectIntelligenceSnapshot } from "../src/snapshot.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function snapshot(root: string): ProjectIntelligenceSnapshot {
  const workspace = { id: createWorkspaceId(), path: root };
  return {
    workspace: { workspace, logicalRoot: root, realRoot: root, cwd: root, realCwd: root },
    projectRoot: { projectRoot: root, reason: "CWD_FALLBACK" },
    environment: {
      platform: "linux",
      arch: "x64",
      hostNodeVersion: "v24.0.0",
      pathStyle: "POSIX",
      workspaceRoot: root,
      projectRoot: root,
      cwd: root,
    },
    profile: {
      ecosystems: [],
      languageSignals: [],
      manifestEvidence: [],
      packageManager: { name: "UNKNOWN", evidencePaths: [] },
      tooling: [],
      isMonorepo: false,
      monorepoEvidence: [],
    },
    instructions: { entries: [], totalBytes: 0, maxBytes: 0 },
    diagnostics: [],
  };
}

describe("Context security boundary", () => {
  it("uses the Security sensitive-path source of truth before reading file content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "caelush-context-security-"));
    directories.push(root);
    await mkdir(path.join(root, ".aws"));
    await mkdir(path.join(root, ".kube"));
    await writeFile(path.join(root, ".env"), "TOKEN=CAELUSH_ENV_SECRET_9D", "utf8");
    await writeFile(path.join(root, ".aws", "credentials"), "key=CAELUSH_AWS_SECRET_9D", "utf8");
    await writeFile(path.join(root, ".kube", "config"), "token=CAELUSH_KUBE_SECRET_9D", "utf8");
    await writeFile(path.join(root, ".env.example"), "TOKEN=example", "utf8");
    await writeFile(path.join(root, "src.ts"), "export const value = true;", "utf8");

    const filesystem = new LocalContextFileSystem();
    const policy = new IgnorePolicy({ filesystem, projectRoot: root, workspaceRoot: root });
    const discovery = new CandidateFileDiscovery({ filesystem, ignorePolicy: policy });
    const result = await discovery.discover(snapshot(root));

    expect(result.candidates.map((candidate) => candidate.relativePath)).toContain(".env.example");
    expect(result.candidates.map((candidate) => candidate.relativePath)).not.toContain(".env");
    expect(result.candidates.map((candidate) => candidate.relativePath)).not.toContain(
      ".aws/credentials",
    );
    expect(result.candidates.map((candidate) => candidate.relativePath)).not.toContain(
      ".kube/config",
    );
  });

  it("redacts project-derived text but preserves the exact user message", () => {
    const root = "/repo";
    const built = new ContextBuilder().build({
      baseSystemPrompt: "base",
      snapshot: {
        ...snapshot(root),
        instructions: {
          entries: [
            {
              path: "/repo/AGENTS.md",
              relativePath: "AGENTS.md",
              kind: "AGENTS",
              depth: 0,
              content: "TOKEN=CAELUSH_PROJECT_SECRET_9D",
              bytes: 32,
              truncated: false,
            },
          ],
          totalBytes: 32,
          maxBytes: 32,
        },
      },
      relevantFiles: {
        query: { text: "config" },
        rankedCandidates: [],
        sections: [
          {
            provenance: {
              kind: "PROJECT_FILE",
              path: "/repo/src/config.ts",
              relativePath: "src/config.ts",
              score: 1,
              reasons: [],
            },
            content: 'const key = "sk-12345678901234567890";',
            estimatedTokens: 10,
            bytesIncluded: 40,
            truncated: false,
          },
        ],
        budget: {
          maxTotalTokens: 100,
          maxPerFileTokens: 100,
          maxSelectedFiles: 1,
          estimatedTokensUsed: 10,
          remainingTokens: 90,
          selectedFileCount: 1,
        },
        discovery: {
          visitedEntries: 1,
          candidateFiles: 1,
          ignoredEntries: 0,
          hardExcludedEntries: 0,
          sensitiveSkipped: 0,
          binarySkipped: 0,
          symlinkSkipped: 0,
          nonTextSkipped: 0,
          readFailures: 0,
          truncatedByLimit: false,
        },
        diagnostics: [],
      },
      currentUserMessage: { role: "user", content: "show CAELUSH_USER_MESSAGE_9D exactly" },
      limits: {
        maxInputTokens: 2000,
        safetyMarginTokens: 0,
        maxConversationTokens: 1000,
        maxRelevantFileTokens: 1000,
        minRelevantFileTokens: 1,
      },
    });

    const text = JSON.stringify(built.messages);
    expect(text).not.toContain("CAELUSH_PROJECT_SECRET_9D");
    expect(text).not.toContain("sk-12345678901234567890");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("CAELUSH_USER_MESSAGE_9D");
  });
});
