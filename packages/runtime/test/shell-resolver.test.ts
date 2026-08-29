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
    expect(powershell.resolve("Write-Output ready")).toEqual({
      executable: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& { Write-Output ready }; exit $LASTEXITCODE",
      ],
    });

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
