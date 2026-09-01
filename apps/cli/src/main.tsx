import { render } from "ink";
import { createDaemonClient } from "./bootstrap/daemon-client.js";
import { CliConversationController, type CliDaemonClient } from "./application/cli-controller.js";
import { App } from "./components/App.js";

export interface CliMainOptions {
  readonly client?: CliDaemonClient;
  readonly workspacePath?: string;
  readonly renderApplication?: (controller: CliConversationController) => CliApplication;
}

export interface CliApplication {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

export async function main(options: CliMainOptions = {}): Promise<number> {
  const controller = new CliConversationController({
    client: options.client ?? createDaemonClient(),
    workspacePath: options.workspacePath ?? process.cwd(),
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
