import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertDesktopResourceManifestCompatible,
  DESKTOP_RESOURCE_MANIFEST_FILENAME,
  verifyDesktopAssetDigest,
  verifyDesktopResourceFiles,
  type DesktopResourceManifest,
} from "../../shared/resource-manifest.mjs";
import { BUILD_CONFIGURATION } from "../build-config.js";
import type { DesktopDaemonResources } from "./supervisor.js";

export interface DesktopResourceLayout {
  readonly packaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}

export interface VerifiedDesktopResources {
  readonly manifest: DesktopResourceManifest;
  readonly verifiedFileCount: number;
}

const verificationCache = new Map<string, Promise<VerifiedDesktopResources>>();

/** Resolves only the controlled D4 development stage or verified D6 resource layout. */
export async function resolveDesktopDaemonResources(
  layout: DesktopResourceLayout,
): Promise<DesktopDaemonResources> {
  if (layout.packaged) await verifyPackagedDesktopResources(layout);
  const paths = layout.packaged
    ? {
        nodeExecutablePath: path.join(layout.resourcesPath, "daemon", "node.exe"),
        daemonEntryPath: path.join(
          layout.resourcesPath,
          "daemon",
          "runtime",
          "dist",
          "desktop-entry.js",
        ),
        userTerminalHelperPath: path.join(
          layout.resourcesPath,
          "daemon",
          "user-terminal-helper.mjs",
        ),
      }
    : {
        nodeExecutablePath: path.resolve(layout.appPath, ".stage", "daemon", "node.exe"),
        daemonEntryPath: path.resolve(layout.appPath, "..", "daemon", "dist", "desktop-entry.js"),
        userTerminalHelperPath: path.resolve(
          layout.appPath,
          ".stage",
          "daemon",
          "user-terminal-helper.mjs",
        ),
      };
  for (const filePath of Object.values(paths)) {
    await access(filePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Desktop Daemon resource is unavailable.");
  }
  const ptyManifestPath = path.join(
    path.dirname(paths.userTerminalHelperPath),
    "node_modules",
    "node-pty",
    "package.json",
  );
  let ptyManifest: unknown;
  try {
    ptyManifest = JSON.parse(await readFile(ptyManifestPath, "utf8")) as unknown;
  } catch {
    throw new Error("The staged USER_TERMINAL runtime is unavailable.");
  }
  if (
    typeof ptyManifest !== "object" ||
    ptyManifest === null ||
    !("name" in ptyManifest) ||
    ptyManifest.name !== "node-pty" ||
    !("version" in ptyManifest) ||
    ptyManifest.version !== "1.2.0-beta.14"
  ) {
    throw new Error("The staged USER_TERMINAL runtime version is invalid.");
  }
  return Object.freeze(paths);
}

/** Verify package metadata and every external resource once before the first window loads. */
export async function verifyPackagedDesktopResources(
  layout: DesktopResourceLayout,
  onVerificationStage?: (stage: string) => void,
): Promise<VerifiedDesktopResources> {
  if (!layout.packaged) throw new Error("DESKTOP_RESOURCE_VERIFICATION_REQUIRES_PACKAGE");
  const cacheKey = `${path.resolve(layout.resourcesPath)}|${path.resolve(layout.appPath)}`;
  const existing = verificationCache.get(cacheKey);
  if (existing !== undefined) return existing;
  const verification = verifyPackagedDesktopResourcesOnce(layout, onVerificationStage);
  verificationCache.set(cacheKey, verification);
  try {
    return await verification;
  } catch (error) {
    verificationCache.delete(cacheKey);
    throw error;
  }
}

export function resolveDesktopWebRoot(layout: DesktopResourceLayout): string {
  return layout.packaged
    ? path.join(layout.resourcesPath, "web", "desktop")
    : path.resolve(layout.appPath, ".stage", "web");
}

async function verifyPackagedDesktopResourcesOnce(
  layout: DesktopResourceLayout,
  onVerificationStage?: (stage: string) => void,
): Promise<VerifiedDesktopResources> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("DESKTOP_RESOURCE_PLATFORM_UNSUPPORTED");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(
      await readFile(path.join(layout.resourcesPath, DESKTOP_RESOURCE_MANIFEST_FILENAME), "utf8"),
    ) as unknown;
  } catch {
    throw new Error("DESKTOP_RESOURCE_MANIFEST_MISSING_OR_INVALID");
  }
  onVerificationStage?.("MANIFEST_READ");

  const electronVersion = process.versions.electron;
  if (electronVersion === undefined) throw new Error("DESKTOP_RESOURCE_ELECTRON_VERSION_INVALID");
  onVerificationStage?.("IDENTITY_CHECK_STARTED");
  const manifest = assertDesktopResourceManifestCompatible(rawManifest, {
    productVersion: readAppVersion(layout.appPath),
    channel: BUILD_CONFIGURATION.channel,
    platform: "win32",
    architecture: "x64",
    electronVersion,
    daemonVersion: readDaemonVersion(layout.resourcesPath),
    apiVersion: "v1",
    protocolVersion: 1,
    nodeVersion: "24.18.0",
  });
  onVerificationStage?.("IDENTITY_CHECKED");
  onVerificationStage?.("RESOURCE_FILES_CHECK_STARTED");
  const verified = await verifyDesktopResourceFiles(manifest, layout.resourcesPath);
  onVerificationStage?.("RESOURCE_FILES_CHECKED");
  onVerificationStage?.("DESKTOP_ASSETS_CHECK_STARTED");
  await verifyDesktopAssetDigest(
    manifest.desktopAssetDigest,
    path.join(layout.appPath, "dist", "renderer"),
  );
  onVerificationStage?.("DESKTOP_ASSETS_CHECKED");
  onVerificationStage?.("NODE_RUNTIME_CHECK_STARTED");
  verifyBundledNodeRuntime(manifest, layout.resourcesPath);
  onVerificationStage?.("NODE_RUNTIME_CHECKED");
  onVerificationStage?.("RUNTIME_PACKAGES_CHECK_STARTED");
  await verifyRuntimePackages(manifest, layout.resourcesPath);
  onVerificationStage?.("RUNTIME_PACKAGES_CHECKED");
  onVerificationStage?.("SANDBOX_RUNNER_CHECK_STARTED");
  await verifySandboxRunnerSidecar(manifest, layout.resourcesPath);
  onVerificationStage?.("SANDBOX_RUNNER_CHECKED");
  return Object.freeze({ manifest, verifiedFileCount: verified.verifiedFiles });
}

