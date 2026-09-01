import { homedir } from "node:os";
import { join } from "node:path";

export interface ProductPathEnvironment {
  readonly CAELUSH_HOME?: string;
}

export interface ProductPaths {
  readonly rootDirectory: string;
  readonly databasePath: string;
  readonly runDirectory: string;
  readonly startupLockDirectory: string;
  readonly logsDirectory: string;
  readonly daemonLogPath: string;
}

export interface ProductPathOptions {
  readonly environment?: ProductPathEnvironment;
  readonly homeDirectory?: string;
}

export function resolveProductPaths(options: ProductPathOptions = {}): ProductPaths {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const rootDirectory = environment.CAELUSH_HOME ?? join(homeDirectory, ".caelush");
  const runDirectory = join(rootDirectory, "run");
  const logsDirectory = join(rootDirectory, "logs");
  return {
    rootDirectory,
    databasePath: join(rootDirectory, "caelush.db"),
    runDirectory,
    startupLockDirectory: join(runDirectory, "daemon-start.lock"),
    logsDirectory,
    daemonLogPath: join(logsDirectory, "daemon.log"),
  };
}
