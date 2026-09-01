import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, relative, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE_RANGE = ">=24.0.0 <25.0.0";

export function getPlatformArtifactName(version, platform = process.platform, arch = process.arch) {
  const platformName =
    platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
  return `caelush-v${version}-${platformName}-${arch}.tgz`;
}

export function rewriteWorkspaceDependencies(manifest, workspaceVersions) {
  const rewrite = (dependencies) => {
    if (dependencies === undefined) return dependencies;
    return Object.fromEntries(
      Object.entries(dependencies).map(([name, version]) => [
        name,
        typeof version === "string" &&
        workspaceVersions[name] !== undefined &&
        (version.startsWith("workspace:") || version.includes("file:"))
          ? workspaceVersions[name]
          : version,
      ]),
    );
  };
  return {
    ...manifest,
    dependencies: rewrite(manifest.dependencies),
    optionalDependencies: rewrite(manifest.optionalDependencies),
    devDependencies: rewrite(manifest.devDependencies),
  };
}

export async function buildRelease(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const outputDirectory = resolve(
    options.outputDirectory ?? join(repositoryRoot, "release-artifacts"),
  );
  const runCommands = options.runCommands ?? true;
  if (runCommands) {
    runCommand(repositoryRoot, "build", ["build"]);
  }
  const temporaryRoot = await mkdtemp(join(options.stagingParent ?? tmpdir(), "caelush-release-"));
  const isolatedWorkspace = join(temporaryRoot, "workspace");
  const legacyDirectory = join(temporaryRoot, "legacy-deploy");
  const deployDirectory = join(temporaryRoot, "deploy");
  await mkdir(legacyDirectory, { recursive: true });
  await mkdir(deployDirectory, { recursive: true });
  try {
    await copyReleaseWorkspace(repositoryRoot, isolatedWorkspace);
    if (runCommands) {
      // Keep the repository's documented legacy path as a compatibility probe. The
      // actual artifact uses an explicit inject override because legacy deploys
      // link workspace packages back to the checkout on pnpm 11.
      runCommand(isolatedWorkspace, "deploy", [
        "--filter",
        "@caelush/launcher",
        "--prod",
        "deploy",
        legacyDirectory,
        "--legacy",
      ]);
      runCommand(isolatedWorkspace, "injected deploy", [
        "--config.inject-workspace-packages=true",
        "--filter",
        "@caelush/launcher",
        "--prod",
        "deploy",
        deployDirectory,
      ]);
    }
    await flattenInjectedDeployment(deployDirectory);
    const workspaceVersions = await readWorkspaceVersions(repositoryRoot);
    await rewritePackageManifests(deployDirectory, workspaceVersions);
    await removePnpmBuildMetadata(deployDirectory);
    await assertPortableArtifact(deployDirectory, workspaceVersions);

    const launcherManifest = JSON.parse(
      await readFile(join(deployDirectory, "package.json"), "utf8"),
    );
    const version = launcherManifest.version;
    const manifest = {
      product: "caelush",
      version,
      platform: platformName(process.platform),
      arch: process.arch,
      nodeRange: NODE_RANGE,
      createdAt: new Date().toISOString(),
      protocolVersion: 1,
    };
    await writeFile(
      join(deployDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeChecksums(deployDirectory);

    const artifactName = getPlatformArtifactName(version);
    const bundleDirectory = join(outputDirectory, artifactName.slice(0, -4));
    await rm(bundleDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    await cp(deployDirectory, bundleDirectory, { recursive: true, dereference: true });
    const archivePath = join(outputDirectory, artifactName);
    const archiveResult = spawnSync("tar", ["-czf", archivePath, "-C", bundleDirectory, "."], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
    if (archiveResult.status !== 0) {
      throw new Error("Unable to create the Caelush release archive with tar.");
    }
    return { artifactName, archivePath, bundleDirectory, manifest };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readWorkspaceVersions(repositoryRoot) {
  const versions = {};
  for (const group of ["apps", "packages"]) {
    const directory = join(repositoryRoot, group);
    for (const name of await readdir(directory)) {
      const packagePath = join(directory, name, "package.json");
      try {
        const manifest = JSON.parse(await readFile(packagePath, "utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          versions[manifest.name] = manifest.version;
        }
      } catch {
        // Non-package directories are outside the release workspace.
      }
    }
  }
  return versions;
}

async function copyReleaseWorkspace(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });
  for (const fileName of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    await cp(join(sourceRoot, fileName), join(destinationRoot, fileName));
  }
  for (const group of ["apps", "packages"]) {
    const sourceGroup = join(sourceRoot, group);
    const destinationGroup = join(destinationRoot, group);
    await mkdir(destinationGroup, { recursive: true });
    for (const packageDirectoryName of await readdir(sourceGroup)) {
      const sourcePackage = join(sourceGroup, packageDirectoryName);
      const packageManifestPath = join(sourcePackage, "package.json");
      try {
        JSON.parse(await readFile(packageManifestPath, "utf8"));
      } catch {
        continue;
      }
      const destinationPackage = join(destinationGroup, packageDirectoryName);
      await mkdir(destinationPackage, { recursive: true });
      await cp(packageManifestPath, join(destinationPackage, "package.json"));
      for (const payload of ["dist", "drizzle", "bin"]) {
        const sourcePayload = join(sourcePackage, payload);
        try {
          await stat(sourcePayload);
          await cp(sourcePayload, join(destinationPackage, payload), { recursive: true });
        } catch {
          // This package has no release payload of this kind.
        }
      }
    }
  }
}

async function rewritePackageManifests(directory, workspaceVersions) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".pnpm") {
        await rewritePackageManifests(path, workspaceVersions);
      } else {
        await rewritePackageManifests(path, workspaceVersions);
      }
      continue;
    }
    if (entry.name !== "package.json") continue;
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      const rewritten = rewriteWorkspaceDependencies(manifest, workspaceVersions);
      await writeFile(path, `${JSON.stringify(rewritten, null, 2)}\n`);
    } catch {
      // Ignore package-like metadata that is not a JSON manifest.
    }
  }
}

