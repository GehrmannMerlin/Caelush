import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ShellLaunch } from "./contracts.js";
import { RuntimeExecError } from "./errors.js";

export interface LocalShellResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly executableExists?: (executable: string) => boolean;
}

export class LocalShellResolver {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly executableExists: (executable: string) => boolean;

  constructor(options: LocalShellResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.executableExists =
      options.executableExists ??
      ((executable) => (path.isAbsolute(executable) ? fs.existsSync(executable) : true));
  }

  resolve(command: string): ShellLaunch {
    if (this.platform === "win32") return this.resolveWindows(command);
    const configured = this.env.SHELL;
    const executable = configured && this.executableExists(configured) ? configured : "/bin/sh";
    if (!this.executableExists(executable)) throw new RuntimeExecError("SHELL_UNAVAILABLE");
    return { executable, args: ["-c", command] };
  }

  private resolveWindows(command: string): ShellLaunch {
    const powershellCandidates = ["powershell.exe", "pwsh.exe"];
    const powershell = powershellCandidates.find((candidate) => this.executableExists(candidate));
    if (powershell !== undefined) {
      return {
        executable: powershell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& { ${command} }; exit $LASTEXITCODE`,
        ],
      };
    }
    if (!this.executableExists("cmd.exe")) throw new RuntimeExecError("SHELL_UNAVAILABLE");
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
}
