import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree, type TerminableProcess } from "../src/index.js";

class FakeProcess implements TerminableProcess {
  killed = false;
  constructor(readonly pid: number | undefined) {}
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("terminateProcessTree", () => {
  it("uses the platform tree primitive on win32 and does not signal the shell alone", async () => {
    const target = new FakeProcess(4242);
    const runTaskkill = vi.fn(async () => true);

    await expect(terminateProcessTree(target, { platform: "win32", runTaskkill })).resolves.toBe("TREE");

    expect(runTaskkill).toHaveBeenCalledWith(4242);
    expect(target.killed).toBe(false);
  });

  it("falls back to a single-process signal when the tree primitive reports failure", async () => {
    const target = new FakeProcess(4242);
    const runTaskkill = vi.fn(async () => false);

    await expect(terminateProcessTree(target, { platform: "win32", runTaskkill })).resolves.toBe("SINGLE");

    expect(target.killed).toBe(true);
  });

  it("signals the process group off win32 when one was reached", async () => {
    const target = new FakeProcess(4242);
    const signalGroup = vi.fn(() => true);
    const runTaskkill = vi.fn(async () => true);

    await expect(
      terminateProcessTree(target, { platform: "linux", signalGroup, runTaskkill }),
    ).resolves.toBe("TREE");

    expect(signalGroup).toHaveBeenCalledWith(4242);
    expect(runTaskkill).not.toHaveBeenCalled();
    expect(target.killed).toBe(false);
  });

  it("falls back to a single-process signal when there is no process group to reach", async () => {
    const target = new FakeProcess(4242);

    await expect(
      terminateProcessTree(target, { platform: "darwin", signalGroup: () => false }),
    ).resolves.toBe("SINGLE");

    expect(target.killed).toBe(true);
  });

  it("never asks the platform for a tree it cannot name", async () => {
    const target = new FakeProcess(undefined);
    const runTaskkill = vi.fn(async () => true);
    const signalGroup = vi.fn(() => true);

    await expect(terminateProcessTree(target, { platform: "win32", runTaskkill })).resolves.toBe("SINGLE");
    await expect(terminateProcessTree(target, { platform: "linux", signalGroup })).resolves.toBe("SINGLE");

    expect(runTaskkill).not.toHaveBeenCalled();
    expect(signalGroup).not.toHaveBeenCalled();
    expect(target.killed).toBe(true);
  });
});
