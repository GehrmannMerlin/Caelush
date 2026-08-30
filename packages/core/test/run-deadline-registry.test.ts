import { createRunId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { RunDeadlineRegistry } from "../src/run-deadline-registry.js";

class FakeTimer {
  now = 0;
  scheduled: Array<{ delay: number; callback: () => void | Promise<void>; cancelled: boolean }> =
    [];

  schedule(delay: number, callback: () => void | Promise<void>) {
    const task = { delay, callback, cancelled: false };
    this.scheduled.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  async advanceBy(milliseconds: number): Promise<void> {
    this.now += milliseconds;
    const pending = this.scheduled.filter((task) => !task.cancelled && task.delay <= milliseconds);
    for (const task of pending) {
      task.cancelled = true;
      await task.callback();
    }
  }
}

describe("RunDeadlineRegistry", () => {
  it("deduplicates, re-arms, disarms, and disposes registrations", () => {
    const timer = new FakeTimer();
    const registry = new RunDeadlineRegistry({
      clock: { now: () => createTimestampMs(timer.now) },
      timer,
    });
    const runId = createRunId();
    const callback = () => undefined;

    registry.arm(runId, createTimestampMs(100), callback);
    registry.arm(runId, createTimestampMs(200), callback);
    expect(timer.scheduled.filter((task) => !task.cancelled)).toHaveLength(1);
    registry.disarm(runId);
    expect(timer.scheduled.filter((task) => !task.cancelled)).toHaveLength(0);
    registry.arm(runId, createTimestampMs(200), callback);
    registry.dispose();
    expect(timer.scheduled.filter((task) => !task.cancelled)).toHaveLength(0);
  });

  it("rechecks the clock after an early wake and chunks long delays", async () => {
    const timer = new FakeTimer();
    const fired: string[] = [];
    const registry = new RunDeadlineRegistry({
      clock: { now: () => createTimestampMs(timer.now) },
      timer,
      maxDelayMs: 10,
    });
    const runId = createRunId();

    registry.arm(runId, createTimestampMs(25), () => {
      fired.push("deadline");
    });
    expect(timer.scheduled.at(-1)?.delay).toBe(10);
    await timer.advanceBy(10);
    expect(fired).toEqual([]);
    expect(timer.scheduled.at(-1)?.delay).toBe(10);
    await timer.advanceBy(10);
    await timer.advanceBy(5);
    expect(fired).toEqual(["deadline"]);
  });

  it("contains asynchronous callback failures", async () => {
    const timer = new FakeTimer();
    const errors: unknown[] = [];
    const registry = new RunDeadlineRegistry({
      clock: { now: () => createTimestampMs(timer.now) },
      timer,
      onError: (error) => errors.push(error),
    });
    registry.arm(createRunId(), createTimestampMs(1), async () => {
      throw new Error("finalizer failed");
    });

    await timer.advanceBy(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});
