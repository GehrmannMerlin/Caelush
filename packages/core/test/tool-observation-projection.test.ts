import { describe, expect, it } from "vitest";
import type { ToolExecutionSnapshot } from "@caelush/agent";
import {
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { toAIToolResultMessages } from "../src/agent-tool-batch.js";

/**
 * The durable batch encoding bounds a large settled observation.
 *
 * Phase 4F replaced the legacy per-item result with the canonical `ToolExecutionSnapshot`, so the
 * fixture now travels through the same durable shape production does: an invocation plus the
 * observation it settled with. The assertion is unchanged — the projection keeps the model call
 * identity, drops the middle of a huge output, and never drops the tail.
 */
function settled(content: string): ToolExecutionSnapshot {
  const runId = createRunId();
  const stepId = createStepId();
  const invocationId = createToolInvocationId();
  return {
    sessionId: createSessionId(),
    revision: 1,
    invocation: {
      id: invocationId,
      runId,
      stepId,
      toolName: "exec_command",
      externalCallId: "call-1",
      args: {},
      riskLevel: "CRITICAL",
      status: "COMPLETED",
      createdAt: createTimestampMs(1),
      finishedAt: createTimestampMs(2),
    },
    observation: {
      id: createObservationId(),
      runId,
      stepId,
      kind: "TOOL",
      toolInvocationId: invocationId,
      content,
      isError: false,
      createdAt: createTimestampMs(2),
    },
  };
}

describe("tool result model projection", () => {
  it("bounds large settled output while preserving source call identity", () => {
    const message = toAIToolResultMessages(
      [{ externalCallId: "call-1", toolName: "exec_command", args: {} }],
      [settled(`${"head\n".repeat(100_000)}tail-secret-marker`)],
    )[0]!;

    expect(message.toolCallId).toBe("call-1");
    expect(message.content.length).toBeLessThan(40_000);
    expect(message.content).toContain("output omitted");
    expect(message.content).toContain("tail-secret-marker");
  });
});
