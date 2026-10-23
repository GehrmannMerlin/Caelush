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
          windowsPowerShellScript(command),
        ],
      };
    }
    if (!this.executableExists("cmd.exe")) throw new RuntimeExecError("SHELL_UNAVAILABLE");
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
}

/**
 * The PowerShell program that runs one user command and reports what happened.
 *
 * ```text
 * $global:LASTEXITCODE = 0                start from zero, so nothing inherits a stale native code
 * & { <command>; $global:caelushOk = $? } the user's script, and the last statement's status
 * $caelushOk          -> exit 0           the last statement succeeded
 * otherwise, LEC != 0 -> exit LEC         a native process failed with that code
 * otherwise           -> exit 1           a cmdlet or a command lookup failed
 * ```
 *
 * ## Why the previous form was wrong
 *
 * `& { <command> }; exit $LASTEXITCODE` treats `$LASTEXITCODE` as "the result of the script". It is
 * not. PowerShell sets it only when a *native* process exits, so:
 *
 * ```text
 * Get-ChildItem missing-path          a failing cmdlet leaves $LASTEXITCODE at 0    -> exit 0
 * a command that does not exist       same: a lookup failure sets nothing           -> exit 0
 * native-fails; Write-Output ok       the successful cmdlet leaves the native 1      -> exit 1
 * ```
 *
 * The first two are the dangerous ones for an agent: a command that visibly failed was reported as a
 * success, so a model that trusts exit codes could build on a broken state.
 *
 * ## Why `$?` is read *inside* the block
 *
 * `$?` after an `& { ... }` invocation describes the invocation, not the last statement inside it, and
 * it is `$true` even when the block wrote an error. Measured on Windows PowerShell 5.1:
 *
 * ```text
 * & { <missing command> }; $?     -> True      (the block ran; the command inside did not)
 * & { <command>; $? }             -> False     (the last statement inside actually failed)
 * ```
 *
 * So the capture has to happen on the last statement itself, which is why the assignment is the final
 * element of the block rather than the next statement after it.
 *
 * ## What this does not do
 *
 * It does not turn non-terminating errors into terminating ones: `$ErrorActionPreference` is untouched,
 * so a script that continues after a failed cmdlet still can. It does not inspect stderr, which is a
 * diagnostic stream and not a verdict. It does not rewrite the user's command, so an explicit `exit 7`
 * inside it still ends the shell with 7. And it reports the *last statement's* status, exactly as
 * `sh -c` does, rather than inventing a stricter rule that would blame a script for a native command
 * it deliberately continued past.
 */
function windowsPowerShellScript(command: string): string {
  return (
    `$global:LASTEXITCODE = 0; $global:caelushOk = $true; ` +
    `& { ${command}; $global:caelushOk = $? }; ` +
    `if ($caelushOk) { exit 0 }; ` +
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1`
  );
}
