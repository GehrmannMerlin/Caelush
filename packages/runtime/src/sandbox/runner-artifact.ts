import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SANDBOX_CONTROL_PROTOCOL_VERSION } from "./control-protocol.js";

/**
 * The single Runtime authority for sandbox Runner artifact identity.
 *
 * Every consumer (the native Provider, the daemon host resolver, and the launcher
 * doctor) verifies a Runner through this module so exactly one implementation of the
 * manifest field validation and the SHA-256 comparison exists.
 */

export type SandboxRunnerPlatform = "windows" | "linux" | "macos";

export type SandboxRunnerArtifactReasonCode =
  | "RUNNER_PLATFORM_UNSUPPORTED"
  | "RUNNER_ARTIFACT_MISSING"
  | "RUNNER_MANIFEST_INVALID"
  | "RUNNER_BACKEND_MISSING"
  | "RUNNER_HASH_MISMATCH";

export const SANDBOX_RUNNER_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_SANDBOX_RUNNER_MANIFEST_FILENAME = "manifest.json";
export const WINDOWS_SANDBOX_RUNNER_EXECUTABLE = "caelush-sandbox-runner.exe";
export const POSIX_SANDBOX_RUNNER_EXECUTABLE = "caelush-sandbox-runner";

export const SANDBOX_RUNNER_PLATFORM_PROVIDERS: Readonly<
  Record<SandboxRunnerPlatform, readonly string[]>
> = Object.freeze({
  windows: Object.freeze(["windows-acl-restricted-token"]),
  linux: Object.freeze(["linux-landlock", "linux-bubblewrap"]),
  macos: Object.freeze(["macos-seatbelt"]),
});

export interface SandboxRunnerManifest {
  readonly schemaVersion: 1;
  readonly product: "caelush";
  readonly controlProtocolVersion: 1;
  readonly platform: SandboxRunnerPlatform;
  readonly arch: string;
  readonly executableName: string;
  readonly sha256: string;
  readonly providers: readonly string[];
}

export interface ResolvedSandboxRunnerArtifact {
  readonly runnerPath: string;
  readonly manifestPath: string;
  readonly manifest: SandboxRunnerManifest;
}

export interface LoadSandboxRunnerArtifactInput {
  /** Absolute path of the Runner executable. */
  readonly runnerPath: string;
  /** Manifest path; defaults to `manifest.json` beside the Runner executable. */
  readonly manifestPath?: string;
  /** Already-parsed manifest. When present it is validated instead of reading `manifestPath`. */
  readonly manifest?: SandboxRunnerManifest;
  /** Host platform whose target Runner is required. Defaults to the current process platform. */
  readonly platform?: NodeJS.Platform;
  /** Target architecture required by the manifest. Defaults to the current process architecture. */
  readonly arch?: string;
}

export class SandboxRunnerArtifactError extends Error {
  readonly reasonCode: SandboxRunnerArtifactReasonCode;

  constructor(reasonCode: SandboxRunnerArtifactReasonCode) {
    super(`The native sandbox runner artifact is unavailable (${reasonCode}).`);
    this.name = "SandboxRunnerArtifactError";
    this.reasonCode = reasonCode;
  }
}

export function sandboxRunnerPlatformName(
  platform: NodeJS.Platform,
): SandboxRunnerPlatform | undefined {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return undefined;
}

export function defaultSandboxRunnerExecutableName(platform: SandboxRunnerPlatform): string {
  return platform === "windows"
    ? WINDOWS_SANDBOX_RUNNER_EXECUTABLE
    : POSIX_SANDBOX_RUNNER_EXECUTABLE;
}

/**
 * Validates a manifest against the exact artifact it is expected to describe. Any
 * identity mismatch is a bounded failure, never a partially trusted artifact.
 */
export function validateSandboxRunnerManifest(
  input: unknown,
  expected: {
    readonly platform: SandboxRunnerPlatform;
    readonly arch: string;
    readonly executableName: string;
  },
): SandboxRunnerManifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SandboxRunnerArtifactError("RUNNER_MANIFEST_INVALID");
  }
  const manifest = input as Record<string, unknown>;
  if (
    manifest.schemaVersion !== SANDBOX_RUNNER_MANIFEST_SCHEMA_VERSION ||
    manifest.product !== "caelush" ||
    manifest.controlProtocolVersion !== SANDBOX_CONTROL_PROTOCOL_VERSION ||
    manifest.platform !== expected.platform ||
    manifest.arch !== expected.arch ||
    manifest.executableName !== expected.executableName ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Array.isArray(manifest.providers) ||
    manifest.providers.length === 0 ||
    manifest.providers.some((provider) => typeof provider !== "string" || provider.length === 0)
  ) {
    throw new SandboxRunnerArtifactError("RUNNER_MANIFEST_INVALID");
  }
  const allowedProviders = SANDBOX_RUNNER_PLATFORM_PROVIDERS[expected.platform];
  if (
    (manifest.providers as readonly string[]).some(
      (provider) => !allowedProviders.includes(provider),
    )
  ) {
    throw new SandboxRunnerArtifactError("RUNNER_BACKEND_MISSING");
  }
  return Object.freeze({
    schemaVersion: SANDBOX_RUNNER_MANIFEST_SCHEMA_VERSION,
    product: "caelush",
    controlProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    platform: expected.platform,
    arch: expected.arch,
    executableName: expected.executableName,
    sha256: manifest.sha256,
    providers: Object.freeze([...(manifest.providers as readonly string[])].sort()),
  });
}

export async function loadAndVerifySandboxRunnerArtifact(
  input: LoadSandboxRunnerArtifactInput,
): Promise<ResolvedSandboxRunnerArtifact> {
  const hostPlatform = input.platform ?? process.platform;
  const targetPlatform = sandboxRunnerPlatformName(hostPlatform);
  if (targetPlatform === undefined) {
    throw new SandboxRunnerArtifactError("RUNNER_PLATFORM_UNSUPPORTED");
  }
  const manifestPath =
    input.manifestPath ?? join(dirname(input.runnerPath), DEFAULT_SANDBOX_RUNNER_MANIFEST_FILENAME);
  const expected = {
    platform: targetPlatform,
    arch: input.arch ?? process.arch,
    executableName: basename(input.runnerPath),
  };
  const manifest =
    input.manifest === undefined
      ? validateSandboxRunnerManifest(await readManifestFile(manifestPath), expected)
      : validateSandboxRunnerManifest(input.manifest, expected);
  await verifyRunnerHash(input.runnerPath, manifest.sha256);
  return Object.freeze({ runnerPath: input.runnerPath, manifestPath, manifest });
}

async function readManifestFile(manifestPath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new SandboxRunnerArtifactError("RUNNER_ARTIFACT_MISSING");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SandboxRunnerArtifactError("RUNNER_MANIFEST_INVALID");
  }
}

async function verifyRunnerHash(runnerPath: string, expectedSha256: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(runnerPath);
  } catch {
    throw new SandboxRunnerArtifactError("RUNNER_ARTIFACT_MISSING");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new SandboxRunnerArtifactError("RUNNER_HASH_MISMATCH");
  }
}
