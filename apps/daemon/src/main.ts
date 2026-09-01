import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { readProviderConfiguration } from "./config.js";
import { resolveProductPaths } from "./product-paths.js";
import { createWorkspaceRef } from "./web/workspace-launch-context.js";
import type { WebStaticHostOptions } from "./web/static-host.js";

export function getDefaultDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolveProductPaths({ environment }).databasePath;
}

export async function main(): Promise<void> {
  const databasePath = getDefaultDatabasePath();
  await mkdir(dirname(databasePath), { recursive: true });

  let daemon: DaemonHandle;
  try {
    const web = readWebHostOptions(process.env);
    daemon = await startDaemon({
      databasePath,
      ...readProviderConfiguration(process.env),
      ...(web === undefined ? {} : { web }),
    });
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

function readWebHostOptions(
  environment: Readonly<Record<string, string | undefined>>,
): WebStaticHostOptions | undefined {
  const buildRoot = environment.CAELUSH_WEB_BUILD_ROOT?.trim();
  if (buildRoot === undefined || buildRoot.length === 0) return undefined;
  const workspacePath = environment.CAELUSH_WORKSPACE_PATH?.trim() || process.cwd();
  return { buildRoot, workspace: createWorkspaceRef(workspacePath) };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void main();
}
