export const CLI_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 5000] as const;

export interface CliTimerHandle {
  cancel(): void;
}

export interface CliTimer {
  schedule(delayMs: number, callback: () => void): CliTimerHandle;
}

export interface CliReconnectSchedulerOptions {
  readonly timer: CliTimer;
  readonly onAttempt: (attempt: number) => void;
  readonly onExhausted: () => void;
}

type SchedulerPhase = "IDLE" | "WAITING" | "ATTEMPTING" | "EXHAUSTED" | "DISPOSED";

export class CliReconnectScheduler {
  private phase: SchedulerPhase = "IDLE";
  private attempt = 0;
  private pendingTimer: CliTimerHandle | undefined;

  constructor(private readonly options: CliReconnectSchedulerOptions) {}

  start(): void {
    if (this.phase !== "IDLE") return;
    this.scheduleNext();
  }

  manualRetry(): void {
    if (this.phase !== "IDLE" && this.phase !== "EXHAUSTED") return;
    this.attempt = 0;
    this.phase = "IDLE";
    this.scheduleNext();
  }

  succeeded(): void {
    if (this.phase === "DISPOSED") return;
    this.pendingTimer?.cancel();
    this.pendingTimer = undefined;
    this.attempt = 0;
    this.phase = "IDLE";
  }

  failed(): void {
    if (this.phase !== "ATTEMPTING") return;
    this.scheduleNext();
  }

  dispose(): void {
    if (this.phase === "DISPOSED") return;
    this.pendingTimer?.cancel();
    this.pendingTimer = undefined;
    this.phase = "DISPOSED";
  }

  private scheduleNext(): void {
    if (this.phase === "DISPOSED") return;
    if (this.attempt >= CLI_RECONNECT_DELAYS_MS.length) {
      this.phase = "EXHAUSTED";
      this.options.onExhausted();
      return;
    }

    const attempt = this.attempt + 1;
    const delay = CLI_RECONNECT_DELAYS_MS[attempt - 1]!;
    this.attempt = attempt;
    this.phase = "WAITING";
    this.pendingTimer = this.options.timer.schedule(delay, () => {
      this.pendingTimer = undefined;
      if (this.phase === "DISPOSED") return;
      this.phase = "ATTEMPTING";
      this.options.onAttempt(attempt);
    });
  }
}
