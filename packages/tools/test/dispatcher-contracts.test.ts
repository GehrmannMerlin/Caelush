import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolInvocation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type {
  DurableToolAgentEvent,
  ToolCommittedEventNotifier,
  ToolDispatchRequest,
  ToolDispatcherOutcome,
  ToolExecutionGatePort,
  ToolExecutionStorePort,
  ToolExecutionSnapshot,
} from "../src/index.js";
import { assertToolDispatchRequest } from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

describe("dispatcher public contracts", () => {
  it("keeps a dispatch request JSON-safe and independent from storage/events", () => {
    const request: ToolDispatchRequest = {
      sessionId: createSessionId(),
      runId: createRunId(),
      stepId: createStepId(),
      externalCallId: "call-1",
      toolName: "echo_value",
      args: { value: "hello" },
      environment,
    };

    expect(request.args).toEqual({ value: "hello" });
  });

  it("describes the injected gate, store, and committed-event notifier", async () => {
    const invocation = {
      id: createToolInvocationId(),
      runId: createRunId(),
      stepId: createStepId(),
      toolName: "echo_value",
      externalCallId: "call-1",
      args: {},
      riskLevel: "LOW",
      status: "REQUESTED",
      createdAt: createTimestampMs(100),
    } satisfies ToolInvocation;
    const snapshot: ToolExecutionSnapshot = {
      sessionId: createSessionId(),
      invocation,
      revision: 1,
    };
    const store: ToolExecutionStorePort = {
      async load() {
        return snapshot;
      },
      async findByExternalCall() {
        return snapshot;
      },
      async commit() {
        return { snapshot, events: [] };
      },
    };
    const gate: ToolExecutionGatePort = {
      async decide() {
        return { kind: "ALLOW" };
      },
    };
    const received: DurableToolAgentEvent[] = [];
    const notifier: ToolCommittedEventNotifier = {
      notifyCommitted(events) {
        received.push(...events);
      },
    };

    expect((await store.load(invocation.id))?.revision).toBe(1);
    expect(
      await gate.decide({
        invocation,
        toolName: invocation.toolName,
        definition: {
          name: invocation.toolName,
          riskLevel: invocation.riskLevel,
          requiredCapabilities: [],
          runtimeRequirements: {},
        },
      }),
    ).toEqual({
      kind: "ALLOW",
    });
    notifier.notifyCommitted([]);
    expect(received).toHaveLength(0);
  });

  it("uses explicit outcome kinds instead of LLM-specific result messages", () => {
    const outcome = { kind: "WAITING_APPROVAL", invocation: {} } as ToolDispatcherOutcome;

    expect(outcome.kind).toBe("WAITING_APPROVAL");
  });

  it("rejects a dispatch request with an empty external call identity", () => {
    expect(() =>
      assertToolDispatchRequest({
        sessionId: "ses_01999999-9999-7999-8999-999999999999",
        runId: createRunId(),
        stepId: createStepId(),
        externalCallId: "",
        toolName: "echo_value",
        args: {},
        environment,
      }),
    ).toThrow("externalCallId");
  });
});
