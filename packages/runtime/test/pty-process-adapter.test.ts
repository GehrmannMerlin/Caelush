import { describe, expect, it } from "vitest";
import { createPtyProcessAdapter } from "../src/index.js";

describe("PtyProcessAdapter", () => {
  it("captures a real PTY stream and accepts interactive input", async () => {
    const adapter = await createPtyProcessAdapter({
      launch: {
        executable: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data', s => { process.stdout.write('pong\\r\\n'); process.exit(0) })",
        ],
      },
      cwd: process.cwd(),
      env: process.env,
    });
    const output: string[] = [];
    adapter.onOutput((event) => output.push(event.text));
    await adapter.write("ping\r");
    const exit = await new Promise<{ exitCode?: number }>((resolve) => adapter.onExit(resolve));
    expect(output.join("")).toContain("pong");
    expect(exit.exitCode).toBe(0);
    await adapter.close();
  }, 15_000);
});
