import { render } from "ink";
import { createDaemonClient } from "./bootstrap/daemon-client.js";
import {
  CliArgsError,
  parseCliArgs,
  type LaunchIntent,
  type PrintIntent,
} from "./bootstrap/cli-args.js";
import { CliConversationController, type CliDaemonClient } from "./application/cli-controller.js";
import { App } from "./components/App.js";

export interface CliMainOptions {
  readonly client?: CliDaemonClient;
  readonly workspacePath?: string;
  readonly argv?: readonly string[];
  readonly writeMessage?: (message: string) => void;
  readonly launchIntent?: LaunchIntent;
  readonly renderApplication?: (controller: CliConversationController) => CliApplication;
}

export interface CliApplication {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

export async function main(options: CliMainOptions = {}): Promise<number> {
  let launchIntent: LaunchIntent;
  try {
    const command = options.launchIntent ?? parseCliArgs(options.argv ?? process.argv.slice(2));
    if (command.kind === "PRINT") return printModeNotAvailable(command);
    launchIntent = command;
  } catch (error) {
    if (error instanceof CliArgsError) {
      (options.writeMessage ?? defaultWriteMessage)(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const controller = new CliConversationController({
    client: options.client ?? createDaemonClient(),
    workspacePath: options.workspacePath ?? process.cwd(),
    launchIntent,
  });
  const application =
    options.renderApplication?.(controller) ??
    render(<App controller={controller} />, { exitOnCtrlC: false });
  await controller.bootstrap();
  if (controller.getState().bootstrap === "BOOTSTRAP_ERROR") {
    application.unmount();
    controller.dispose();
    return 1;
  }
  await application.waitUntilExit();
  controller.dispose();
  return 0;
}

function printModeNotAvailable(_command: PrintIntent): number {
  return 2;
}

function defaultWriteMessage(message: string): void {
  console.error(message.trim());
}
