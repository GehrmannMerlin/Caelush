import { createRunId, createTimestampMs } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { RunRetryRegistry } from "../src/run-retry-registry.js";

class FakeTimer {
  readonly scheduled: Array<{
    delay: number;
    callback: () => void | Promise<void>;
    cancelled: boolean;
  }> = [];

  schedule(delay: number, callback: () => void | Promise<void>) {
    const task = { delay, callback, cancelled: false };
    this.scheduled.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  async fire(index: number): Promise<void> {
    const task = this.scheduled[index];
    if (task === undefined) throw new Error(`missing task ${index}`);
    task.cancelled = true;
    await task.callback();
  }
}

describe("RunRetryRegistry", () => {
  it("keeps one registration per Run and ignores stale callbacks", async () => {
    const timer = new FakeTimer();
    let now = 1_000;
    const registry = new RunRetryRegistry({
      clock: { now: () => createTimestampMs(now) },
      timer,
    });
    const runId = createRunId();
    const fired: string[] = [];
    registry.arm(runId, createTimestampMs(5_000), () => fired.push("old"));
    registry.arm(runId, createTimestampMs(8_000), () => fired.push("new"));
    expect(registry.size).toBe(1);
    await timer.fire(0);
    expect(fired).toEqual([]);
    now = 8_000;
    await timer.fire(1);
    expect(fired).toEqual(["new"]);
    expect(registry.size).toBe(0);
  });

  it("rechecks early wakes, chunks delay, disposes, and contains callback errors", async () => {
    const timer = new FakeTimer();
    let now = 0;
    const errors: unknown[] = [];
    const registry = new RunRetryRegistry({
      clock: { now: () => createTimestampMs(now) },
      timer,
      maxDelayMs: 10,
      onError: (error) => errors.push(error),
    });
    const runId = createRunId();
    registry.arm(runId, createTimestampMs(25), async () => {
      throw new Error("retry wake failed");
    });
    expect(timer.scheduled[0]?.delay).toBe(10);
    await timer.fire(0);
    expect(timer.scheduled[1]?.delay).toBe(10);
    now = 25;
    await timer.fire(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    registry.arm(runId, createTimestampMs(100), () => undefined);
    registry.dispose();
    expect(registry.size).toBe(0);
    expect(timer.scheduled.filter((task) => !task.cancelled)).toHaveLength(0);
  });
});
