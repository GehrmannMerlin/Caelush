import { describe, expect, it, vi } from "vitest";
import { collectPtyResult } from "./artifact-pty-session.mjs";

describe("packaged PTY output collection", () => {
  it("collects output that arrives after the initial yield while the session is running", async () => {
    const exec = {
      execute: vi.fn().mockResolvedValue({
        status: "RUNNING",
        sessionId: "proc_artifact",
        output: "",
      }),
      interact: vi.fn().mockResolvedValue({
        status: "EXITED",
        exitCode: 0,
        output: "artifact-pty\r\n",
      }),
    };

    await expect(
      collectPtyResult(exec, {
        ownerRunId: "run_artifact",
        command: "echo artifact-pty",
        tty: true,
        yieldTimeMs: 2000,
      }),
    ).resolves.toMatchObject({ status: "EXITED", exitCode: 0, output: "artifact-pty\r\n" });
    expect(exec.interact).toHaveBeenCalledWith({
      ownerRunId: "run_artifact",
      sessionId: "proc_artifact",
      chars: "",
      yieldTimeMs: 5000,
    });
  });

  it("combines output across multiple polls until the process exits", async () => {
    const exec = {
      execute: vi.fn().mockResolvedValue({
        status: "RUNNING",
        sessionId: "proc_artifact",
        output: "artifact-",
      }),
      interact: vi
        .fn()
        .mockResolvedValueOnce({ status: "RUNNING", sessionId: "proc_artifact", output: "pty" })
        .mockResolvedValueOnce({ status: "EXITED", exitCode: 0, output: "\r\n" }),
    };

    const result = await collectPtyResult(exec, {
      ownerRunId: "run_artifact",
      command: "echo artifact-pty",
      tty: true,
      yieldTimeMs: 2000,
    });

    expect(result).toMatchObject({ status: "EXITED", exitCode: 0, output: "artifact-pty\r\n" });
    expect(exec.interact).toHaveBeenCalledTimes(2);
  });

  it("bounds polling if the PTY never reaches a terminal state", async () => {
    const exec = {
      execute: vi.fn().mockResolvedValue({
        status: "RUNNING",
        sessionId: "proc_artifact",
        output: "",
      }),
      interact: vi.fn().mockResolvedValue({
        status: "RUNNING",
        sessionId: "proc_artifact",
        output: "",
      }),
    };

    const result = await collectPtyResult(exec, {
      ownerRunId: "run_artifact",
      command: "echo artifact-pty",
      tty: true,
      yieldTimeMs: 2000,
    });

    expect(result.status).toBe("RUNNING");
    expect(exec.interact).toHaveBeenCalledTimes(4);
  });
});
