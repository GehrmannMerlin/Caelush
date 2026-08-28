import { createWorkspaceId } from "@caelush/protocol";
import type { LLMUserMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import {
  ContextBudgetExceededError,
  ContextBuilder,
  ContextBuildError,
  ContextConversationError,
} from "../src/index.js";
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

const user: LLMUserMessage = { role: "user", content: "hello" };

function input(limits: Record<string, number>) {
  return {
    baseSystemPrompt: "base",
    snapshot: snapshot(),
    currentUserMessage: user,
    limits,
  };
}

describe("ContextBuilder contracts", () => {
  it("requires a positive caller-supplied maxInputTokens", () => {
    expect(() => new ContextBuilder().build(input({ maxInputTokens: 0 }))).toThrow(ContextBuildError);
    expect(() => new ContextBuilder().build(input({ maxInputTokens: 100.5 }))).toThrow(
      ContextBuildError,
    );
  });

  it("accepts zero optional source caps and rejects invalid safety/minimum values", () => {
    expect(() =>
      new ContextBuilder().build(
        input({
          maxInputTokens: 100,
          safetyMarginTokens: 0,
          maxConversationTokens: 0,
          maxRelevantFileTokens: 0,
          minRelevantFileTokens: 1,
        }),
      ),
    ).not.toThrow(ContextBuildError);
    expect(() => new ContextBuilder().build(input({ maxInputTokens: 100, safetyMarginTokens: -1 }))).toThrow(
      ContextBuildError,
    );
    expect(() => new ContextBuilder().build(input({ maxInputTokens: 100, minRelevantFileTokens: 0 }))).toThrow(
      ContextBuildError,
    );
  });

  it("keeps build errors typed and reports contain no content fields", () => {
    expect(new ContextBudgetExceededError({ maxInputTokens: 1, safetyMarginTokens: 0, systemTokens: 1, currentUserTokens: 1, mandatoryTokens: 2 })).toBeInstanceOf(ContextBuildError);
    expect(new ContextConversationError("invalid history")).toBeInstanceOf(ContextBuildError);
    expect(new ContextBudgetExceededError({ maxInputTokens: 1, safetyMarginTokens: 0, systemTokens: 1, currentUserTokens: 1, mandatoryTokens: 2 })).toMatchObject({
      code: "CONTEXT_BUDGET_EXCEEDED",
    });
  });
});
