import { describe, expect, it } from "vitest";
import { analyzeCommand } from "../src/index.js";

/**
 * Host-process termination must not be an ordinary command.
 *
 * `exec_command` cannot prove that an OS pid, image name or wildcard resolves to a process
 * the *current Run* owns. The Runtime already has that authority in the form of
 * `sessionId` + `ownerRunId`, so the only safe shell-level answer is a `SYSTEM_DESTRUCTIVE`
 * classification, which the input policy turns into an unconditional DENY.
 */

function classify(command: string, platform: "POSIX_SH" | "POWERSHELL" | "CMD" = "POSIX_SH") {
  return analyzeCommand({ command, platform, workdir: ".", tty: false }).classifications;
}

describe("host-process termination is system destructive", () => {
  it.each([
    ["taskkill /F /IM node.exe", "CMD"],
    ["taskkill /PID 1234 /F", "CMD"],
    ["taskkill.exe /F /IM node.exe", "CMD"],
    ["Stop-Process -Name node -Force", "POWERSHELL"],
    ["Stop-Process -Id 1234", "POWERSHELL"],
    ["stop-process -name node", "POWERSHELL"],
    ["pkill -f node", "POSIX_SH"],
    ["pkill node", "POSIX_SH"],
    ["killall node", "POSIX_SH"],
    ["kill -9 1234", "POSIX_SH"],
    ["kill 1234", "POSIX_SH"],
  ] as const)("classifies %s as SYSTEM_DESTRUCTIVE on %s", (command, platform) => {
    expect(classify(command, platform)).toContain("SYSTEM_DESTRUCTIVE");
  });

  it("keeps the SYSTEM_DESTRUCTIVE classification through a shell wrapper", () => {
    expect(classify('powershell -Command "Stop-Process -Name node -Force"')).toContain(
      "SYSTEM_DESTRUCTIVE",
    );
    expect(classify('pwsh -Command "taskkill /F /IM node.exe"')).toContain("SYSTEM_DESTRUCTIVE");
    expect(classify('bash -lc "pkill -f node"')).toContain("SYSTEM_DESTRUCTIVE");
    expect(classify('cmd /c "taskkill /F /IM node.exe"')).toContain("SYSTEM_DESTRUCTIVE");
  });

  it("keeps the SYSTEM_DESTRUCTIVE classification through concatenated segments", () => {
    expect(classify("cd app && taskkill /F /IM node.exe", "CMD")).toContain("SYSTEM_DESTRUCTIVE");
    expect(classify("echo start; pkill -f node")).toContain("SYSTEM_DESTRUCTIVE");
  });

  it("does not classify ordinary development commands as system destructive", () => {
    for (const command of [
      "npm test",
      "npm run build",
      "pnpm build",
      "pnpm install",
      "node server.js",
      "node --version",
      "java -jar app.jar",
      "python -m pytest",
      "python3 main.py",
      "git status",
      "git diff",
      "ls -la",
      "curl https://example.com",
    ]) {
      expect(classify(command), command).not.toContain("SYSTEM_DESTRUCTIVE");
    }
  });

  it("does not classify a workspace-local script whose name merely ends in kill", () => {
    // A path-qualified invocation is a workspace file, not the host's process-termination binary.
    expect(classify("./scripts/kill.js")).not.toContain("SYSTEM_DESTRUCTIVE");
    expect(classify("node ./tools/killall.js")).not.toContain("SYSTEM_DESTRUCTIVE");
    expect(classify("npm run killall")).not.toContain("SYSTEM_DESTRUCTIVE");
  });

  it("does not treat unrelated process-inspection commands as termination", () => {
    expect(classify("Get-Process node", "POWERSHELL")).not.toContain("SYSTEM_DESTRUCTIVE");
    expect(classify("tasklist", "CMD")).not.toContain("SYSTEM_DESTRUCTIVE");
    expect(classify("ps aux")).not.toContain("SYSTEM_DESTRUCTIVE");
    expect(classify("pgrep -f node")).not.toContain("SYSTEM_DESTRUCTIVE");
  });
});
