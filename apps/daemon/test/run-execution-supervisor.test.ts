import {
  createRunId,
  type AgentRun,
  type ApprovalRequest,
  type ApprovalResolution,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RunExecutionSupervisor,
  RunExecutionSupervisorBusyError,
  RunExecutionSupervisorConflictError,
} from "../src/execution/run-execution-supervisor.js";

function run(status: AgentRun["status"] = "PENDING"): AgentRun {
  return {
    id: createRunId(),
    sessionId: "ses_00000000-0000-7000-8000-000000000000",
    goal: "test",
    status,
    workspace: { id: "wsp_00000000-0000-7000-8000-000000000000", path: "C:/workspace" },
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1_000 },
    createdAt: 1_700_000_000_000,
  };
}

function approval(runId: AgentRun["id"]): ApprovalRequest {
  return {
    id: "apr_00000000-0000-7000-8000-000000000000",
    runId,
    toolInvocationId: "tinv_00000000-0000-7000-8000-000000000000",
    riskLevel: "MEDIUM",
    title: "Approve test",
    reason: "test",
    action: { summary: "test" },
    status: "PENDING",
    scope: "ONCE",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_001_000,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RunExecutionSupervisor", () => {
  it("schedules start without waiting and deduplicates the same Run", async () => {
    const current = run();
    const gate = deferred<void>();
    const start = vi.fn(() => gate.promise);
    const controller = {
      start,
      recover: vi.fn(),
      resolveApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const supervisor = new RunExecutionSupervisor({
      runs: { get: vi.fn(async () => current) },
      controller,
    });

    const first = await supervisor.start(current.id);
    const second = await supervisor.start(current.id);
    expect(first.disposition).toBe("SCHEDULED");
    expect(second.disposition).toBe("ALREADY_ACTIVE");
    expect(start).toHaveBeenCalledTimes(1);
    expect(supervisor.activeRunIds()).toEqual([current.id]);

    gate.resolve();
    await supervisor.drain();
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("handles terminal start as a no-op and rejects recover for PENDING", async () => {
    const terminal = run("COMPLETED");
    const pending = run("PENDING");
    const get = vi.fn(async (id: string) => (id === terminal.id ? terminal : pending));
    const controller = {
      start: vi.fn(),
      recover: vi.fn(),
      resolveApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const supervisor = new RunExecutionSupervisor({ runs: { get }, controller });

    await expect(supervisor.start(terminal.id)).resolves.toMatchObject({
      disposition: "NOOP_TERMINAL",
    });
    await expect(supervisor.recover(pending.id)).rejects.toBeInstanceOf(
      RunExecutionSupervisorConflictError,
    );
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.recover).not.toHaveBeenCalled();
  });

  it("catches background rejection and uses token-safe cleanup", async () => {
    const current = run();
    const errors: unknown[] = [];
    const supervisor = new RunExecutionSupervisor({
      runs: { get: vi.fn(async () => current) },
      controller: {
        start: vi.fn(async () => {
          throw new Error("provider failure");
        }),
        recover: vi.fn(),
        resolveApproval: vi.fn(),
        cancel: vi.fn(),
      },
      logger: { error: (error) => errors.push(error) },
    });

    await supervisor.start(current.id);
    await supervisor.drain();
    expect(errors).toHaveLength(1);
    expect(supervisor.activeRunIds()).toEqual([]);
  });

  it("does not route cancellation behind the active driver", async () => {
    const current = run();
    const startGate = deferred<void>();
    const cancelGate = deferred<void>();
    const start = vi.fn(() => startGate.promise);
    const cancel = vi.fn(() => cancelGate.promise);
    const controller = { start, recover: vi.fn(), resolveApproval: vi.fn(), cancel };
    const supervisor = new RunExecutionSupervisor({
      runs: { get: vi.fn(async () => current) },
      controller,
    });

    await supervisor.start(current.id);
    const cancellation = supervisor.cancel(current.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    cancelGate.resolve();
    const result = await cancellation;
    expect(result.disposition).toBe("SETTLED");
    startGate.resolve();
    await supervisor.drain();
  });

  it("preflights and schedules only a matching approval", async () => {
    const current = run("WAITING_APPROVAL");
    const request = approval(current.id);
    const resolution: ApprovalResolution = { action: "APPROVE", scope: "ONCE" };
    const controller = {
      start: vi.fn(),
      recover: vi.fn(),
      resolveApproval: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };
    const supervisor = new RunExecutionSupervisor({
      runs: { get: vi.fn(async () => current) },
      approvals: { getById: vi.fn(async () => request) },
      controller,
    });

    const result = await supervisor.resolveApproval(current.id, request.id, resolution);
    expect(result.disposition).toBe("SCHEDULED");
    expect(controller.resolveApproval).toHaveBeenCalledWith(current.id, request.id, resolution);
    await supervisor.drain();
  });

  it("rejects an active approval driver instead of creating a second driver", async () => {
    const current = run("WAITING_APPROVAL");
    const request = approval(current.id);
    const gate = deferred<void>();
    const controller = {
      start: vi.fn(),
      recover: vi.fn(() => gate.promise),
      resolveApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const supervisor = new RunExecutionSupervisor({
      runs: { get: vi.fn(async () => current) },
      approvals: { getById: vi.fn(async () => request) },
      controller,
    });

    await supervisor.recover(current.id);
    await expect(
      supervisor.resolveApproval(current.id, request.id, { action: "REJECT" }),
    ).rejects.toBeInstanceOf(RunExecutionSupervisorBusyError);
    gate.resolve();
    await supervisor.drain();
  });
});
