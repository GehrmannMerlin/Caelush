import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

export const SANDBOX_RUNNER_MANIFEST_VERSION = 1;
export const SANDBOX_CONTROL_PROTOCOL_VERSION = 1;
export const SANDBOX_RUNNER_DIRECTORY_NAME = "sandbox-runner";
export const SANDBOX_RUNNER_MANIFEST_FILENAME = "manifest.json";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLATFORM_NAMES = new Set(["windows", "linux", "macos"]);
const PLATFORM_PROVIDERS = {
  windows: new Set(["windows-acl-restricted-token"]),
  linux: new Set(["linux-landlock", "linux-bubblewrap"]),
  macos: new Set(["macos-seatbelt"]),
};

export function createSandboxRunnerManifest(input) {
  const manifest = {
    schemaVersion: SANDBOX_RUNNER_MANIFEST_VERSION,
    product: "caelush",
    controlProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    platform: input.platform,
    arch: input.arch,
    executableName: input.executableName,
    sha256: input.sha256,
    providers: [...input.providers].sort(),
  };
  return validateSandboxRunnerManifest(manifest);
}

export function validateSandboxRunnerManifest(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid sandbox runner manifest.");
  }
  const manifest = input;
  if (
    manifest.schemaVersion !== SANDBOX_RUNNER_MANIFEST_VERSION ||
    manifest.product !== "caelush" ||
    manifest.controlProtocolVersion !== SANDBOX_CONTROL_PROTOCOL_VERSION ||
    typeof manifest.platform !== "string" ||
    !PLATFORM_NAMES.has(manifest.platform) ||
    typeof manifest.arch !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(manifest.arch) ||
    typeof manifest.executableName !== "string" ||
    manifest.executableName.length === 0 ||
    manifest.executableName.includes("/") ||
    manifest.executableName.includes("\\") ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Array.isArray(manifest.providers) ||
    manifest.providers.length === 0 ||
    manifest.providers.some(
      (provider) =>
        typeof provider !== "string" ||
        !(PLATFORM_PROVIDERS[manifest.platform]?.has(provider) ?? false),
    )
  ) {
    throw new Error("Invalid sandbox runner manifest platform, provider, or hash.");
  }
  return Object.freeze({
    schemaVersion: 1,
    product: "caelush",
    controlProtocolVersion: 1,
    platform: manifest.platform,
    arch: manifest.arch,
    executableName: manifest.executableName,
    sha256: manifest.sha256,
    providers: Object.freeze([...manifest.providers].sort()),
  });
}

export async function hashSandboxRunnerFile(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

export async function writeSandboxRunnerManifest(filePath, manifest) {
  const validated = validateSandboxRunnerManifest(manifest);
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

/**
 * Re-reads the packaged Runner and proves it still matches the manifest hash that the
 * release manifest will advertise. A copy/archive step that corrupts the binary must
 * fail closed instead of publishing a package that claims restricted sandbox support.
 */
export async function verifySandboxRunnerPackage(input) {
  const manifest = validateSandboxRunnerManifest(input.manifest);
  const digest = await hashSandboxRunnerFile(input.runnerPath);
  if (digest !== manifest.sha256) {
    throw new Error("SANDBOX_RUNNER_HASH_MISMATCH");
  }
  return digest;
}

export async function buildSandboxRunner(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const outputDirectory = resolve(
    options.outputDirectory ?? join(repositoryRoot, "release-artifacts", "sandbox"),
  );
  const platform = platformName(options.platform ?? process.platform);
  const arch = options.arch ?? process.arch;
  const cargo = options.cargo ?? "cargo";
  const manifestPath = join(repositoryRoot, "native", "sandbox-runner", "Cargo.toml");
  const binaryName =
    platform === "windows" ? "caelush-sandbox-runner.exe" : "caelush-sandbox-runner";
  const builtBinary =
    options.binaryPath ??
    join(repositoryRoot, "native", "sandbox-runner", "target", "release", binaryName);
  if (options.runCargo !== false) {
    await runCargoBuild({
      cargo,
      manifestPath,
      repositoryRoot,
      spawnProcess: options.spawn ?? spawn,
    });
  }
  const destination = join(outputDirectory, binaryName);
  await mkdir(outputDirectory, { recursive: true });
  await cp(builtBinary, destination);
  const manifest = createSandboxRunnerManifest({
    platform,
    arch,
    executableName: binaryName,
    sha256: await hashSandboxRunnerFile(destination),
    providers: providersForPlatform(platform),
  });
  await writeSandboxRunnerManifest(
    join(outputDirectory, SANDBOX_RUNNER_MANIFEST_FILENAME),
    manifest,
  );
  return {
    binaryPath: destination,
    manifestPath: join(outputDirectory, SANDBOX_RUNNER_MANIFEST_FILENAME),
    manifest,
  };
}

async function runCargoBuild(input) {
  await new Promise((resolveBuild, rejectBuild) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolveBuild();
      else rejectBuild(new Error("SANDBOX_RUNNER_BUILD_UNAVAILABLE"));
    };
    let child;
    try {
      child = input.spawnProcess(
        input.cargo,
        ["build", "--release", "--manifest-path", input.manifestPath],
        {
          cwd: input.repositoryRoot,
          // Cargo never reads stdin. Ignoring all three streams keeps output bounded while allowing
          // the event loop to renew the daemon-start lease during a long first release build.
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      finish(new Error("spawn failed"));
      return;
    }
    child.once("error", () => finish(new Error("spawn failed")));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error("build failed")));
  });
}

