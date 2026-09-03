import type { LLMMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import {
  buildExecutionUnits,
  createExecutionUnit,
  isCompactionCandidate,
  selectSafeExecutionUnits,
} from "../src/execution-unit.js";

const assistant = (id: string): LLMMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: id } }],
});
const result = (id: string): LLMMessage => ({
  role: "tool",
  toolCallId: id,
  toolName: "read_file",
  content: `result-${id}`,
  isError: false,
});

describe("ExecutionUnit", () => {
  it("keeps an assistant tool call and all results in one closed atomic unit", () => {
    const units = buildExecutionUnits(
      [{ role: "user", content: "goal" }, assistant("a"), result("a"), assistant("b")],
      { runId: "run-1", createdAt: 1, estimateText: (text) => text.length },
    );

    expect(units).toHaveLength(2);
    expect(units[0]?.status).toBe("CLOSED");
    expect(units[0]?.toolInvocationIds).toEqual(["a"]);
    expect(units[1]?.status).toBe("OPEN");
    expect(isCompactionCandidate(units[0]!)).toBe(true);
    expect(isCompactionCandidate(units[1]!)).toBe(false);
  });

  it("selects only complete closed units for a safe cut", () => {
    const units = [
      createExecutionUnit({
        id: "u1",
        runId: "run-1",
        sourceSequenceFrom: 1,
        sourceSequenceTo: 2,
        status: "CLOSED",
        assistantMessageRef: "assistant-1",
        toolInvocationIds: ["a"],
        toolResultRefs: ["result-a"],
        tokenEstimate: 20,
        createdAt: 1,
        closedAt: 2,
      }),
      createExecutionUnit({
        id: "u2",
        runId: "run-1",
        sourceSequenceFrom: 3,
        sourceSequenceTo: 4,
        status: "OPEN",
        assistantMessageRef: "assistant-2",
        toolInvocationIds: ["b"],
        toolResultRefs: [],
        tokenEstimate: 20,
        createdAt: 3,
      }),
    ];

    expect(selectSafeExecutionUnits(units, 100)).toEqual([units[0]]);
    expect(selectSafeExecutionUnits(units, 10)).toEqual([]);
  });
});
