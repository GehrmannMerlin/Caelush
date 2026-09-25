import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createRequestedToolInvocation,
  createToolAdmissionCoordinator,
  type ToolAdmissionPort,
} from "@caelush/agent";

describe("Phase 6G Tool admission evaluation context", () => {
  it("forwards mode and the caller's signal without widening ToolAdmissionRequest", async () => {
    const signal = new AbortController().signal;
    let observed: { mode: string; signal: AbortSignal } | undefined;
    const policy: ToolAdmissionPort = {
      async evaluate(_request, context) {
        observed =
          context === undefined ? undefined : { mode: context.mode, signal: context.signal };
        return { kind: "ALLOW" };
      },
    };
    const coordinator = createToolAdmissionCoordinator({
      policy,
      clock: { now: () => createTimestampMs(1) },
      eventIdFactory: { create: () => "event-1" as never },
    });

    await coordinator.admit(
      {
        sessionId: createSessionId(),
        invocation: createRequestedToolInvocation({
          id: createToolInvocationId(),
          runId: createRunId(),
          stepId: createStepId(),
          toolName: "echo_value",
          externalCallId: "call-1",
          args: { value: "hello" },
          riskLevel: "LOW",
          createdAt: createTimestampMs(1),
        }),
        call: {
          request: { externalCallId: "call-1", toolName: "echo_value", args: { value: "hello" } },
          resolved: { tool: { name: "echo_value" } } as never,
          args: { value: "hello" },
        } as never,
        environment: {
          workspace: { id: createWorkspaceId(), path: "C:/workspace" },
          runtime: { id: "local", kind: "local" },
        },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "NEVER_ASK" },
      },
      { mode: "RECOVER", signal },
    );

    expect(observed).toEqual({ mode: "RECOVER", signal });
  });
});
