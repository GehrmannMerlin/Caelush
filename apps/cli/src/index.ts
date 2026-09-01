import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./main.js";

export { main } from "./main.js";
export { CliArgsError, parseCliArgs } from "./bootstrap/cli-args.js";
export type { LaunchIntent } from "./bootstrap/cli-args.js";
export { CliConversationController } from "./application/cli-controller.js";
export { createDaemonClient, resolveDaemonUrl } from "./bootstrap/daemon-client.js";

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
