import { describe, expect, it } from "vitest";
import { LocalProcessManager } from "../src/index.js";

const launch = (script: string) => ({ executable: process.execPath, args: ["-e", script] });
const base = (command: string, ownerRunId = "run_a" as never) => ({
  ownerRunId,
  command,
  cwd: process.cwd(),
  env: process.env,
  tty: false,
  yieldTimeMs: 250,
  launch: launch(command),
});

describe("LocalProcessManager", () => {
  it("returns a quick command exit and does not retain a reusable session", async () => {
    const manager = new LocalProcessManager({ generationId: "generation-a" });
    const result = await manager.start(base("process.stdout.write('ready')"));
    expect(result).toMatchObject({ status: "EXITED", output: "ready" });
    expect(result.sessionId).toBeUndefined();
    expect(manager.size).toBe(0);
    await manager.dispose();
  });

  it("keeps a running session and drains output exactly once across interactions", async () => {
    const manager = new LocalProcessManager({
      generationId: "generation-b",
      sessionIdFactory: (generation, sequence) => `proc_${generation}_${sequence}`,
    });
    const result = await manager.start(
      base(
        "process.stdout.write('READY'); process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { process.stdout.write(s === 'ping\\n' ? 'pong' : ''); if (s.includes('exit')) process.exit(0) })",
      ),
    );
    expect(result.status).toBe("RUNNING");
    expect(result.sessionId).toBe("proc_generation-b_1");
    expect(result.output).toContain("READY");
    const poll = await manager.interact({
      ownerRunId: "run_a" as never,
      sessionId: result.sessionId!,
      chars: "",
      yieldTimeMs: 250,
    });
    expect(poll.output).toBe("");
    const pong = await manager.interact({
      ownerRunId: "run_a" as never,
      sessionId: result.sessionId!,
      chars: "ping\n",
      yieldTimeMs: 250,
    });
    expect(pong.output).toBe("pong");
    const exited = await manager.interact({
      ownerRunId: "run_a" as never,
      sessionId: result.sessionId!,
      chars: "exit\n",
      yieldTimeMs: 250,
    });
    expect(exited).toMatchObject({ status: "EXITED", exitCode: 0 });
    expect(manager.size).toBe(0);
    await manager.dispose();
  }, 15_000);

  it("fails closed for another Run and detects stale generations", async () => {
    const manager = new LocalProcessManager({ generationId: "generation-c" });
    const result = await manager.start(base("setTimeout(() => {}, 10000)"));
    await expect(
      manager.interact({
        ownerRunId: "run_b" as never,
        sessionId: result.sessionId!,
        chars: "x",
        yieldTimeMs: 250,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_SESSION_NOT_FOUND" });
    await manager.dispose();
    const next = new LocalProcessManager({ generationId: "generation-d" });
    await expect(
      next.interact({
        ownerRunId: "run_a" as never,
        sessionId: result.sessionId!,
        chars: "",
        yieldTimeMs: 250,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_SESSION_STALE" });
    await next.dispose();
  });

  it("enforces the active managed-process cap", async () => {
    const manager = new LocalProcessManager({ generationId: "generation-cap", maxProcesses: 1 });
    const running = await manager.start(base("setTimeout(() => {}, 10000)"));

    await expect(manager.start(base("setTimeout(() => {}, 10000)"))).rejects.toMatchObject({
      code: "PROCESS_LIMIT_REACHED",
    });
    expect(running.status).toBe("RUNNING");
    await manager.dispose();
  });

  it("retains a background exit until the final poll", async () => {
    const manager = new LocalProcessManager({ generationId: "generation-background" });
    const started = await manager.start(
      base("setTimeout(() => { process.stdout.write('later'); process.exit(3) }, 500)"),
    );
    expect(started.status).toBe("RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 700));

    const final = await manager.interact({
      ownerRunId: "run_a" as never,
      sessionId: started.sessionId!,
      chars: "",
      yieldTimeMs: 250,
    });
    expect(final).toMatchObject({ status: "EXITED", exitCode: 3, output: "later" });
    expect(manager.size).toBe(0);
    await expect(
      manager.interact({
        ownerRunId: "run_a" as never,
        sessionId: started.sessionId!,
        chars: "",
        yieldTimeMs: 250,
      }),
    ).rejects.toMatchObject({ code: "PROCESS_SESSION_NOT_FOUND" });
    await manager.dispose();
  }, 15_000);

  it("reports an executable failure before process start as a recoverable error", async () => {
    const manager = new LocalProcessManager({ generationId: "generation-spawn" });
    await expect(
      manager.start({
        ...base("ignored"),
        launch: { executable: "caelush-command-that-does-not-exist", args: [] },
      }),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(manager.size).toBe(0);
    await manager.dispose();
  });

  it("kills and removes every process owned by a cancelled Run", async () => {
    const manager = new LocalProcessManager({ generationId: "generation-cancel" });
    const controller = new AbortController();
    const started = await manager.start({
      ...base("setTimeout(() => {}, 10000)"),
      signal: controller.signal,
    });
    expect(started.status).toBe("RUNNING");

    controller.abort();
    const result = await manager.interact({
      ownerRunId: "run_a" as never,
      sessionId: started.sessionId!,
      chars: "",
      yieldTimeMs: 250,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "EXITED", signal: "KILLED" });
    expect(manager.size).toBe(0);
    await manager.dispose();
  });
});
