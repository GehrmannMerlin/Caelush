import type { LLMAssistantMessage, LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import { ContextBuilder, ContextBudgetExceededError } from "@caelush/context";
import { createWorkspaceId } from "@caelush/protocol";
import { prepareResumeHistory } from "../src/agent-loop-history.js";

const estimator = { estimateText: (text: string) => text.length };
const system = { role: "system" as const, content: "system" };

function snapshot() {
  const root = "/repo";
  const workspace = { id: createWorkspaceId(), path: root };
  return {
    workspace: { workspace, logicalRoot: root, realRoot: root, cwd: root, realCwd: root },
    projectRoot: { projectRoot: root, reason: "CWD_FALLBACK" as const },
    environment: {
      platform: "linux" as const,
      arch: "x64",
      hostNodeVersion: "v24.0.0",
      pathStyle: "POSIX" as const,
      workspaceRoot: root,
      projectRoot: root,
      cwd: root,
    },
    profile: {
      ecosystems: [],
      languageSignals: [],
      manifestEvidence: [],
      packageManager: { name: "UNKNOWN" as const, evidencePaths: [] },
      tooling: [],
      isMonorepo: false,
      monorepoEvidence: [],
    },
    instructions: { entries: [], totalBytes: 0, maxBytes: 0 },
    diagnostics: [],
  };
}

function assistantFor(index: number, content = "progress"): LLMAssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `${content} ${index}` },
      {
        type: "tool-call",
        toolCallId: `call_${index}`,
        toolName: "read_file",
        input: { path: `src/file-${index}.ts` },
      },
    ],
  };
}

function resultFor(index: number, content = "source"): LLMToolResultMessage {
  return {
    role: "tool",
    toolCallId: `call_${index}`,
    toolName: "read_file",
    content,
    isError: false,
  };
}

function pendingDecision(index: number) {
  return {
    type: "TOOL_CALLS_REQUESTED" as const,
    modelTurn: {
      callId: `llm_${index}` as never,
      model: { provider: "fixture", model: "fixture-model" },
      finishReason: "TOOL_CALLS" as const,
      assistantMessage: assistantFor(index),
    },
    toolRequests: [
      {
        externalCallId: `call_${index}`,
        toolName: "read_file" as const,
        args: { path: `src/file-${index}.ts` },
      },
    ],
  };
}

describe("Context Runtime baseline characterization", () => {
  it("bounds the current mandatory unit across 32 execution cycles from one user goal", () => {
    const history: LLMMessage[] = [{ role: "user", content: "inspect the workspace" }];
    const trace: Array<{ turn: number; messageCount: number; estimatedTokens: number }> = [];

    for (let index = 1; index <= 32; index += 1) {
      const assistant = assistantFor(index);
      const result = resultFor(index);
      history.push(assistant);
      const split = prepareResumeHistory(history, pendingDecision(index), [result]);
      trace.push({
        turn: index,
        messageCount: split.currentTurnMessages.length,
        estimatedTokens: split.currentTurnMessages.reduce(
          (total, message) => total + JSON.stringify(message).length,
          0,
        ),
      });
      history.push(result);
    }

    expect(trace).toHaveLength(32);
    expect(trace[0]?.messageCount).toBe(3);
    expect(trace.at(-1)?.messageCount).toBe(3);
    expect(trace.at(-1)!.estimatedTokens).toBeLessThanOrEqual(trace[0]!.estimatedTokens + 20);
  });

  it("keeps a healthy long continuation below the old 16K mandatory current-turn boundary", () => {
    const history: LLMMessage[] = [{ role: "user", content: "inspect the workspace" }];
    let currentTurn: readonly LLMMessage[] = [];
    const largeResult = "build output ".repeat(700);

    for (let index = 1; index <= 32; index += 1) {
      history.push(assistantFor(index, "progress"));
      currentTurn = prepareResumeHistory(history, pendingDecision(index), [
        resultFor(index, largeResult),
      ]).currentTurnMessages;
      history.push(resultFor(index, largeResult));
    }

    expect(() =>
      new ContextBuilder({ tokenEstimator: estimator }).build({
        baseSystemPrompt: system.content,
        snapshot: snapshot(),
        currentTurnMessages: currentTurn,
        mode: "TOOL_CONTINUATION",
        limits: {
          maxInputTokens: 16_000,
          safetyMarginTokens: 512,
          maxConversationTokens: 12_000,
          maxRelevantFileTokens: 12_000,
          minRelevantFileTokens: 128,
        },
      }),
    ).not.toThrow(ContextBudgetExceededError);
  });

  it("keeps the old raw tool-result pressure visible in model history", () => {
    const raw = "line ".repeat(200_000);
    const history: LLMMessage[] = [
      { role: "user", content: "run the build" },
      assistantFor(1),
      resultFor(1, raw),
    ];

    expect(JSON.stringify(history.at(-1))).toContain(raw);
    expect(JSON.stringify(history).length).toBeGreaterThan(1_000_000);
  });
});
