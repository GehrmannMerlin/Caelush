import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon, type DaemonHandle } from "./daemon.js";

export function getDefaultDatabasePath(): string {
  return join(homedir(), ".caelush", "caelush.db");
}

export async function main(): Promise<void> {
  const databasePath = getDefaultDatabasePath();
  await mkdir(dirname(databasePath), { recursive: true });

  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon({ databasePath });
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
