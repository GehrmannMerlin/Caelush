import { describe, expect, it } from "vitest";
import { LocalShellResolver } from "../src/index.js";

describe("LocalShellResolver", () => {
  it("resolves POSIX shell as an executable and command argument", () => {
    const resolver = new LocalShellResolver({
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      executableExists: (value) => value === "/bin/bash",
    });

    expect(resolver.resolve("printf 'a b'" as string)).toEqual({
      executable: "/bin/bash",
      args: ["-c", "printf 'a b'"],
    });
  });

  it("uses PowerShell on Windows and falls back to cmd", () => {
    const powershell = new LocalShellResolver({
      platform: "win32",
      env: {},
      executableExists: (value) => value === "powershell.exe",
    });
    const launch = powershell.resolve("Write-Output ready");
    expect(launch.executable).toBe("powershell.exe");
    expect(launch.args.slice(0, 5)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      launch.args[4]!,
    ]);
    const script = launch.args[4]!;
    // The command is carried unchanged, and the exit status is derived from the command rather than
    // from an inherited native exit code.
    expect(script).toContain("& { Write-Output ready;");
    expect(script).toContain("$global:LASTEXITCODE = 0");
    expect(script).toContain("$LASTEXITCODE -ne 0");
    // `$?` must be captured *inside* the block: after `& { ... }` it describes the invocation, which
    // is `$true` even when the command inside failed.
    expect(script).toContain("{ Write-Output ready; $global:caelushOk = $? }");
    expect(script).not.toContain("}; exit $LASTEXITCODE");

    const cmd = new LocalShellResolver({
      platform: "win32",
      env: {},
      executableExists: (value) => value === "cmd.exe",
    });
    expect(cmd.resolve("echo ready")).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", "echo ready"],
    });
  });

  it("keeps workdir out of the command launch description", () => {
    const launch = new LocalShellResolver({
      platform: "linux",
      env: {},
      executableExists: (value) => value === "/bin/sh",
    }).resolve("pwd");
    expect(launch.args).toEqual(["-c", "pwd"]);
    expect(launch.args.join(" ")).not.toContain("cd ");
  });
});