export async function discoverDevelopmentSandboxRunner(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const platform = platformName(options.platform ?? process.platform);
  const arch = options.arch ?? process.arch;
  const outputDirectory = resolve(
    options.outputDirectory ?? join(repositoryRoot, "release-artifacts", "sandbox"),
  );
  const manifestPath = join(outputDirectory, SANDBOX_RUNNER_MANIFEST_FILENAME);
  const manifest = validateSandboxRunnerManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const executableName =
    platform === "windows" ? "caelush-sandbox-runner.exe" : "caelush-sandbox-runner";
  if (
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.executableName !== executableName
  ) {
    throw new Error("SANDBOX_RUNNER_DEVELOPMENT_ARTIFACT_MISMATCH");
  }
  const binaryPath = join(outputDirectory, executableName);
  await verifySandboxRunnerPackage({ runnerPath: binaryPath, manifest });
  return { binaryPath, manifestPath, manifest };
}

/**
 * Prepare the verified Runner environment used by source-checkout startup commands.
 *
 * Production artifact discovery remains daemon-owned and fixed-layout. This helper is an explicit
 * development bootstrap: on Windows it builds a manifest-bound Runner under the product home, never
 * inside the source checkout that the Runner may later sandbox. A read-only diagnostic verifies that
 * same external artifact. An operator-provided override still wins only when it is outside the source
 * checkout; overlapping infrastructure fails closed before any build or daemon start.
 */
export async function prepareDevelopmentSandboxRunner(options = {}) {
  const environment = { ...(options.environment ?? process.env) };
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { status: "SKIPPED", environment };

  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  try {
    const explicitRunnerPath = environment.CAELUSH_SANDBOX_RUNNER_PATH?.trim();
    if (explicitRunnerPath !== undefined && explicitRunnerPath.length > 0) {
      const explicitManifestPath = environment.CAELUSH_SANDBOX_RUNNER_MANIFEST?.trim();
      if (
        (await isPathWithin(repositoryRoot, explicitRunnerPath)) ||
        (explicitManifestPath !== undefined &&
          explicitManifestPath.length > 0 &&
          (await isPathWithin(repositoryRoot, explicitManifestPath)))
      ) {
        return unavailableForRunnerOverlap(environment);
      }
      return { status: "EXPLICIT", environment };
    }

    const arch = options.arch ?? process.arch;
    const outputDirectory = developmentRunnerOutputDirectory({
      environment,
      platform,
      arch,
      homeDirectory: options.homeDirectory,
    });
    if (await isPathWithin(repositoryRoot, outputDirectory)) {
      return unavailableForRunnerOverlap(environment);
    }
    if (options.buildIfMissing === false) {
      const runner = await (options.discover ?? discoverDevelopmentSandboxRunner)({
        repositoryRoot,
        outputDirectory,
        platform,
        arch,
      });
      if (await runnerArtifactOverlapsRepository(repositoryRoot, runner)) {
        return unavailableForRunnerOverlap(environment);
      }
      return {
        status: "CONFIGURED",
        environment: {
          ...environment,
          CAELUSH_SANDBOX_RUNNER_PATH: runner.binaryPath,
          CAELUSH_SANDBOX_RUNNER_MANIFEST: runner.manifestPath,
        },
      };
    }
    const runner = await (options.build ?? buildSandboxRunner)({
      repositoryRoot,
      outputDirectory,
      platform,
      arch,
      ...(options.cargo === undefined ? {} : { cargo: options.cargo }),
    });
    if (await runnerArtifactOverlapsRepository(repositoryRoot, runner)) {
      return unavailableForRunnerOverlap(environment);
    }
    return {
      status: "CONFIGURED",
      environment: {
        ...environment,
        CAELUSH_SANDBOX_RUNNER_PATH: runner.binaryPath,
        CAELUSH_SANDBOX_RUNNER_MANIFEST: runner.manifestPath,
      },
    };
  } catch {
    return { status: "UNAVAILABLE", environment };
  }
}

function developmentRunnerOutputDirectory(input) {
  const configuredHome = input.environment.CAELUSH_HOME?.trim();
  const productHome = resolve(
    configuredHome === undefined || configuredHome.length === 0
      ? join(input.homeDirectory ?? homedir(), ".caelush")
      : configuredHome,
  );
  return join(
    productHome,
    "runtime",
    SANDBOX_RUNNER_DIRECTORY_NAME,
    `${platformName(input.platform)}-${input.arch}`,
  );
}

async function runnerArtifactOverlapsRepository(repositoryRoot, runner) {
  return (
    (await isPathWithin(repositoryRoot, runner.binaryPath)) ||
    (await isPathWithin(repositoryRoot, runner.manifestPath))
  );
}

async function isPathWithin(rootPath, candidatePath) {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalizePath(rootPath),
    canonicalizePath(candidatePath),
  ]);
  const pathFromRoot = relative(canonicalRoot, canonicalCandidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function canonicalizePath(inputPath) {
  let existingAncestor = resolve(inputPath);
  const missingSegments = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return resolve(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return resolve(inputPath);
      missingSegments.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function unavailableForRunnerOverlap(environment) {
  return {
    status: "UNAVAILABLE",
    reasonCode: "RUNNER_INSIDE_WORKSPACE",
    environment,
  };
}

function platformName(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return platform;
}

function providersForPlatform(platform) {
  const providers = PLATFORM_PROVIDERS[platform];
  if (providers === undefined) throw new Error("SANDBOX_RUNNER_PLATFORM_UNSUPPORTED");
  return [...providers];
}
