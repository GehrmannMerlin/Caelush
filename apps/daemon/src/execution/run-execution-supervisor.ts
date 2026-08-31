import {
  type AgentRun,
  type ApprovalRequest,
  type ApprovalRequestId,
  type ApprovalResolution,
  type RunId,
} from "@caelush/protocol";
import { isTerminalRunStatus } from "@caelush/core";
import { StorageNotFoundError, type RunRepository } from "@caelush/storage";

export interface RunExecutionController {
  start(runId: RunId): Promise<unknown>;
  recover(runId: RunId): Promise<unknown>;
  resolveApproval(
    runId: RunId,
    approvalId: ApprovalRequestId,
    resolution: ApprovalResolution,
  ): Promise<unknown>;
  cancel(runId: RunId): Promise<unknown>;
}

export interface RunApprovalReader {
  getById(id: ApprovalRequestId): Promise<ApprovalRequest | null>;
}

export interface RunExecutionSupervisorLogger {
  error?(error: unknown, context: { readonly operation: string; readonly runId: RunId }): void;
}

export interface RunExecutionSupervisorOptions {
  readonly runs: Pick<RunRepository, "get">;
  readonly controller: RunExecutionController;
  readonly approvals?: RunApprovalReader;
  readonly logger?: RunExecutionSupervisorLogger;
}

export type RunExecutionSupervisorDisposition =
  "SCHEDULED" | "ALREADY_ACTIVE" | "NOOP_TERMINAL" | "SETTLED";

type BackgroundOperation = "START" | "RECOVER" | "RESOLVE_APPROVAL";

export interface RunExecutionSupervisorResult {
  readonly runId: RunId;
  readonly action: "START" | "RECOVER" | "CANCEL" | "RESOLVE_APPROVAL";
  readonly disposition: RunExecutionSupervisorDisposition;
  readonly run: AgentRun;
}

export class RunExecutionSupervisorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutionSupervisorConflictError";
  }
}

export class RunExecutionSupervisorBusyError extends Error {
  constructor(runId: RunId) {
    super(`Run ${runId} already has an active execution driver`);
    this.name = "RunExecutionSupervisorBusyError";
  }
}

export class RunExecutionSupervisorInfrastructureError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RunExecutionSupervisorInfrastructureError";
  }
}

interface ActiveExecution {
  readonly token: symbol;
  readonly task: Promise<void>;
}

export class RunExecutionSupervisor {
  private readonly active = new Map<RunId, ActiveExecution>();
  private disposed = false;

  constructor(private readonly options: RunExecutionSupervisorOptions) {}

