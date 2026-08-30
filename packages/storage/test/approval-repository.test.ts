import {
  createApprovalRequestId,
  createEventId,
  createToolInvocationId,
  createTimestampMs,
  type ApprovalRequest,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createToolRequestedEvent, type ToolExecutionCommit } from "@caelush/tools";
import { openCaelushStorage } from "../src/index.js";
import { makeSession, makeRun, makeState, makeStep } from "./support/fixtures.js";
import { createRequestedToolInvocation, markToolInvocationWaitingApproval } from "@caelush/tools";

describe("SqliteApprovalRepository", () => {
  it("persists approval and resolves it atomically with one approval.resolved event", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    try {
      const session = makeSession();
      const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(101) });
      const step = makeStep(run.id, { status: "COMPLETED", finishedAt: createTimestampMs(102) });
      await storage.sessions.insert(session);
      await storage.runs.insert(run);
      await storage.steps.insert(step);
      await storage.runStates.save(makeState(run));
      const requested = createRequestedToolInvocation({
        id: createToolInvocationId(),
        runId: run.id,
        stepId: step.id,
        toolName: "apply_patch",
        externalCallId: "call-1",
        args: { patch: "*** Begin Patch" },
        riskLevel: "HIGH",
        createdAt: createTimestampMs(110),
      });
      const waiting = markToolInvocationWaitingApproval(requested);
      const approvalCreatedAt = createTimestampMs(Date.now());
      const approval: ApprovalRequest = {
        id: createApprovalRequestId(),
        runId: run.id,
        toolInvocationId: waiting.id,
        riskLevel: "HIGH",
        title: "Approve tool execution",
        reason: "Review required.",
        action: { kind: "TOOL_EXECUTION", toolName: waiting.toolName },
        status: "PENDING",
        scope: "RUN",
        expiresAt: createTimestampMs(approvalCreatedAt + 900_000),
        createdAt: approvalCreatedAt,
      };
      const event = createToolRequestedEvent({
        eventId: createEventId(),
        sessionId: session.id,
        timestamp: waiting.createdAt,
        invocation: waiting,
      });
      await storage.toolExecution.commit({
        sessionId: session.id,
        invocation: waiting,
        expectedRevision: null,
        approval,
        approvalKey: "key-1",
        events: [event],
      } satisfies ToolExecutionCommit);
      expect(await storage.approvals.getByInvocation(waiting.id)).toEqual(approval);
      const resolved = await storage.approvals.resolve(approval.id, {
        action: "APPROVE",
        scope: "RUN",
      });
      expect(resolved.status).toBe("APPROVED");
      expect(resolved.grantedScope).toBe("RUN");
      expect((await storage.events.replay(run.id)).map((item) => item.type)).toEqual([
        "tool.requested",
        "approval.resolved",
      ]);
      expect(
        await storage.approvals.resolve(approval.id, { action: "APPROVE", scope: "RUN" }),
      ).toEqual(resolved);
      await expect(storage.approvals.resolve(approval.id, { action: "REJECT" })).rejects.toThrow(
        "already been resolved differently",
      );
    } finally {
      await storage.close();
    }
  });
});
