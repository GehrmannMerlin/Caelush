import { spawn } from "node:child_process";

/**
 * Terminate a managed process **and every process it started**.
 *
 * ## Why `child.kill()` is not enough
 *
 * `ChildProcess.kill()` signals exactly one process: the executable the Runtime spawned. On Windows that
 * executable is always a shell (`powershell.exe -Command "& { … }"`), and the moment a command is a
 * *wrapper* — `npm run watch`, `pnpm dev`, `cmd /c …` — the shell immediately spawns children of its own:
 *
 * ```text
 * powershell.exe   the process the Runtime holds and can signal
 *   └── cmd.exe         (npm.cmd)
 *         └── node.exe       (the npm CLI)
 *               └── node.exe     (the workload the model actually asked for)
 * ```
 *
 * Killing the shell leaves the workload running. The session's pipe stays held open by the survivor, so
 * the adapter never observes an exit; `terminateOwnedSession` can then only answer
 * `RuntimeProcessUncertainError` once its confirmation bound expires, and the machine is left with an
 * orphan that the model has no sanctioned way to end — the shell-level kill it would reach for is refused
 * by policy. That is the worst of both outcomes, and it is the *common* case, because the long-running
 * command a coding agent starts is nearly always a package-manager script.
 *
 * ## What this does instead
 *
 * ```text
 * win32   taskkill /PID <pid> /T /F     the platform's own "this process and its descendants"
 * other   a signal to the process group (-pid), when the child leads one
 * ```
 *
 * `taskkill /T` walks the operating system's recorded parent/child links downward from a pid the Runtime
 * minted itself, so it cannot reach a process this session did not create. Invoking the platform
 * primitive here is not the same act as the model running `taskkill`: the model would be naming a process
 * by image name, pattern or a guessed pid, whereas this names the one process it owns and takes what
 * belongs to it.
 *
 * ## The POSIX half is deliberately narrow
 *
 * `process.kill(-pid, …)` reaches a whole process group only when the child *leads* one, which it does not
 * unless it was spawned `detached`. Making that unconditional would change what happens to every session
 * when the daemon itself dies, which is a larger decision than this defect needs; here it is attempted,
 * and the caller falls back to a single-process signal when there is no group to reach.
 */

/** How long the platform primitive is given before the single-process fallback is used. */
const TREE_TERMINATION_TIMEOUT_MS = 5_000;

/** The slice of a child process this needs: an id, and a way to signal it. */
export interface TerminableProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  /** Test seam: run `taskkill /PID <pid> /T /F`, resolving whether it succeeded. */
  readonly runTaskkill?: (pid: number) => Promise<boolean>;
  /** Test seam: signal the process group led by `pid`, returning whether a group was reached. */
  readonly signalGroup?: (pid: number) => boolean;
}

/** How a termination was carried out, so callers and tests can tell the two apart. */
export type ProcessTreeOutcome = "TREE" | "SINGLE";

function signalProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

async function taskkillTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), TREE_TERMINATION_TIMEOUT_MS);
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => finish(false));
      killer.on("close", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

/**
 * End `target` and its descendants, falling back to a single-process signal when the platform offers no
 * way to reach the tree.
 */
export async function terminateProcessTree(
  target: TerminableProcess,
  options: ProcessTreeOptions = {},
): Promise<ProcessTreeOutcome> {
  const platform = options.platform ?? process.platform;
  const pid = target.pid;

  if (pid !== undefined) {
    if (platform === "win32") {
      const runTaskkill = options.runTaskkill ?? taskkillTree;
      if (await runTaskkill(pid)) return "TREE";
    } else {
      const signalGroup = options.signalGroup ?? signalProcessGroup;
      if (signalGroup(pid)) return "TREE";
    }
  }

  target.kill();
  return "SINGLE";
}
