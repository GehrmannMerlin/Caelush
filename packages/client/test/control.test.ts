import {
  ApprovalRequestSchema,
  createApprovalRequestId,
  createRunId,
  createToolInvocationId,
  type ApprovalRequest,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  approvalOptions,
  approvalResolutionForOption,
  canCancelRunStatus,
  createApprovalView,
  isTerminalRunStatus,
  RECONNECT_DELAYS_MS,
  ReconnectScheduler,
  type Timer,
  type TimerHandle,
} from "../src/index.js";

describe("shared interactive control", () => {
  it("projects bounded allowlisted approval fields and preserves ONCE/RUN/REJECT mappings", () => {
    const view = createApprovalView(
      makeApproval({
        action: {
          toolName: "read_file",
          requiredCapabilities: ["filesystem.read", 7, "process.spawn"],
          summary: "Read a source file",
          command: "SECRET_COMMAND",
          stdin: "SECRET_STDIN",
        },
      }),
    );

    expect(view).toMatchObject({
      toolName: "read_file",
      requiredCapabilities: ["filesystem.read", "process.spawn"],
      summary: "Read a source file",
    });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(approvalOptions("ONCE").map((item) => item.kind)).toEqual([
      "APPROVE_ONCE",
      "REJECT",
    ]);
    expect(approvalOptions("RUN").map((item) => item.kind)).toEqual([
      "APPROVE_ONCE",
      "APPROVE_RUN",
      "REJECT",
    ]);
    expect(approvalResolutionForOption("APPROVE_ONCE")).toEqual({
      action: "APPROVE",
      scope: "ONCE",
    });
    expect(approvalResolutionForOption("APPROVE_RUN")).toEqual({
      action: "APPROVE",
      scope: "RUN",
    });
    expect(approvalResolutionForOption("REJECT")).toEqual({ action: "REJECT" });
  });

  it("identifies exactly cancellable and terminal run statuses", () => {
    expect(canCancelRunStatus("RUNNING")).toBe(true);
    expect(canCancelRunStatus("WAITING_APPROVAL")).toBe(true);
    expect(canCancelRunStatus("VERIFYING")).toBe(true);
    expect(canCancelRunStatus("PENDING")).toBe(false);
    expect(canCancelRunStatus("COMPLETED")).toBe(false);
    expect(isTerminalRunStatus("COMPLETED")).toBe(true);
    expect(isTerminalRunStatus("FAILED")).toBe(true);
    expect(isTerminalRunStatus("CANCELLED")).toBe(true);
    expect(isTerminalRunStatus("TIMEOUT")).toBe(true);
    expect(isTerminalRunStatus("MAX_STEPS_REACHED")).toBe(true);
    expect(isTerminalRunStatus("BUDGET_EXCEEDED")).toBe(true);
    expect(isTerminalRunStatus("VERIFYING")).toBe(false);
  });

  it("retries with the fixed sequence, resets after success and manual retry, exhausts, and disposes", () => {
    const timer = new FakeTimer();
    const attempts: number[] = [];
    const scheduler = new ReconnectScheduler({
      timer,
      onAttempt: (attempt) => attempts.push(attempt),
      onExhausted: () => attempts.push(99),
    });

    scheduler.start();
    timer.runNext();
    scheduler.succeeded();
    expect(timer.pendingCount).toBe(0);
    scheduler.manualRetry();
    timer.runNext();
    expect(attempts).toEqual([1, 1]);
    scheduler.failed();

    for (let index = 1; index < RECONNECT_DELAYS_MS.length; index += 1) {
      timer.runNext();
      scheduler.failed();
    }

    expect(timer.delays).toEqual([250, 250, 500, 1000, 2000, 4000, 5000]);
    expect(attempts).toEqual([1, 1, 2, 3, 4, 5, 6, 99]);
    scheduler.manualRetry();
    expect(timer.pendingCount).toBe(1);
    scheduler.dispose();
    expect(timer.pendingCount).toBe(0);
    timer.runAll();
    expect(attempts).toEqual([1, 1, 2, 3, 4, 5, 6, 99]);
  });
});

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: createApprovalRequestId(),
    runId: createRunId(),
    toolInvocationId: createToolInvocationId(),
    riskLevel: "HIGH",
    title: "Permission required",
    reason: "The tool needs access.",
    action: {
      toolName: "read_file",
      requiredCapabilities: ["filesystem.read"],
      summary: "Read a source file",
    },
    status: "PENDING",
    scope: "ONCE",
    createdAt: 1,
    ...overrides,
  });
}

class FakeTimer implements Timer {
  readonly delays: number[] = [];
  private callbacks: Array<{ readonly callback: () => void; cancelled: boolean }> = [];

  get pendingCount(): number {
    return this.callbacks.filter((item) => !item.cancelled).length;
  }

  schedule(delayMs: number, callback: () => void): TimerHandle {
    const item = { callback, cancelled: false };
    this.delays.push(delayMs);
    this.callbacks.push(item);
    return { cancel: () => (item.cancelled = true) };
  }

  runNext(): void {
    const item = this.callbacks.find((candidate) => !candidate.cancelled);
    if (item === undefined) throw new Error("No timer is pending.");
    item.cancelled = true;
    item.callback();
  }

  runAll(): void {
    while (this.pendingCount > 0) this.runNext();
  }
}
