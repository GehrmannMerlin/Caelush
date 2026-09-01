import { describe, expect, it } from "vitest";
import {
  CLI_RECONNECT_DELAYS_MS,
  CliReconnectScheduler,
  type CliTimer,
  type CliTimerHandle,
} from "../src/application/reconnect-scheduler.js";

describe("CLI reconnect scheduler", () => {
  it("uses the fixed delay sequence and exhausts after six failed attempts", () => {
    const timer = new FakeTimer();
    const attempts: number[] = [];
    const scheduler = new CliReconnectScheduler({
      timer,
      onAttempt: (attempt) => attempts.push(attempt),
      onExhausted: () => attempts.push(99),
    });

    scheduler.start();
    for (let index = 0; index < CLI_RECONNECT_DELAYS_MS.length; index += 1) {
      timer.runNext();
      scheduler.failed();
    }

    expect(timer.delays).toEqual([...CLI_RECONNECT_DELAYS_MS]);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 99]);
    expect(timer.pendingCount).toBe(0);
  });

  it("cancels timers on success, manual retry, and dispose", () => {
    const timer = new FakeTimer();
    const attempts: number[] = [];
    const scheduler = new CliReconnectScheduler({
      timer,
      onAttempt: (attempt) => attempts.push(attempt),
      onExhausted: () => undefined,
    });

    scheduler.start();
    expect(timer.pendingCount).toBe(1);
    scheduler.succeeded();
    expect(timer.pendingCount).toBe(0);
    timer.runAll();
    expect(attempts).toEqual([]);

    scheduler.manualRetry();
    expect(timer.pendingCount).toBe(1);
    scheduler.manualRetry();
    expect(timer.pendingCount).toBe(1);
    timer.runNext();
    expect(attempts).toEqual([1]);
    scheduler.failed();
    expect(timer.pendingCount).toBe(1);
    scheduler.dispose();
    expect(timer.pendingCount).toBe(0);
    timer.runAll();
    expect(attempts).toEqual([1]);
  });
});

class FakeTimer implements CliTimer {
  readonly delays: number[] = [];
  private callbacks: Array<{
    readonly delay: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  get pendingCount(): number {
    return this.callbacks.filter((item) => !item.cancelled).length;
  }

  schedule(delayMs: number, callback: () => void): CliTimerHandle {
    const item = { delay: delayMs, callback, cancelled: false };
    this.delays.push(delayMs);
    this.callbacks.push(item);
    return {
      cancel: () => {
        item.cancelled = true;
      },
    };
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
