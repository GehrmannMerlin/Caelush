import type { RunId } from "@caelush/protocol";

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
  private settleScope!: () => void;
  private isSettled = false;

  constructor(readonly runId: RunId) {
    this.signal = this.controller.signal;
    this.settled = new Promise<void>((resolve) => {
      this.settleScope = resolve;
    });
  }

  abort(): void {
    if (!this.signal.aborted) this.controller.abort();
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

  abort(runId: RunId): boolean {
    const scope = this.scopes.get(runId);
    if (scope === undefined) return false;
    scope.abort();
    return true;
  }

  close(runId: RunId, scope: RunExecutionScope): void {
    if (this.scopes.get(runId) === scope) {
      scope.settle();
      this.scopes.delete(runId);
    }
  }
}
