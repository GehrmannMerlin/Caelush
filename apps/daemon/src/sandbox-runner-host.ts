import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_SANDBOX_RUNNER_MANIFEST_FILENAME,
  SandboxRunnerArtifactError,
  defaultSandboxRunnerExecutableName,
  loadAndVerifySandboxRunnerArtifact,
  sandboxRunnerPlatformName,
  type ResolvedSandboxRunnerArtifact,
  type SandboxRunnerArtifactReasonCode,
  type SandboxRunnerPlatform,
} from "@caelush/runtime";

/**
 * Bounded host discovery for the packaged sandbox Runner.
 *
 * The search space is closed: an explicit development/diagnostic override, then the
 * fixed release-relative bundle directory. The current working directory, PATH, and
 * arbitrary parent directories are never searched, and every candidate is verified
 * through the shared `@caelush/runtime` artifact verifier.
 */

export const SANDBOX_RUNNER_DIRECTORY_NAME = "sandbox-runner";
export const SANDBOX_RUNNER_PATH_ENVIRONMENT_KEY = "CAELUSH_SANDBOX_RUNNER_PATH";
export const SANDBOX_RUNNER_MANIFEST_ENVIRONMENT_KEY = "CAELUSH_SANDBOX_RUNNER_MANIFEST";

/**
 * Only the two shipped bundle entry layouts are accepted. Arbitrary parent traversal is
 * intentionally not a discovery strategy.
 */
const DESKTOP_DAEMON_ENTRY_SUFFIX = ["daemon", "runtime", "dist", "desktop-entry.js"] as const;
const PORTABLE_DAEMON_ENTRY_SUFFIX = [
  "node_modules",
  "@caelush",
  "daemon",
  "dist",
  "main.js",
] as const;

export interface SandboxRunnerResolutionInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly daemonEntryPath: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export type SandboxRunnerResolution =
  | { readonly available: true; readonly artifact: ResolvedSandboxRunnerArtifact }
  | { readonly available: false; readonly reasonCode: SandboxRunnerArtifactReasonCode };

export async function resolveSandboxRunnerArtifact(
  input: SandboxRunnerResolutionInput,
): Promise<SandboxRunnerResolution> {
  const platform = input.platform ?? process.platform;
  const targetPlatform = sandboxRunnerPlatformName(platform);
  if (targetPlatform === undefined) {
    return { available: false, reasonCode: "RUNNER_PLATFORM_UNSUPPORTED" };
  }
  const candidate = sandboxRunnerCandidate(
    input.environment,
    input.daemonEntryPath,
    targetPlatform,
  );
  if (candidate === undefined) {
    return { available: false, reasonCode: "RUNNER_ARTIFACT_MISSING" };
  }
  try {
    const artifact = await loadAndVerifySandboxRunnerArtifact({
      runnerPath: candidate.runnerPath,
      manifestPath: candidate.manifestPath,
      platform,
      ...(input.arch === undefined ? {} : { arch: input.arch }),
    });
    return { available: true, artifact };
  } catch (error) {
    return {
      available: false,
      reasonCode:
        error instanceof SandboxRunnerArtifactError ? error.reasonCode : "RUNNER_ARTIFACT_MISSING",
    };
  }
}

function sandboxRunnerCandidate(
  environment: Readonly<Record<string, string | undefined>>,
  daemonEntryPath: string,
  targetPlatform: SandboxRunnerPlatform,
): { readonly runnerPath: string; readonly manifestPath: string } | undefined {
  const override = environmentValue(environment, SANDBOX_RUNNER_PATH_ENVIRONMENT_KEY);
  if (override !== undefined) {
    if (!isBoundedAbsolutePath(override)) return undefined;
    const manifestOverride = environmentValue(environment, SANDBOX_RUNNER_MANIFEST_ENVIRONMENT_KEY);
    if (manifestOverride !== undefined && !isBoundedAbsolutePath(manifestOverride)) {
      return undefined;
    }
    return {
      runnerPath: override,
      manifestPath:
        manifestOverride ?? join(dirname(override), DEFAULT_SANDBOX_RUNNER_MANIFEST_FILENAME),
    };
  }
  const bundleRoot = packagedBundleRoot(daemonEntryPath);
  if (bundleRoot === undefined) return undefined;
  const packagedDirectory = join(bundleRoot, SANDBOX_RUNNER_DIRECTORY_NAME);
  return {
    runnerPath: join(packagedDirectory, defaultSandboxRunnerExecutableName(targetPlatform)),
    manifestPath: join(packagedDirectory, DEFAULT_SANDBOX_RUNNER_MANIFEST_FILENAME),
  };
}

function packagedBundleRoot(daemonEntryPath: string): string | undefined {
  const segments = resolve(daemonEntryPath)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  if (hasSuffix(segments, DESKTOP_DAEMON_ENTRY_SUFFIX)) {
    return resolve(dirname(daemonEntryPath), "..", "..", "..");
  }
  if (hasSuffix(segments, PORTABLE_DAEMON_ENTRY_SUFFIX)) {
    return resolve(dirname(daemonEntryPath), "..", "..", "..", "..");
  }
  return undefined;
}

function hasSuffix(segments: readonly string[], suffix: readonly string[]): boolean {
  if (segments.length < suffix.length) return false;
  const start = segments.length - suffix.length;
  return suffix.every((segment, index) => segments[start + index] === segment.toLowerCase());
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = environment[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function isBoundedAbsolutePath(value: string): boolean {
  return isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}