function readAppVersion(appPath: string): string {
  try {
    const metadata = JSON.parse(readFileSync(path.join(appPath, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof metadata.version === "string") return metadata.version;
  } catch {
    // The caller receives one bounded compatibility failure instead of package metadata details.
  }
  throw new Error("DESKTOP_RESOURCE_APP_VERSION_INVALID");
}

function readDaemonVersion(resourcesPath: string): string {
  try {
    const metadata = JSON.parse(
      readFileSync(path.join(resourcesPath, "daemon", "runtime", "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof metadata.version === "string") return metadata.version;
  } catch {
    // The caller receives one bounded compatibility failure instead of package metadata details.
  }
  throw new Error("DESKTOP_RESOURCE_DAEMON_VERSION_INVALID");
}

function verifyBundledNodeRuntime(manifest: DesktopResourceManifest, resourcesPath: string): void {
  const nodePath = path.join(resourcesPath, "daemon", "node.exe");
  const result = spawnSync(
    nodePath,
    [
      "-p",
      "JSON.stringify({version:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("DESKTOP_NODE_RUNTIME_UNAVAILABLE");
  }
  let identity: unknown;
  try {
    identity = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error("DESKTOP_NODE_RUNTIME_IDENTITY_INVALID");
  }
  if (
    typeof identity !== "object" ||
    identity === null ||
    !("version" in identity) ||
    identity.version !== manifest.nodeVersion ||
    !("platform" in identity) ||
    identity.platform !== "win32" ||
    !("arch" in identity) ||
    identity.arch !== "x64"
  ) {
    throw new Error("DESKTOP_NODE_RUNTIME_VERSION_MISMATCH");
  }
  for (const nativeModule of manifest.nativeModules) {
    if (
      !("modules" in identity) ||
      String(identity.modules) !== nativeModule.nodeAbi ||
      !("napi" in identity) ||
      String(identity.napi) !== nativeModule.napiVersion
    ) {
      throw new Error("DESKTOP_NATIVE_MODULE_ABI_MISMATCH");
    }
  }
}

async function verifyRuntimePackages(
  manifest: DesktopResourceManifest,
  resourcesPath: string,
): Promise<void> {
  const daemonEntry = path.join(resourcesPath, "daemon", "runtime", "dist", "desktop-entry.js");
  const ptyManifestPath = path.join(
    resourcesPath,
    "daemon",
    "node_modules",
    "node-pty",
    "package.json",
  );
  await Promise.all([access(daemonEntry), access(ptyManifestPath)]);
  const pty = JSON.parse(await readFile(ptyManifestPath, "utf8")) as { version?: unknown };
  const daemon = JSON.parse(
    await readFile(path.join(resourcesPath, "daemon", "runtime", "package.json"), "utf8"),
  ) as { version?: unknown };
  const ptyEntry = manifest.nativeModules.find((module) => module.name === "node-pty");
  if (
    pty.version !== "1.2.0-beta.14" ||
    ptyEntry?.version !== "1.2.0-beta.14" ||
    daemon.version !== manifest.daemonVersion
  ) {
    throw new Error("DESKTOP_RUNTIME_PACKAGE_VERSION_MISMATCH");
  }
}

async function verifySandboxRunnerSidecar(
  manifest: DesktopResourceManifest,
  resourcesPath: string,
): Promise<void> {
  const runnerPath = path.join(resourcesPath, ...manifest.sandboxRunner.path.split("/"));
  const sidecarPath = path.join(path.dirname(runnerPath), "manifest.json");
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as unknown;
  } catch {
    throw new Error("DESKTOP_SANDBOX_RUNNER_MANIFEST_INVALID");
  }
  if (
    typeof sidecar !== "object" ||
    sidecar === null ||
    !("schemaVersion" in sidecar) ||
    sidecar.schemaVersion !== 1 ||
    !("product" in sidecar) ||
    sidecar.product !== "caelush" ||
    !("controlProtocolVersion" in sidecar) ||
    sidecar.controlProtocolVersion !== manifest.sandboxRunner.controlProtocolVersion ||
    !("platform" in sidecar) ||
    sidecar.platform !== "windows" ||
    !("arch" in sidecar) ||
    sidecar.arch !== "x64" ||
    !("sha256" in sidecar) ||
    sidecar.sha256 !== manifest.sandboxRunner.sha256 ||
    !("providers" in sidecar) ||
    !Array.isArray(sidecar.providers) ||
    sidecar.providers.length !== manifest.sandboxRunner.providers.length ||
    sidecar.providers.some(
      (provider, index) => provider !== manifest.sandboxRunner.providers[index],
    )
  ) {
    throw new Error("DESKTOP_SANDBOX_RUNNER_MANIFEST_INVALID");
  }
}
