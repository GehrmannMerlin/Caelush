import { describe, expect, it } from "vitest";

import {
  InterruptedToolBatchReconciliationError,
  deriveInterruptedToolResultMessageId,
  isAgentMessageId,
  reconcileInterruptedToolBatches,
} from "@caelush/agent";

import { assistantMessage, toolResultMessage, userMessage } from "./fixtures.js";

describe("interrupted Tool batch reconciliation", () => {
  it("derives stable, distinct closure message identities from the full call scope", () => {
    const first = deriveInterruptedToolResultMessageId({
      sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never,
      sourceRunId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as never,
      assistantMessageId: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001" as never,
      toolCallId: "call_a",
      closureVersion: 1,
    });
    const retry = deriveInterruptedToolResultMessageId({
      sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never,
      sourceRunId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as never,
      assistantMessageId: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001" as never,
      toolCallId: "call_a",
      closureVersion: 1,
    });
    const otherCall = deriveInterruptedToolResultMessageId({
      sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never,
      sourceRunId: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as never,
      assistantMessageId: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001" as never,
      toolCallId: "call_b",
      closureVersion: 1,
    });

    expect(isAgentMessageId(first)).toBe(true);
    expect(retry).toBe(first);
    expect(otherCall).not.toBe(first);
  });

  it("finds four unanswered calls in source order when the durable start ledger is verified", () => {
    const messages = [
      userMessage({ sequence: 1 }),
      assistantMessage({
        toolCalls: ["call_a", "call_b", "call_c", "call_d"],
        sequence: 2,
      }),
    ];

    const batches = reconcileInterruptedToolBatches({
      sessionId: messages[0]!.message.sessionId,
      runId: messages[0]!.message.runId,
      messages,
      executionsByCallId: new Map([
        ["call_a", null],
        ["call_b", null],
        ["call_c", null],
        ["call_d", null],
      ]),
      missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED",
    });

    expect(batches).toHaveLength(1);
    expect(
      batches[0]?.calls.map(({ call, classification }) => [call.toolCallId, classification]),
    ).toEqual([
      ["call_a", "NOT_STARTED"],
      ["call_b", "NOT_STARTED"],
      ["call_c", "NOT_STARTED"],
      ["call_d", "NOT_STARTED"],
    ]);
  });

  it("preserves a committed result and separates started unknown work from confirmed observations", () => {
    const user = userMessage({ sequence: 1 });
    const assistant = assistantMessage({
      toolCalls: ["call_a", "call_b", "call_c", "call_d"],
      sequence: 2,
    });
    const completed = executionSnapshot({
      callId: "call_b",
      toolName: "tool_1",
      status: "COMPLETED",
    });
    const unknown = executionSnapshot({ callId: "call_c", toolName: "tool_2", status: "RUNNING" });
    const cancelled = executionSnapshot({
      callId: "call_d",
      toolName: "tool_3",
      status: "CANCELLED",
    });

    const batches = reconcileInterruptedToolBatches({
      sessionId: user.message.sessionId,
      runId: user.message.runId,
      messages: [
        user,
        assistant,
        toolResultMessage({ toolCallId: "call_a", toolName: "tool_0", sequence: 3 }),
      ],
      executionsByCallId: new Map([
        ["call_a", executionSnapshot({ callId: "call_a", status: "COMPLETED" })],
        ["call_b", completed],
        ["call_c", unknown],
        ["call_d", cancelled],
      ]),
      missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED",
    });

    expect(
      batches[0]?.calls.map(({ call, classification }) => [call.toolCallId, classification]),
    ).toEqual([
      ["call_a", "RESULT_COMMITTED"],
      ["call_b", "OBSERVATION_COMMITTED"],
      ["call_c", "OUTCOME_UNKNOWN"],
      ["call_d", "CANCELLED_CONFIRMED"],
    ]);
  });

  it("does not infer NOT_STARTED from a missing invocation without the startup contract", () => {
    const user = userMessage({ sequence: 1 });
    const assistant = assistantMessage({ toolCalls: ["call_a"], sequence: 2 });

    const batches = reconcileInterruptedToolBatches({
      sessionId: user.message.sessionId,
      runId: user.message.runId,
      messages: [user, assistant],
      executionsByCallId: new Map([["call_a", null]]),
      missingInvocationEvidence: "UNVERIFIED",
    });

    expect(batches[0]?.calls[0]?.classification).toBe("OUTCOME_UNKNOWN");
  });

  it("refuses a terminal invocation whose atomically committed observation is missing", () => {
    const user = userMessage({ sequence: 1 });
    const assistant = assistantMessage({ toolCalls: ["call_a"], sequence: 2 });

    expect(() =>
      reconcileInterruptedToolBatches({
        sessionId: user.message.sessionId,
        runId: user.message.runId,
        messages: [user, assistant],
        executionsByCallId: new Map([
          [
            "call_a",
            executionSnapshot({ callId: "call_a", status: "COMPLETED", observation: false }),
          ],
        ]),
        missingInvocationEvidence: "DURABLE_STARTUP_CONTRACT_VERIFIED",
      }),
    ).toThrow(InterruptedToolBatchReconciliationError);
  });

  it("refuses a non-prefix set of already committed Tool Results", () => {
    const user = userMessage({ sequence: 1 });
    const assistant = assistantMessage({ toolCalls: ["call_a", "call_b"], sequence: 2 });

    expect(() =>
      reconcileInterruptedToolBatches({
        sessionId: user.message.sessionId,
        runId: user.message.runId,
        messages: [
          user,
          assistant,
          toolResultMessage({ toolCallId: "call_b", toolName: "tool_1", sequence: 3 }),
          toolResultMessage({ toolCallId: "call_a", toolName: "tool_0", sequence: 4 }),
        ],
        executionsByCallId: new Map(),
        missingInvocationEvidence: "UNVERIFIED",
      }),
    ).toThrow(InterruptedToolBatchReconciliationError);
  });
});

function executionSnapshot(input: {
  readonly callId: string;
  readonly toolName?: string;
  readonly status: "COMPLETED" | "RUNNING" | "CANCELLED";
  readonly observation?: boolean;
}) {
  const user = userMessage();
  const assistant = assistantMessage({ toolCalls: [input.callId] });
  const invocationId = `tinv_${input.callId}` as never;
  return {
    sessionId: user.message.sessionId,
    invocation: {
      id: invocationId,
      runId: user.message.runId,
      stepId: assistant.message.sourceStepId!,
      toolName: (input.toolName ?? "tool_0") as never,
      externalCallId: input.callId,
      args: { index: 0 },
      riskLevel: "LOW" as const,
      status: input.status,
      createdAt: 1_700_000_000_000 as never,
      ...(input.status === "RUNNING" ? { startedAt: 1_700_000_000_001 as never } : {}),
      ...(input.status !== "RUNNING" ? { finishedAt: 1_700_000_000_002 as never } : {}),
    },
    revision: 1,
    ...(input.status === "COMPLETED" && input.observation !== false
      ? {
          observation: {
            id: "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9d" as never,
            runId: user.message.runId,
            stepId: assistant.message.sourceStepId!,
            content: "observed",
            isError: false,
            createdAt: 1_700_000_000_002 as never,
            kind: "TOOL" as const,
            toolInvocationId: invocationId,
          },
        }
      : {}),
  } as const;
}
