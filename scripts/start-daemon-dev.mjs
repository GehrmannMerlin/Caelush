import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { prepareDevelopmentSandboxRunner } from "./build-sandbox-runner.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNNER_PATH_KEY = "CAELUSH_SANDBOX_RUNNER_PATH";
const RUNNER_MANIFEST_KEY = "CAELUSH_SANDBOX_RUNNER_MANIFEST";

export async function startDevelopmentDaemon(options = {}) {
  const environment = options.environment ?? process.env;
  const prepared = await (options.prepare ?? prepareDevelopmentSandboxRunner)({
    environment,
    repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
  });
  if (prepared.status === "UNAVAILABLE") {
    (options.writeWarning ?? ((text) => process.stderr.write(text)))(
      "Caelush could not prepare the Windows security component; restricted permissions remain unavailable.\n",
    );
  }
  return (options.start ?? startDaemonMain)(prepared.environment);
}

async function startDaemonMain(environment) {
  applyRunnerEnvironment(environment);
  const entryUrl = pathToFileURL(join(REPOSITORY_ROOT, "apps", "daemon", "dist", "main.js")).href;
  const { main } = await import(entryUrl);
  return main();
}

function applyRunnerEnvironment(environment) {
  for (const key of [RUNNER_PATH_KEY, RUNNER_MANIFEST_KEY]) {
    const value = environment[key];
    if (value !== undefined) process.env[key] = value;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await startDevelopmentDaemon();
}
