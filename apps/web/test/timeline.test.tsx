import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationPlanId,
  type AgentEvent,
} from "@caelush/protocol";
import {
  createInitialTimelineState,
  reduceTimelineEvent,
  type TimelineState,
} from "@caelush/client";
import { Timeline } from "../src/components/timeline.js";

describe("Timeline", () => {
  it("renders safe projected activity without controls or raw process output", () => {
    const html = renderToStaticMarkup(<Timeline timeline={timelineFromVisibleEvents()} />);

    expect(html).toContain("执行过程");
    expect(html).toContain("推理摘要");
    expect(html).toContain("读取文件");
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("验证");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain("Inspector");
    expect(html).not.toContain("Terminal");
    expect(html).not.toContain("stdout");
  });
});

function timelineFromVisibleEvents(): TimelineState {
  const runId = createRunId();
  const sessionId = createSessionId();
  const stepId = createStepId();
  const invocationId = createToolInvocationId();
  const shellInvocationId = createToolInvocationId();
  const observationId = createObservationId();
  const planId = createVerificationPlanId();
  const checkId = createVerificationCheckId();
  const event = (type: AgentEvent["type"], sequence: number, payload: unknown): AgentEvent =>
    ({
      eventId: createEventId(),
      schemaVersion: 1,
      type,
      runId,
      sessionId,
      stepId,
      timestamp: sequence,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence },
      payload,
    }) as AgentEvent;

  return [
    event("reasoning.summary", 1, { summary: "检查认证代码" }),
    event("tool.requested", 2, { invocationId, toolName: "read_file", riskLevel: "LOW" }),
    event("tool.started", 3, { invocationId }),
    event("file.read", 4, { path: "src/auth.ts" }),
    event("tool.completed", 5, { invocationId, observationId }),
    event("tool.requested", 6, {
      invocationId: shellInvocationId,
      toolName: "exec_command",
      riskLevel: "HIGH",
    }),
    event("shell.started", 7, { invocationId: shellInvocationId }),
    event("shell.completed", 8, { invocationId: shellInvocationId, exitCode: 0 }),
    event("verification.planned", 9, {
      planId,
      sourceStepId: stepId,
      checkCount: 1,
      plannerVersion: "v1",
      counts: { required: 1, ifAvailable: 0, advisory: 0 },
    }),
    event("verification.check.started", 10, {
      planId,
      checkId,
      ordinal: 0,
      kind: "COMMAND",
      purpose: "REGRESSION",
      stage: "POST_CHANGE",
    }),
  ].reduce(reduceTimelineEvent, createInitialTimelineState(runId));
}
