import { pathToFileURL } from "node:url";
import { CaelushClient } from "@caelush/client";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { EXIT_CODES, type ProductExitCode } from "./exit-codes.js";
import { DaemonBootstrapError, ensureDaemon } from "./daemon-discovery.js";
import { HELP_TEXT } from "./help.js";
import { nodeVersionInRange } from "./platform.js";
import { hasInteractiveTerminal, INTERACTIVE_TTY_ERROR } from "./tty.js";
import { PRODUCT_VERSION } from "./version.js";

export interface LauncherIo {
  readonly argv?: readonly string[];
  readonly nodeVersion?: string;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workspacePath?: string;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
}

export function runStaticCommand(argv: readonly string[]): ProductExitCode | undefined {
  if (argv.length !== 1) return undefined;
  if (argv[0] === "--help" || argv[0] === "-h") return EXIT_CODES.SUCCESS;
  if (argv[0] === "--version" || argv[0] === "-V") return EXIT_CODES.SUCCESS;
  return undefined;
}

export async function main(options: LauncherIo = {}): Promise<ProductExitCode> {
  const argv = options.argv ?? process.argv.slice(2);
  const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  const staticCommand = runStaticCommand(argv);
  if (staticCommand === EXIT_CODES.SUCCESS && (argv[0] === "--help" || argv[0] === "-h")) {
    writeStdout(HELP_TEXT);
    return EXIT_CODES.SUCCESS;
  }
  if (staticCommand === EXIT_CODES.SUCCESS && (argv[0] === "--version" || argv[0] === "-V")) {
    writeStdout(`caelush ${PRODUCT_VERSION}\n`);
    return EXIT_CODES.SUCCESS;
  }
  if (argv[0] === "doctor") {
    if (argv.length !== 1) {
      writeStderr("Invalid Caelush command-line arguments.\n");
      return EXIT_CODES.USAGE;
    }
    const result = await runDoctor({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.stdinIsTTY === undefined ? {} : { stdinIsTTY: options.stdinIsTTY }),
      ...(options.stdoutIsTTY === undefined ? {} : { stdoutIsTTY: options.stdoutIsTTY }),
      workspacePath: options.workspacePath ?? process.cwd(),
    });
    writeStdout(formatDoctorReport(result));
    return result.exitCode;
  }
  if (!nodeVersionInRange(options.nodeVersion ?? process.versions.node)) {
    writeStderr("Caelush requires Node.js 24.x.\n");
    return EXIT_CODES.BOOTSTRAP_FAILURE;
  }
  const { CliArgsError, parseCliArgs } = await import("@caelush/cli/args");
  let command;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliArgsError) {
      writeStderr(`${error.message}\n`);
      return EXIT_CODES.USAGE;
    }
    throw error;
  }
  if (
    command.kind !== "PRINT" &&
    !hasInteractiveTerminal({
      stdinIsTTY: options.stdinIsTTY ?? Boolean(process.stdin.isTTY),
      stdoutIsTTY: options.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
    })
  ) {
    writeStderr(INTERACTIVE_TTY_ERROR);
    return EXIT_CODES.BOOTSTRAP_FAILURE;
  }
  let daemon;
  try {
    daemon = await ensureDaemon(
      options.environment === undefined ? {} : { environment: options.environment },
    );
  } catch (error) {
    const message =
      error instanceof DaemonBootstrapError
        ? error.message
        : "Caelush Local Agent Service could not start. Run `caelush doctor` for diagnostics.";
    writeStderr(`${message}\n`);
    return EXIT_CODES.BOOTSTRAP_FAILURE;
  }
  const client = new CaelushClient({ baseUrl: daemon.url });
  if (command.kind === "PRINT") {
    const { runPrintHost } = await import("@caelush/cli/print");
    const result = await runPrintHost({
      client,
      workspacePath: options.workspacePath ?? process.cwd(),
      launchIntent: command.launchIntent,
      outputFormat: command.outputFormat,
      version: PRODUCT_VERSION,
      ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
      stdin: options.stdin ?? process.stdin,
      stdinIsTTY: options.stdinIsTTY ?? Boolean(process.stdin.isTTY),
      stdout: writeStdout,
      stderr: writeStderr,
    });
    return result.exitCode as ProductExitCode;
  }
  const { main: cliMain } = await import("@caelush/cli");
  const cliExitCode = await cliMain({
    client,
    workspacePath: options.workspacePath ?? process.cwd(),
    launchIntent: command,
    writeMessage: writeStderr,
  });
  return cliExitCode === EXIT_CODES.SUCCESS ? EXIT_CODES.SUCCESS : EXIT_CODES.TERMINAL_FAILURE;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