/**
 * pnpm's injected deployment is self-contained, but its node_modules tree is
 * still made of absolute junctions into the deployment's .pnpm store. Those
 * links are useful while the staging directory exists and become invalid as
 * soon as the temporary directory is removed. Materialize the reachable
 * production dependency graph into one flat node_modules directory instead.
 *
 * This is deliberately a package-graph operation rather than a recursive
 * copy of node_modules: recursively dereferencing pnpm's graph duplicates
 * every package for every peer-context and can follow cycles until the stage
 * becomes enormous. Node's normal upward module resolution is sufficient for
 * this product bundle once each package is present at the bundle root.
 */
export async function flattenInjectedDeployment(deployDirectory) {
  const sourceNodeModules = join(deployDirectory, "node_modules");
  const packageSources = new Map();
  const preferredByName = new Map();
  const pending = [];

  async function registerPackage(packagePath) {
    const packageSource = await resolvePackageSource(packagePath);
    if (packageSource === undefined) return;
    const manifest = await readPackageManifest(join(packageSource, "package.json"));
    if (manifest === undefined || typeof manifest.name !== "string") return;
    if (manifest.name.includes("..") || manifest.name.startsWith("/")) {
      throw new Error(`Invalid package name in release dependency graph: ${manifest.name}`);
    }

    const existing = packageSources.get(packageSource);
    if (existing !== undefined) return existing;
    const entry = { source: packageSource, manifest };
    packageSources.set(packageSource, entry);
    preferredByName.set(manifest.name, preferredByName.get(manifest.name) ?? entry);
    pending.push(entry);
    return entry;
  }

  await scanNodeModules(sourceNodeModules, registerPackage);
  await scanVirtualStore(join(sourceNodeModules, ".pnpm"), registerPackage);
  for (let index = 0; index < pending.length; index += 1) {
    const packageEntry = pending[index];
    await scanNodeModules(join(packageEntry.source, "node_modules"), registerPackage);
  }

  const flatNodeModules = join(deployDirectory, "node_modules.flat");
  await rm(flatNodeModules, { recursive: true, force: true });
  await mkdir(flatNodeModules, { recursive: true });
  for (const packageEntry of [...preferredByName.values()].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    await materializePackage(
      packageEntry,
      join(flatNodeModules, ...packageEntry.manifest.name.split("/")),
      new Set(),
      preferredByName,
    );
  }

  await rm(sourceNodeModules, { recursive: true, force: true });
  await cp(flatNodeModules, sourceNodeModules, { recursive: true });
  await rm(flatNodeModules, { recursive: true, force: true });
}

