import { describe, expect, it } from "vitest";
import type { ToolExecutionSnapshot } from "@caelush/agent";
import {
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type ToolObservation,
} from "@caelush/protocol";
import { toAIToolResultMessages, ToolBatchResultConversionError } from "../src/index.js";

/**
 * The legacy durable Tool batch encoding.
 *
 * ```text
 * canonical input    ToolExecutionSnapshot[]   the durable invocation and, when it settled, its observation
 *        ↓
 * Context token projection
 *        ↓
 * AIToolResultMessage[]   the model-facing conversation encoding the Context runtime reads
 * ```
 *
 * Phase 4F replaced the legacy per-item result with the canonical durable snapshot. These assertions are
 * the same ones they always were: the batch is re-ordered to source order, the structured details never
 * reach a model, and a batch that does not line up is refused rather than projected.
 */
const requests = [
  { externalCallId: "call_b", toolName: "echo_value" as const, args: {} },
  { externalCallId: "call_a", toolName: "echo_value" as const, args: {} },
];

/** One settled durable snapshot: an invocation plus the observation it settled with. */
function settled(input: {
  externalCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  details?: Record<string, unknown>;
}): ToolExecutionSnapshot {
  const runId = createRunId();
  const stepId = createStepId();
  const invocationId = createToolInvocationId();
  const observation: ToolObservation = {
    id: createObservationId(),
    runId,
    stepId,
    kind: "TOOL",
    toolInvocationId: invocationId,
    content: input.content,
    isError: input.isError,
    createdAt: createTimestampMs(2),
    ...(input.details === undefined ? {} : { details: input.details as never }),
  };
  return {
    sessionId: createSessionId(),
    revision: 1,
    invocation: {
      id: invocationId,
      runId,
      stepId,
      toolName: input.toolName as never,
      externalCallId: input.externalCallId,
      args: {},
      riskLevel: "LOW",
      status: input.isError ? "FAILED" : "COMPLETED",
      createdAt: createTimestampMs(1),
      finishedAt: createTimestampMs(2),
    },
    observation,
  };
}

describe("Tool Batch to AI result conversion", () => {
  it("preserves request source order and excludes durable details", () => {
    const snapshots = [
      settled({
        externalCallId: "call_b",
        toolName: "echo_value",
        content: "B",
        isError: false,
        details: { secret: "CAELUSH_TOOL_DETAILS_SECRET_42" },
      }),
      settled({
        externalCallId: "call_a",
        toolName: "echo_value",
        content: "A",
        isError: true,
      }),
    ];

    const messages = toAIToolResultMessages(requests, snapshots);

    expect(messages).toEqual([
      { role: "tool", toolCallId: "call_b", toolName: "echo_value", content: "B", isError: false },
      { role: "tool", toolCallId: "call_a", toolName: "echo_value", content: "A", isError: true },
    ]);
    expect(JSON.stringify(messages)).not.toContain("CAELUSH_TOOL_DETAILS_SECRET_42");
  });

  it("rejects a snapshot batch whose identity does not match the request", () => {
    expect(() =>
      toAIToolResultMessages(requests, [
        settled({
          externalCallId: "wrong",
          toolName: "echo_value",
          content: "bad",
          isError: true,
        }),
        settled({
          externalCallId: "call_a",
          toolName: "echo_value",
          content: "A",
          isError: false,
        }),
      ]),
    ).toThrow(ToolBatchResultConversionError);
  });

  it("rejects a batch whose length does not match the request", () => {
    expect(() =>
      toAIToolResultMessages(requests, [
        settled({
          externalCallId: "call_b",
          toolName: "echo_value",
          content: "B",
          isError: false,
        }),
      ]),
    ).toThrow(ToolBatchResultConversionError);
  });

  it("refuses a snapshot that has no observation rather than projecting empty content", () => {
    const unsettled: ToolExecutionSnapshot = {
      sessionId: createSessionId(),
      revision: 1,
      invocation: {
        id: createToolInvocationId(),
        runId: createRunId(),
        stepId: createStepId(),
        toolName: "echo_value" as never,
        externalCallId: "call_b",
        args: {},
        riskLevel: "LOW",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
    };
    expect(() =>
      toAIToolResultMessages(requests, [
        unsettled,
        settled({
          externalCallId: "call_a",
          toolName: "echo_value",
          content: "A",
          isError: false,
        }),
      ]),
    ).toThrow(ToolBatchResultConversionError);
  });
});
