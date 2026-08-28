import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/context-builder.js";
import { ContextBudgetExceededError, ContextConversationError } from "../src/errors.js";
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

const limits = {
  maxInputTokens: 10_000,
  safetyMarginTokens: 0,
  maxConversationTokens: 0,
  maxRelevantFileTokens: 0,
  minRelevantFileTokens: 1,
};

const currentTurn = [
  { role: "user" as const, content: "fix parser" },
  {
    role: "assistant" as const,
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call_a",
        toolName: "read_file",
        input: { path: "src/parser.ts" },
      },
    ],
  },
  {
    role: "tool" as const,
    toolCallId: "call_a",
    toolName: "read_file" as const,
    content: "export const parser = true;",
    isError: false,
  },
];

describe("ContextBuilder tool continuation", () => {
  it("keeps the complete open user turn and leaves the tool result at the tail", () => {
    const built = new ContextBuilder().build({
      baseSystemPrompt: "base",
      snapshot: snapshot(),
      mode: "TOOL_CONTINUATION",
      history: [{ role: "user", content: "old" }],
      currentTurnMessages: currentTurn,
      limits,
    });

    expect(built.messages.at(0)?.role).toBe("system");
    expect(built.messages.at(-3)).toEqual(currentTurn[0]);
    expect(built.messages.at(-2)).toEqual(currentTurn[1]);
    expect(built.messages.at(-1)).toEqual(currentTurn[2]);
    expect(built.report.currentTurn).toEqual({
      type: "TOOL_CONTINUATION",
      messageCount: 3,
      estimatedTokens: expect.any(Number),
    });
    expect(built.report.currentUserTokens).toBe(0);
  });

  it("keeps multiple tool cycles mandatory as one current turn", () => {
    const secondCycle = [
      ...currentTurn,
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_b",
            toolName: "write_file" as const,
            input: { path: "src/parser.ts", content: "fixed" },
          },
        ],
      },
      {
        role: "tool" as const,
        toolCallId: "call_b",
        toolName: "write_file" as const,
        content: "updated",
        isError: false,
      },
    ];
    const built = new ContextBuilder().build({
      baseSystemPrompt: "base",
      snapshot: snapshot(),
      mode: "TOOL_CONTINUATION",
      currentTurnMessages: secondCycle,
      limits,
    });

    expect(built.messages.slice(-secondCycle.length)).toEqual(secondCycle);
    expect(built.report.currentTurn.messageCount).toBe(5);
  });

  it("does not partially drop the current turn when optional budget is zero", () => {
    const built = new ContextBuilder().build({
      baseSystemPrompt: "base",
      snapshot: snapshot(),
      mode: "TOOL_CONTINUATION",
      history: [{ role: "user", content: "old" }],
      currentTurnMessages: currentTurn,
      limits,
    });

    expect(built.messages.slice(-currentTurn.length)).toEqual(currentTurn);
    expect(built.report.conversation.selectedMessages).toBe(0);
  });

  it("fails closed when system plus the whole current turn exceeds the budget", () => {
    expect(() =>
      new ContextBuilder().build({
        baseSystemPrompt: "base",
        snapshot: snapshot(),
        mode: "TOOL_CONTINUATION",
        currentTurnMessages: currentTurn,
        limits: { ...limits, maxInputTokens: 5 },
      }),
    ).toThrow(ContextBudgetExceededError);
  });

  it("rejects system messages and an assistant-only continuation tail", () => {
    expect(() =>
      new ContextBuilder().build({
        baseSystemPrompt: "base",
        snapshot: snapshot(),
        mode: "TOOL_CONTINUATION",
        currentTurnMessages: [{ role: "system", content: "not here" }],
        limits,
      }),
    ).toThrow(ContextConversationError);

    expect(() =>
      new ContextBuilder().build({
        baseSystemPrompt: "base",
        snapshot: snapshot(),
        mode: "TOOL_CONTINUATION",
        currentTurnMessages: currentTurn.slice(0, 2),
        limits,
      }),
    ).toThrow(ContextConversationError);
  });
});
