import { describe, expect, it } from "vitest";
import { createPipeProcessAdapter } from "../src/index.js";

function waitForExit(
  adapter: ReturnType<typeof createPipeProcessAdapter> extends Promise<infer T> ? T : never,
) {
  return new Promise<{ exitCode?: number; signal?: string }>((resolve) => {
    adapter.onExit(resolve);
  });
}

describe("PipeProcessAdapter", () => {
  it("captures stdout and stderr and reports a non-zero exit", async () => {
    const adapter = await createPipeProcessAdapter({
      launch: {
        executable: process.execPath,
        args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
      },
      cwd: process.cwd(),
      env: process.env,
    });
    const output: Array<{ stream: string; text: string }> = [];
    adapter.onOutput((event) => output.push(event));
    const exit = await waitForExit(adapter);
    expect(output).toEqual([
      { stream: "stdout", text: "out" },
      { stream: "stderr", text: "err" },
    ]);
    expect(exit).toEqual({ exitCode: 7 });
    await adapter.close();
  });

  it("writes to a running process without enabling shell interpretation", async () => {
    const adapter = await createPipeProcessAdapter({
      launch: {
        executable: process.execPath,
        args: [
          "-e",
          "process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { process.stdout.write(s); if (s.includes('exit\\n')) process.exit(0) })",
        ],
      },
      cwd: process.cwd(),
      env: process.env,
    });
    const output: string[] = [];
    adapter.onOutput((event) => output.push(event.text));
    await adapter.write("ping\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await adapter.write("exit\n");
    await waitForExit(adapter);
    expect(output.join("")).toBe("ping\nexit\n");
    await adapter.close();
  });
});
