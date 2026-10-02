import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
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
    const result = spawnSync(cargo, ["build", "--release", "--manifest-path", manifestPath], {
      cwd: repositoryRoot,
      // `cargo build` never reads stdin; do not hand it a stdin pipe so the build also
      // works on hosts that cannot duplicate an unusual parent stdin handle.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error("SANDBOX_RUNNER_BUILD_UNAVAILABLE");
    }
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