  async start(runId: RunId): Promise<RunExecutionSupervisorResult> {
    const run = await this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) return this.noop(run, "START");
    if (this.active.has(runId)) return this.activeResult(run, "START");
    if (run.status !== "PENDING") {
      throw new RunExecutionSupervisorConflictError("Only a PENDING Run can be started.");
    }
    this.schedule(runId, "START", () => this.options.controller.start(runId));
    return this.scheduled(run, "START");
  }

  async recover(runId: RunId): Promise<RunExecutionSupervisorResult> {
    const run = await this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) return this.noop(run, "RECOVER");
    if (this.active.has(runId)) return this.activeResult(run, "RECOVER");
    if (run.status === "PENDING") {
      throw new RunExecutionSupervisorConflictError(
        "A PENDING Run must be started, not recovered.",
      );
    }
    this.schedule(runId, "RECOVER", () => this.options.controller.recover(runId));
    return this.scheduled(run, "RECOVER");
  }

  async resolveApproval(
    runId: RunId,
    approvalId: ApprovalRequestId,
    resolution: ApprovalResolution,
  ): Promise<RunExecutionSupervisorResult> {
    const run = await this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) return this.noop(run, "RESOLVE_APPROVAL");
    if (this.active.has(runId)) throw new RunExecutionSupervisorBusyError(runId);
    if (run.status !== "WAITING_APPROVAL") {
      throw new RunExecutionSupervisorConflictError(
        "Approval resolution requires a Run waiting for approval.",
      );
    }
    const approvals = this.options.approvals;
    if (approvals === undefined) {
      throw new RunExecutionSupervisorInfrastructureError("Approval lookup is not configured.");
    }
    const approval = await approvals.getById(approvalId);
    if (approval === null) throw new StorageNotFoundError("ApprovalRequest", approvalId);
    this.assertApprovalMatches(runId, approval, resolution);
    this.schedule(runId, "RESOLVE_APPROVAL", () =>
      this.options.controller.resolveApproval(runId, approvalId, resolution),
    );
    return this.scheduled(run, "RESOLVE_APPROVAL");
  }

  async cancel(runId: RunId): Promise<RunExecutionSupervisorResult> {
    const run = await this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) return this.noop(run, "CANCEL");
    await this.options.controller.cancel(runId);
    const settled = await this.requireRun(runId);
    return { runId, action: "CANCEL", disposition: "SETTLED", run: settled };
  }

  activeRunIds(): readonly RunId[] {
    return [...this.active.keys()];
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((entry) => entry.task));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.drain();
  }

  private async requireRun(runId: RunId): Promise<AgentRun> {
    const run = await this.options.runs.get(runId);
    if (run === null) throw new StorageNotFoundError("AgentRun", runId);
    return run;
  }

  private schedule(
    runId: RunId,
    operation: BackgroundOperation,
    task: () => Promise<unknown>,
  ): void {
    if (this.disposed) {
      throw new RunExecutionSupervisorConflictError("Supervisor is shutting down.");
    }
    const token = Symbol(operation);
    const execution: ActiveExecution = {
      token,
      task: Promise.resolve().then(() => this.runBackground(runId, operation, token, task)),
    };
    this.active.set(runId, execution);
  }

  private async runBackground(
    runId: RunId,
    operation: string,
    token: symbol,
    task: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      try {
        this.options.logger?.error?.(error, { operation, runId });
      } catch {
        // Logging must not turn a handled background failure into an unhandled rejection.
      }
    } finally {
      const current = this.active.get(runId);
      if (current?.token === token) this.active.delete(runId);
    }
  }

  private assertApprovalMatches(
    runId: RunId,
    approval: ApprovalRequest,
    resolution: ApprovalResolution,
  ): void {
    if (approval.runId !== runId) {
      throw new RunExecutionSupervisorConflictError("Approval does not belong to the Run.");
    }
    if (approval.status === "PENDING") {
      if (
        resolution.action === "APPROVE" &&
        approval.scope === "ONCE" &&
        resolution.scope === "RUN"
      ) {
        throw new RunExecutionSupervisorConflictError(
          "Approval resolution scope exceeds the request.",
        );
      }
      return;
    }
    const sameResolution =
      (approval.status === "APPROVED" &&
        resolution.action === "APPROVE" &&
        approval.grantedScope === resolution.scope) ||
      (approval.status === "REJECTED" && resolution.action === "REJECT");
    if (!sameResolution) {
      throw new RunExecutionSupervisorConflictError(
        "Approval already has a conflicting resolution.",
      );
    }
  }

  private scheduled(
    run: AgentRun,
    action: RunExecutionSupervisorResult["action"],
  ): RunExecutionSupervisorResult {
    return { runId: run.id, action, disposition: "SCHEDULED", run };
  }

  private activeResult(
    run: AgentRun,
    action: RunExecutionSupervisorResult["action"],
  ): RunExecutionSupervisorResult {
    return { runId: run.id, action, disposition: "ALREADY_ACTIVE", run };
  }

  private noop(
    run: AgentRun,
    action: RunExecutionSupervisorResult["action"],
  ): RunExecutionSupervisorResult {
    return { runId: run.id, action, disposition: "NOOP_TERMINAL", run };
  }
}
