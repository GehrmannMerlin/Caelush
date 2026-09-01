import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DaemonBootstrapError,
  ensureDaemon,
  type DaemonDiscoveryResult,
  type EnsureDaemonOptions,
} from "./daemon-discovery.js";
import { EXIT_CODES, type ProductExitCode } from "./exit-codes.js";

export interface WebHostOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workspacePath?: string;
  readonly webBuildRoot?: string;
  readonly ensureDaemon?: (options: EnsureDaemonOptions) => Promise<DaemonDiscoveryResult>;
  readonly openUrl?: (url: string) => void;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

export async function runWebHost(options: WebHostOptions = {}): Promise<ProductExitCode> {
  const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  const baseEnvironment = options.environment ?? process.env;
  const workspacePath = options.workspacePath ?? process.cwd();
  const webBuildRoot = options.webBuildRoot ?? resolveWebBuildRoot(baseEnvironment) ?? "";

  if (!hasWebBuild(webBuildRoot)) {
    writeStderr("Caelush Web assets are unavailable. Run the Web build first.\n");
    return EXIT_CODES.BOOTSTRAP_FAILURE;
  }

  const environment = {
    ...baseEnvironment,
    CAELUSH_WORKSPACE_PATH: workspacePath,
    CAELUSH_WEB_BUILD_ROOT: webBuildRoot,
  };
  try {
    const daemon = await (options.ensureDaemon ?? ensureDaemon)({ environment });
    writeStdout(`${daemon.url}/\n`);
    (options.openUrl ?? openUrlInBrowser)(`${daemon.url}/`);
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    const message =
      error instanceof DaemonBootstrapError
        ? error.message
        : "Caelush Local Agent Service could not start. Run `caelush doctor` for diagnostics.";
    writeStderr(`${message}\n`);
    return EXIT_CODES.BOOTSTRAP_FAILURE;
  }
}

function openUrlInBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, shell: false, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is already printed, so a missing desktop opener remains recoverable.
  }
}

export function resolveWebBuildRoot(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = environment.CAELUSH_WEB_BUILD_ROOT?.trim();
  if (configured !== undefined && configured.length > 0) return configured;

  const launcherDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(launcherDirectory, "../../web/dist"),
    resolve(launcherDirectory, "../web"),
  ];
  return candidates.find(hasWebBuild) ?? candidates[0];
}

function hasWebBuild(buildRoot: string): boolean {
  return buildRoot.length > 0 && existsSync(join(buildRoot, "index.html"));
}
