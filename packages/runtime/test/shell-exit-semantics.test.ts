import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { LocalShellResolver } from "../src/index.js";

/**
 * The exit status of a real Windows command, measured by really running one.
 *
 * ```text
 * a native process's exit code             must survive as the shell's exit code
 * a failing cmdlet                         must not be reported as 0
 * a failing native followed by a cmdlet    must not be reported as 0 either
 * an explicit exit N                       must survive as N
 * non-ASCII output                         must decode as UTF-8
 * ```
 *
 * These are the cases the previous wrapper got wrong. `exit $LASTEXITCODE` inherits a value only a
 * native process sets, so a pure cmdlet failure exited 0 and a cmdlet success after a native failure
 * exited 1 — and an agent that trusts exit codes would treat a visibly broken command as a green one.
 *
 * The suite runs only on Windows, because the behaviour under test is PowerShell's. It is not skipped
 * on Windows: a wrapper change without a real execution regression is exactly what the previous
 * attempt at this fix was missing.
 */
const isWindows = process.platform === "win32";

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string, workdir?: string): Promise<RunResult> {
  const launch = new LocalShellResolver({ platform: "win32" }).resolve(command);
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: workdir ?? process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!isWindows)("Windows shell exit semantics (real execution)", () => {
  it("keeps a successful native process at exit 0", async () => {
    const result = await run("cmd /c exit 0");
    expect(result.code).toBe(0);
  });

  it("keeps a failing native process's exit code", async () => {
    expect((await run("cmd /c exit 1")).code).toBe(1);
    expect((await run("cmd /c exit 2")).code).toBe(2);
  });

  it("does not report a failing cmdlet as success", async () => {
    // The case that mattered: `Get-ChildItem` on a missing path writes an error but never sets
    // `$LASTEXITCODE`, so the old wrapper exited 0 for a command that plainly failed.
    const result = await run(
      "Get-ChildItem 'C:\\caelush-no-such-directory-5f3a1c' -ErrorAction SilentlyContinue",
    );
    expect(result.code).not.toBe(0);
  });

  it("does not report a successful cmdlet as failure after an earlier native failure", async () => {
    // The mirror case: the native exit code stays set, so the old wrapper blamed the cmdlet for it.
    const result = await run("cmd /c exit 3; Write-Output 'recovered'");
    expect(result.stdout).toContain("recovered");
    expect(result.code).toBe(0);
  });

  it("keeps a successful cmdlet at exit 0", async () => {
    const result = await run("Write-Output ready");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ready");
  });

  it("keeps an explicit exit code from inside the command", async () => {
    expect((await run("Write-Output before; exit 7")).code).toBe(7);
  });

  it("does not turn a non-terminating error into a terminating one", async () => {
    // The command continues after a failed cmdlet and its later output is still produced; only the
    // final status reflects the failure. Changing `$ErrorActionPreference` would have changed what
    // the user's script means.
    const result = await run(
      "Get-ChildItem 'C:\\caelush-no-such-directory-5f3a1c' -ErrorAction SilentlyContinue; Write-Output 'continued'",
    );
    expect(result.stdout).toContain("continued");
  });

  it("carries non-ASCII output through as UTF-8", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caelush-shell-utf8-"));
    try {
      const script = path.join(directory, "emit.cmd");
      fs.writeFileSync(script, ["@echo off", "echo 中文输出 ok", "exit /b 0"].join("\r\n"), "utf8");
      const result = await run(`cmd /c "${script}"`, directory);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("中文输出 ok");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
