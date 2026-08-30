import type { RunId, TimestampMs } from "@caelush/protocol";

export const DEFAULT_MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface RunDeadlineTimerHandle {
  cancel(): void;
}

export interface RunDeadlineTimerPort {
  schedule(delayMs: number, callback: () => void | Promise<void>): RunDeadlineTimerHandle;
}

export class SystemRunDeadlineTimer implements RunDeadlineTimerPort {
  schedule(delayMs: number, callback: () => void | Promise<void>): RunDeadlineTimerHandle {
    const handle = setTimeout(callback, delayMs);
    if (
      typeof handle === "object" &&
      handle !== null &&
      "unref" in handle &&
      typeof handle.unref === "function"
    ) {
      handle.unref();
    }
    return { cancel: () => clearTimeout(handle) };
  }
}

interface Registration {
  readonly runId: RunId;
  readonly deadlineAt: TimestampMs;
  readonly callback: () => void | Promise<void>;
  readonly token: symbol;
  handle: RunDeadlineTimerHandle | undefined;
}

export interface RunDeadlineRegistryOptions {
  readonly clock: { now(): TimestampMs };
  readonly timer?: RunDeadlineTimerPort;
  readonly maxDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class RunDeadlineRegistry {
  private readonly timer: RunDeadlineTimerPort;
  private readonly maxDelayMs: number;
  private readonly registrations = new Map<RunId, Registration>();

  constructor(private readonly options: RunDeadlineRegistryOptions) {
    this.timer = options.timer ?? new SystemRunDeadlineTimer();
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_TIMER_DELAY_MS;
    if (!Number.isSafeInteger(this.maxDelayMs) || this.maxDelayMs <= 0) {
      throw new Error("Run deadline timer maximum must be a safe positive integer.");
    }
  }

  get size(): number {
    return this.registrations.size;
  }

  arm(runId: RunId, deadlineAt: TimestampMs, callback: () => void | Promise<void>): void {
    this.disarm(runId);
    const registration: Registration = {
      runId,
      deadlineAt,
      callback,
      token: Symbol(runId),
      handle: undefined,
    };
    this.registrations.set(runId, registration);
    this.schedule(registration);
  }

  disarm(runId: RunId): void {
    const registration = this.registrations.get(runId);
    if (registration === undefined) return;
    registration.handle?.cancel();
    this.registrations.delete(runId);
  }

  dispose(): void {
    for (const runId of this.registrations.keys()) this.disarm(runId);
  }

  private schedule(registration: Registration): void {
    const remaining = Math.max(0, registration.deadlineAt - this.options.clock.now());
    registration.handle = this.timer.schedule(Math.min(this.maxDelayMs, remaining), () =>
      this.wake(registration),
    );
  }

  private wake(registration: Registration): void {
    if (this.registrations.get(registration.runId)?.token !== registration.token) return;
    registration.handle = undefined;
    const remaining = registration.deadlineAt - this.options.clock.now();
    if (remaining > 0) {
      this.schedule(registration);
      return;
    }
    this.registrations.delete(registration.runId);
    void Promise.resolve()
      .then(() => registration.callback())
      .catch((error: unknown) => {
        try {
          this.options.onError?.(error);
        } catch {
          // A background timer must never create an unhandled rejection.
        }
      });
  }
}
