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
    expect(html).toContain("决策摘要");
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

  it("renders bounded public Tool details without exposing raw output", () => {
    const timeline = createInitialTimelineState();
    const html = renderToStaticMarkup(
      <Timeline
        timeline={{
          ...timeline,
          settled: [
            {
              id: "patch-tool",
              kind: "TOOL",
              status: "COMPLETED",
              toolName: "apply_patch",
              detail: "M src/app.ts (+2, -1)",
              filePath: "src/app.ts",
            },
            {
              id: "shell-tool",
              kind: "TOOL",
              status: "COMPLETED",
              toolName: "exec_command",
              text: "Command exited with code 0.",
              detail: "raw stdout sentinel",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("M src/app.ts (+2, -1)");
    expect(html).toContain("Command exited with code 0.");
    expect(html).not.toContain("raw stdout sentinel");
  });

  it("never renders raw Tool text or detail after a tool output event", () => {
    const runId = createRunId();
    const sessionId = createSessionId();
    const stepId = createStepId();
    const invocationId = "tool-output-sentinel";
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
    let timeline = createInitialTimelineState(runId);
    timeline = reduceTimelineEvent(
      timeline,
      event("tool.requested", 1, { invocationId, toolName: "read_file", riskLevel: "LOW" }),
    );
    timeline = reduceTimelineEvent(
      timeline,
      event("tool.output", 2, {
        invocationId,
        stream: "stdout",
        chunk: "SECRET_TOOL_OUTPUT_SENTINEL",
      }),
    );
    timeline = reduceTimelineEvent(
      timeline,
      event("tool.completed", 3, { invocationId, observationId: createObservationId() }),
    );

    const html = renderToStaticMarkup(<Timeline timeline={timeline} />);

    expect(html).toContain("读取文件");
    expect(html).toContain("已完成");
    expect(html).not.toContain("SECRET_TOOL_OUTPUT_SENTINEL");
    expect(html).not.toContain("stdout");
  });

  it("renders bounded public projection IDs without evidence IDs or event payloads", () => {
    const runId = createRunId();
    const sessionId = createSessionId();
    const stepId = createStepId();
    const invocationId = "invocation-sentinel";
    const processId = "process-sentinel";
    const planId = "plan-sentinel";
    const checkId = "check-sentinel";
    const evidenceId = "evidence-sentinel";
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
    let timeline = createInitialTimelineState(runId);
    timeline = reduceTimelineEvent(
      timeline,
      event("tool.requested", 1, { invocationId, toolName: "unknown_tool", riskLevel: "LOW" }),
    );
    timeline = reduceTimelineEvent(
      timeline,
      event("process.started", 2, {
        process: { id: processId, command: "safe command", status: "RUNNING" },
      }),
    );
    timeline = reduceTimelineEvent(
      timeline,
      event("verification.planned", 3, {
        planId,
        sourceStepId: stepId,
        checkCount: 1,
        plannerVersion: "v1",
        counts: { required: 1, ifAvailable: 0, advisory: 0 },
      }),
    );
    timeline = reduceTimelineEvent(
      timeline,
      event("verification.check.started", 4, {
        planId,
        checkId,
        ordinal: 0,
        kind: "COMMAND",
        purpose: "REGRESSION",
        stage: "POST_CHANGE",
      }),
    );
    timeline = reduceTimelineEvent(
      timeline,
      event("verification.check.completed", 5, {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: [evidenceId],
        durationMs: 12,
      }),
    );

    const html = renderToStaticMarkup(<Timeline timeline={timeline} />);

    expect(html).toContain("unknown_tool");
    expect(html).toContain(invocationId);
    expect(html).toContain(processId);
    expect(html).toContain(planId);
    expect(html).toContain(checkId);
    expect(html).not.toContain(evidenceId);
    expect(html).not.toContain("evidenceIds");
    expect(html).not.toContain('"payload"');
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