async function materializePackage(packageEntry, destination, activeSources, preferredByName) {
  await copyPackagePayload(packageEntry.source, destination);
  const nextActiveSources = new Set(activeSources);
  nextActiveSources.add(packageEntry.source);
  const dependencies = [];
  await scanNodeModules(join(packageEntry.source, "node_modules"), async (packagePath) => {
    const resolved = await resolvePackageSource(packagePath);
    if (resolved === undefined) return;
    const manifest = await readPackageManifest(join(resolved, "package.json"));
    if (manifest === undefined || typeof manifest.name !== "string") return;
    dependencies.push({ source: resolved, manifest });
  });
  for (const dependency of dependencies) {
    const preferred = preferredByName.get(dependency.manifest.name);
    if (preferred?.source === dependency.source || nextActiveSources.has(dependency.source))
      continue;
    await materializePackage(
      dependency,
      join(destination, "node_modules", ...dependency.manifest.name.split("/")),
      nextActiveSources,
      preferredByName,
    );
  }
}

async function scanVirtualStore(directory, registerPackage) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    await scanNodeModules(join(directory, entry.name, "node_modules"), registerPackage);
  }
}

async function scanNodeModules(directory, registerPackage) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const entryPath = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      let scopedEntries;
      try {
        scopedEntries = await readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.name.startsWith(".")) continue;
        await registerPackage(join(entryPath, scopedEntry.name));
      }
      continue;
    }
    await registerPackage(entryPath);
  }
}

async function resolvePackageSource(packagePath) {
  try {
    const details = await lstat(packagePath);
    return details.isSymbolicLink() ? await realpathSafe(packagePath) : packagePath;
  } catch {
    return undefined;
  }
}

async function readPackageManifest(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function copyPackagePayload(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: true,
      dereference: true,
    });
  }
}

async function removePnpmBuildMetadata(deployDirectory) {
  for (const name of [
    ".modules.yaml",
    ".package-map.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) {
    await rm(join(deployDirectory, name), { force: true }).catch(() => undefined);
    await rm(join(deployDirectory, "node_modules", name), { force: true }).catch(() => undefined);
  }
}

async function assertPortableArtifact(directory, workspaceVersions) {
  const files = await collectEntries(directory);
  for (const path of files) {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`Portable artifact contains a symbolic link: ${relative(directory, path)}`);
    }
    if (path.endsWith("package.json")) {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
        for (const [name, version] of Object.entries(manifest[section] ?? {})) {
          if (typeof version === "string" && version.startsWith("workspace:")) {
            throw new Error(
              `Unresolved workspace dependency ${name} in ${relative(directory, path)}`,
            );
          }
        }
      }
    }
  }
  if (Object.keys(workspaceVersions).length === 0)
    throw new Error("No workspace packages were found.");
}

async function collectEntries(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) paths.push(...(await collectEntries(path)));
  }
  return paths;
}

async function writeChecksums(directory) {
  const files = (await collectEntries(directory)).filter(
    (path) => !path.endsWith("checksums.sha256") && !path.endsWith("manifest.sha256"),
  );
  const regularFiles = [];
  for (const path of files) {
    if ((await stat(path)).isFile()) regularFiles.push(path);
  }
  regularFiles.sort();
  const lines = [];
  for (const path of regularFiles) {
    const bytes = await readFile(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${hash}  ${relative(directory, path).replaceAll("\\", "/")}`);
  }
  await writeFile(join(directory, "checksums.sha256"), `${lines.join("\n")}\n`);
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(join(directory, "manifest.sha256"), `${manifestHash}  manifest.json\n`);
}

async function realpathSafe(path) {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

function runCommand(cwd, label, args) {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "pnpm.cmd" : "pnpm";
  const result = isWindows
    ? spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", [command, ...args].map(quoteCommandLineArg).join(" ")],
        {
          cwd,
          stdio: "inherit",
          env: { ...process.env, CI: "true" },
          windowsVerbatimArguments: true,
        },
      )
    : spawnSync(command, args, {
        cwd,
        stdio: "inherit",
        env: { ...process.env, CI: "true" },
      });
  if (result.status !== 0) throw new Error(`Release ${label} command failed.`);
}

function quoteCommandLineArg(value) {
  if (/^[^\s"&|<>^]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function platformName(platform) {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRelease().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Release build failed."}\n`);
    process.exitCode = 1;
  });
}
