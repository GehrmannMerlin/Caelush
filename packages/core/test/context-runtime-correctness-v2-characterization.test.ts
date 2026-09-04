import type { LLMAssistantMessage, LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import {
  ContextBuilder,
  ContextRuntimeCoordinator,
  Utf8HeuristicTokenEstimator,
  type ContextBuildInput,
  type ContextBuildReport,
} from "@caelush/context";
import { createWorkspaceId } from "@caelush/protocol";

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

function assistant(index: number): LLMAssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "inspect " + index },
      {
        type: "tool-call",
        toolCallId: "call-" + index,
        toolName: "read_file",
        input: { path: "file-" + index + ".txt" },
      },
    ],
  };
}

function result(index: number): LLMToolResultMessage {
  return {
    role: "tool",
    toolCallId: "call-" + index,
    toolName: "read_file",
    content: "file " + index + " " + "content ".repeat(50),
    isError: false,
  };
}

class RecordingContextBuilder extends ContextBuilder {
  readonly reports: ContextBuildReport[] = [];

  override build(input: ContextBuildInput) {
    const built = super.build(input);
    this.reports.push(built.report);
    return built;
  }
}

describe("Context Runtime V2 baseline characterization", () => {
  it("checkpoint tokensBefore describes the real pre-compaction model input", async () => {
    const history: LLMMessage[] = [];
    for (let index = 0; index < 12; index += 1) {
      history.push(
        { role: "user", content: "previous goal " + index },
        assistant(index),
        result(index),
      );
    }
    const builder = new RecordingContextBuilder({
      tokenEstimator: new Utf8HeuristicTokenEstimator(),
    });
    const created: Array<{ readonly tokensBefore: number; readonly tokensAfter: number }> = [];
    const coordinator = new ContextRuntimeCoordinator({
      builder,
      policyOptions: { proactiveCompactionRatio: 0.5 },
      checkpointRepository: {
        getLatestByRun: async () => undefined,
        create: async (input) => {
          created.push({ tokensBefore: input.tokensBefore, tokensAfter: input.tokensAfter });
          return { ...input, schemaVersion: 1 };
        },
      },
    });

    await coordinator.prepareModelContext({
      runId: "run-v2-baseline",
      providerId: "fixture",
      modelId: "fixture-model",
      context: {
        baseSystemPrompt: "inspect the workspace",
        snapshot: snapshot(),
        history,
        currentUserMessage: { role: "user", content: "scan the workspace" },
        limits: { maxInputTokens: 6_000 },
      },
      signal: new AbortController().signal,
    });

    expect(created).toHaveLength(1);
    expect(created[0]!.tokensBefore).toBe(builder.reports[0]!.estimatedInputTokens);
    expect(created[0]!.tokensAfter).toBeGreaterThan(0);
    expect(builder.reports.at(-1)!.conversation.selectedMessages).toBeGreaterThan(0);
    expect(builder.reports.at(-1)!.conversation.selectedMessages).toBeLessThan(history.length);
  });

  it("recovers an oversized open tool turn by reprojection without dropping identity", async () => {
    let loadedArtifactRef: string | undefined;
    const coordinator = new ContextRuntimeCoordinator({
      builder: new ContextBuilder({ tokenEstimator: new Utf8HeuristicTokenEstimator() }),
      rawObservationLoader: async ({ artifactRef }) => {
        loadedArtifactRef = artifactRef;
        return "raw-head-" + "x".repeat(24_000) + "-raw-tail";
      },
    });
    const currentTurn: LLMMessage[] = [
      { role: "user", content: "scan the workspace" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "read_file",
            input: { path: "package.json" },
          },
          {
            type: "tool-call",
            toolCallId: "call-b",
            toolName: "read_file",
            input: { path: "pnpm-workspace.yaml" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-a",
        toolName: "read_file",
        content: "A".repeat(12_000),
        isError: false,
        rawArtifactRef: "artifact:call-a",
      },
      {
        role: "tool",
        toolCallId: "call-b",
        toolName: "read_file",
        content: "B".repeat(12_000),
        isError: false,
      },
    ];

    const result = await coordinator.prepareModelContext({
      runId: "run-open-turn",
      providerId: "fixture",
      modelId: "tiny",
      context: {
        mode: "TOOL_CONTINUATION",
        baseSystemPrompt: "inspect the workspace",
        snapshot: snapshot(),
        history: [],
        currentTurnMessages: currentTurn,
        limits: { maxInputTokens: 5_000 },
      },
      signal: new AbortController().signal,
    });

    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(
      result.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-a", "call-b"]);
    expect(result.report.estimatedInputTokens).toBeLessThanOrEqual(5_000);
    expect(loadedArtifactRef).toBe("artifact:call-a");
    expect(
      result.messages.some(
        (message) => message.role === "tool" && message.content.includes("raw-head-"),
      ),
    ).toBe(true);
  });
});
