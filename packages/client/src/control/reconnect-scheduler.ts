export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 5000] as const;

export interface TimerHandle {
  cancel(): void;
}

export interface Timer {
  schedule(delayMs: number, callback: () => void): TimerHandle;
}

export interface ReconnectSchedulerOptions {
  readonly timer: Timer;
  readonly onAttempt: (attempt: number) => void;
  readonly onExhausted: () => void;
}

type SchedulerPhase = "IDLE" | "WAITING" | "ATTEMPTING" | "EXHAUSTED" | "DISPOSED";

export class ReconnectScheduler {
  private phase: SchedulerPhase = "IDLE";
  private attempt = 0;
  private pendingTimer: TimerHandle | undefined;

  constructor(private readonly options: ReconnectSchedulerOptions) {}

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
    if (this.phase === "IDLE") {
      this.scheduleNext();
      return;
    }
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
    if (this.attempt >= RECONNECT_DELAYS_MS.length) {
      this.phase = "EXHAUSTED";
      this.options.onExhausted();
      return;
    }

    const attempt = this.attempt + 1;
    const delay = RECONNECT_DELAYS_MS[attempt - 1]!;
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
