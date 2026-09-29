import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPipeProcessAdapter } from "../src/index.js";

function waitForExit(
  adapter: ReturnType<typeof createPipeProcessAdapter> extends Promise<infer T> ? T : never,
) {
  return new Promise<{ exitCode?: number; signal?: string }>((resolve) => {
    adapter.onExit(resolve);
  });
}

async function lineCount(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  /**
   * The child the Runtime holds is normally a *shell*, and the work the model asked for happens in that
   * shell's descendants — `npm run …`, `pnpm dev`, `cmd /c …` all spawn a wrapper process. Ending the
   * session has to end them too: a survivor keeps the session's pipe open, so the adapter can never
   * observe an exit, the termination can only be reported as uncertain, and an orphan keeps running.
   *
   * Windows only, because that is the platform whose tree primitive this exercises; off win32 the
   * implementation deliberately does not change process-group semantics to reach the tree.
   */
  it.skipIf(process.platform !== "win32")(
    "ends a wrapper's descendants, not only the shell it spawned",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "caelush-tree-"));
      const marker = path.join(dir, "ticks.log");
      await writeFile(
        path.join(dir, "grandchild.cjs"),
        [
          'const fs = require("node:fs");',
          "let tick = 0;",
          "setInterval(() => {",
          "  tick += 1;",
          '  fs.appendFileSync(process.env.CAELUSH_TREE_TEST_MARKER, `tick ${tick}\\n`);',
          "}, 100);",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(dir, "wrapper.cjs"),
        [
          'const { spawn } = require("node:child_process");',
          'const path = require("node:path");',
          'spawn(process.execPath, [path.join(__dirname, "grandchild.cjs")], { stdio: "ignore", env: process.env });',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const adapter = await createPipeProcessAdapter({
        launch: { executable: process.execPath, args: [path.join(dir, "wrapper.cjs")] },
        cwd: dir,
        env: { ...process.env, CAELUSH_TREE_TEST_MARKER: marker },
      });

      try {
        const deadline = Date.now() + 10_000;
        while ((await lineCount(marker)) < 2 && Date.now() < deadline) await sleep(50);
        expect(await lineCount(marker)).toBeGreaterThanOrEqual(2);

        const exited = waitForExit(adapter);
        await adapter.close();
        await exited;

        // A grandchild that outlived its shell would add roughly seven lines in this window.
        await sleep(500);
        const settled = await lineCount(marker);
        await sleep(700);
        expect(await lineCount(marker)).toBe(settled);
      } finally {
        await adapter.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
