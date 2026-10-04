import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import {
  readProviderConfiguration,
  readProviderStreamPolicy,
  type ProviderStreamPolicy,
} from "./config.js";
import { providerStreamPolicyDiagnostic } from "./diagnostics.js";
import { resolveProductPaths } from "./product-paths.js";
import type { WebStaticHostOptions } from "./web/static-host.js";

export function getDefaultDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolveProductPaths({ environment }).databasePath;
}

export async function main(): Promise<void> {
  const databasePath = getDefaultDatabasePath();
  await mkdir(dirname(databasePath), { recursive: true });

  let daemon: DaemonHandle;
  let providerStreamPolicy: ProviderStreamPolicy;
  try {
    const web = readWebHostOptions(process.env);
    providerStreamPolicy = readProviderStreamPolicy(process.env);
    const compatibilityWorkspacePath = process.env.CAELUSH_WORKSPACE_PATH?.trim();
    daemon = await startDaemon({
      databasePath,
      // One environment for the whole startup path: the rollout feature gates and the packaged
      // sandbox-Runner discovery both read this object, and a launcher forwards its own environment
      // to the child, so a spawned daemon resolves the same fixed artifact as a direct start.
      environment: process.env,
      ...readProviderConfiguration(process.env),
      providerStreamPolicy,
      ...(compatibilityWorkspacePath === undefined || compatibilityWorkspacePath.length === 0
        ? {}
        : { workspacePath: compatibilityWorkspacePath }),
      ...(web === undefined ? {} : { web }),
    });
  } catch (error) {
    console.error("Unable to start Caelush daemon.", error);
    process.exitCode = 1;
    return;
  }

  console.info(
    JSON.stringify({
      event: "provider_stream_policy.effective",
      ...providerStreamPolicyDiagnostic(providerStreamPolicy),
    }),
  );

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
  return { buildRoot };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void main();
}
