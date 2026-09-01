import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { readProviderConfiguration } from "./config.js";
import { resolveProductPaths } from "./product-paths.js";

export function getDefaultDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolveProductPaths({ environment }).databasePath;
}

export async function main(): Promise<void> {
  const databasePath = getDefaultDatabasePath();
  await mkdir(dirname(databasePath), { recursive: true });

  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon({ databasePath, ...readProviderConfiguration(process.env) });
  } catch (error) {
    console.error("Unable to start Caelush daemon.", error);
    process.exitCode = 1;
    return;
  }

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= daemon.close().catch((error: unknown) => {
      console.error("Unable to stop Caelush daemon.", error);
      process.exitCode = 1;
    });
    return shuttingDown;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void main();
}
