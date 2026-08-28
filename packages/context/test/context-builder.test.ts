import { createWorkspaceId } from "@caelush/protocol";
import type { LLMMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import { ContextBuilder, createDefaultContextBuilder } from "../src/context-builder.js";
import type { RelevantFileContextPlan } from "../src/relevant-file-plan.js";
import type { ProjectIntelligenceSnapshot } from "../src/snapshot.js";

function snapshot(): ProjectIntelligenceSnapshot {
  const root = "/repo";
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

function plan(): RelevantFileContextPlan {
  return {
    query: { text: "parser" },
    rankedCandidates: [],
    sections: [
      {
        provenance: {
          kind: "PROJECT_FILE",
          path: "/repo/src/parser.ts",
          relativePath: "src/parser.ts",
          score: 100,
          reasons: [],
        },
        content: "export const parser = true;",
        estimatedTokens: 9,
        bytesIncluded: 28,
        truncated: false,
      },
    ],
    budget: {
      maxTotalTokens: 100,
      maxPerFileTokens: 100,
      maxSelectedFiles: 1,
      estimatedTokensUsed: 9,
      remainingTokens: 91,
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
  };
}

const limits = {
  maxInputTokens: 2000,
  safetyMarginTokens: 0,
  maxConversationTokens: 1000,
  maxRelevantFileTokens: 1000,
  minRelevantFileTokens: 1,
};

describe("ContextBuilder", () => {
  it("assembles system, selected structured history, file reference, and exact current user", () => {
    const history: readonly LLMMessage[] = [
      { role: "user", content: "inspect" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const current = { role: "user", content: "  fix this\n\nplease  " } as const;
    const built = new ContextBuilder().build({
      baseSystemPrompt: "base agent prompt",
      snapshot: snapshot(),
      relevantFiles: plan(),
      history,
      currentUserMessage: current,
      limits,
    });
    expect(built.messages[0]?.role).toBe("system");
    expect(built.messages.slice(1, 3)).toEqual(history);
    expect(built.messages[3]?.role).toBe("user");
    expect(built.messages.at(-1)).toEqual(current);
    expect(built.messages.at(-1)?.content).toBe("  fix this\n\nplease  ");
    expect(built.report.system.instructionCount).toBe(0);
    expect(built.report.relevantFiles.selectedFiles).toBe(1);
    expect(built.report.estimatedInputTokens + limits.safetyMarginTokens).toBeLessThanOrEqual(
      limits.maxInputTokens,
    );
  });

  it("omits empty optional messages and is deterministic across repeated builds", () => {
    const input = {
      baseSystemPrompt: "",
      snapshot: snapshot(),
      currentUserMessage: { role: "user", content: "hello" } as const,
      limits,
    };
    const builder = createDefaultContextBuilder();
    const first = builder.build(input);
    for (let index = 0; index < 10; index += 1) {
      expect(builder.build(input)).toEqual(first);
    }
    expect(first.messages).toHaveLength(2);
    expect(first.messages.every((message) => message.role !== "tool")).toBe(true);
  });
});
