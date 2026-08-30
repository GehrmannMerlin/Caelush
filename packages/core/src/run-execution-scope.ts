import type { RunId } from "@caelush/protocol";
import type { RunExecutionAbortCause } from "./run-termination-authority.js";

export class RunExecutionScopeBusyError extends Error {
  constructor(runId: RunId) {
    super(`Run ${runId} already has an active execution scope.`);
    this.name = "RunExecutionScopeBusyError";
  }
}

export class RunExecutionScope {
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  private readonly controller = new AbortController();
  private cause: RunExecutionAbortCause | undefined;
  private settleScope!: () => void;
  private isSettled = false;

  constructor(readonly runId: RunId) {
    this.signal = this.controller.signal;
    this.settled = new Promise<void>((resolve) => {
      this.settleScope = resolve;
    });
  }

  abort(cause: RunExecutionAbortCause): void {
    if (this.signal.aborted) return;
    this.cause = cause;
    this.controller.abort(cause);
  }

  get abortCause(): RunExecutionAbortCause | undefined {
    return this.cause;
  }

  settle(): void {
    if (this.isSettled) return;
    this.isSettled = true;
    this.settleScope();
  }
}

export class RunExecutionScopeRegistry {
  private readonly scopes = new Map<RunId, RunExecutionScope>();

  open(runId: RunId): RunExecutionScope {
    if (this.scopes.has(runId)) throw new RunExecutionScopeBusyError(runId);
    const scope = new RunExecutionScope(runId);
    this.scopes.set(runId, scope);
    return scope;
  }

  get(runId: RunId): RunExecutionScope | undefined {
    return this.scopes.get(runId);
  }

  abort(runId: RunId, cause: RunExecutionAbortCause): boolean {
    const scope = this.scopes.get(runId);
    if (scope === undefined) return false;
    scope.abort(cause);
    return true;
  }

  close(runId: RunId, scope: RunExecutionScope): void {
    if (this.scopes.get(runId) === scope) {
      scope.settle();
      this.scopes.delete(runId);
    }
  }
}
