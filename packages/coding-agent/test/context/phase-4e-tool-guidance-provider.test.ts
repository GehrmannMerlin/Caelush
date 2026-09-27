import { describe, expect, it } from "vitest";

import type { ContextSourceInput, ContextTokenEstimatorPort } from "@caelush/agent";
import {
  CODING_CONTEXT_SOURCE_IDS,
  createToolGuidanceContextSourceProvider,
  MAX_TOOL_PROMPT_TOTAL_BYTES,
  promptSnippetFor,
} from "@caelush/coding-agent";
import type { ToolName } from "@caelush/protocol";

const sourceInput = {
  identity: {
    runId: "run_tool_guidance" as never,
    sessionId: "session_tool_guidance" as never,
    goal: "inspect the project",
  },
  turn: { stepId: "step_tool_guidance" as never, sequence: 1 },
  conversation: {} as never,
  input: { kind: "CONTINUATION", reason: "STEERING" },
  model: {} as never,
  mode: "NORMAL",
  policy: {} as never,
  signal: new AbortController().signal,
} as unknown as ContextSourceInput;

const asToolNames = (names: readonly string[]): readonly ToolName[] => names as readonly ToolName[];

function recordingEstimator(result = 777): {
  readonly estimator: ContextTokenEstimatorPort;
  readonly texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    estimator: {
      estimateText(text) {
        texts.push(text);
        return result;
      },
      estimateAgentMessage() {
        return 0;
      },
      estimateAIToolSpec() {
        return 0;
      },
    },
  };
}

describe("Phase 4E native Tool Guidance Context source", () => {
  it("emits no item for an empty or unknown active Tool set", async () => {
    const provider = createToolGuidanceContextSourceProvider({
      activeToolNames: asToolNames(["custom_tool"]),
    });

    expect((await provider.collect(sourceInput)).items).toEqual([]);
    expect(
      (await provider.collect({ ...sourceInput, signal: new AbortController().signal })).items,
    ).toEqual([]);
  });

  it("emits one native item with the wrapper and native token estimate", async () => {
    const recording = recordingEstimator();
    const provider = createToolGuidanceContextSourceProvider({
      activeToolNames: asToolNames(["read_file"]),
      tokenEstimator: recording.estimator,
    });

    const result = await provider.collect(sourceInput);
    const item = result.items[0];

    expect(result.providerId).toBe(CODING_CONTEXT_SOURCE_IDS.toolGuidance);
    expect(result.providerVersion).toBe("tool-guidance-v1");
    expect(result.items).toHaveLength(1);
    expect(item).toMatchObject({
      id: "coding.tool-guidance:active",
      type: "coding.tool_guidance",
      scope: "RUN",
      retention: "REHYDRATABLE",
      priorityClass: "NORMAL",
      cacheStability: "STABLE",
      freshness: "CURRENT",
      sensitivity: "PUBLIC",
      tokenEstimate: 777,
      whyLoaded: "active Coding Tool usage guidance",
      source: {
        providerId: CODING_CONTEXT_SOURCE_IDS.toolGuidance,
        sourceRef: "coding-tools:active",
        version: "tool-guidance-v1",
      },
      payload: {
        kind: "TEXT",
        text: expect.stringContaining("<tool_guidance>"),
      },
    });
    expect(item?.payload.kind === "TEXT" && item.payload.text).toContain("read_file\nPurpose:");
    expect(item?.payload.kind === "TEXT" && item.payload.text).toContain("</tool_guidance>");
    expect(recording.texts).toHaveLength(1);
    expect(recording.texts[0]).toBe(item?.payload.kind === "TEXT" ? item.payload.text : undefined);
  });

  it("preserves canonical active order and skips inactive or generic Tools", async () => {
    const provider = createToolGuidanceContextSourceProvider({
      activeToolNames: asToolNames(["apply_patch", "custom_tool", "read_file", "git_diff"]),
    });

    const result = await provider.collect(sourceInput);
    const text = result.items[0]?.payload.kind === "TEXT" ? result.items[0].payload.text : "";

    expect(text.indexOf("apply_patch\nPurpose:")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("read_file\nPurpose:")).toBeGreaterThan(
      text.indexOf("apply_patch\nPurpose:"),
    );
    expect(text.indexOf("git_diff\nPurpose:")).toBeGreaterThan(text.indexOf("read_file\nPurpose:"));
    expect(text).not.toContain("custom_tool");
  });

  it("keeps whole-snippet truncation at the total guidance byte bound", async () => {
    const snippet = promptSnippetFor("read_file" as ToolName)!;
    const repeatedNames = asToolNames(Array.from({ length: 1_000 }, () => "read_file"));
    const provider = createToolGuidanceContextSourceProvider({ activeToolNames: repeatedNames });
    const result = await provider.collect(sourceInput);
    const text = result.items[0]?.payload.kind === "TEXT" ? result.items[0].payload.text : "";

    let count = 0;
    let bytes = 0;
    while (bytes + Buffer.byteLength(snippet, "utf8") <= MAX_TOOL_PROMPT_TOTAL_BYTES) {
      bytes += Buffer.byteLength(snippet, "utf8");
      count += 1;
    }
    const expected = [
      "<tool_guidance>",
      "Tool usage guidance. Follow it when choosing and calling tools.",
      "",
      Array.from({ length: count }, () => snippet).join("\n\n"),
      "</tool_guidance>",
    ].join("\n");

    expect(text).toBe(expected);
    expect(text.endsWith("Results: Lines + truncation.</tool_guidance>")).toBe(false);
    expect(text.match(/read_file\nPurpose:/g)).toHaveLength(count);
  });

  it("is deterministic and freezes its native result", async () => {
    const provider = createToolGuidanceContextSourceProvider({
      activeToolNames: asToolNames(["read_file", "list_directory"]),
    });

    const first = await provider.collect(sourceInput);
    const second = await provider.collect(sourceInput);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.items)).toBe(true);
    expect(Object.isFrozen(first.items[0])).toBe(true);
  });
});
