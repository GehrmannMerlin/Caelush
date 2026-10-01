import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  SandboxedSpawnSpec,
  ProcessSandboxProvider,
  SandboxProbeResult,
  SandboxEnforcement,
} from "./contracts.js";
import { RuntimeExecError } from "../exec/errors.js";
import { RuntimeSandboxError } from "../runtime-errors.js";
import { createNativeRunnerProcessAdapter } from "./native-runner-adapter.js";

export interface NativeSandboxRunnerManifest {
  readonly schemaVersion: 1;
  readonly product: "caelush";
  readonly controlProtocolVersion: 1;
  readonly platform: "windows" | "linux" | "macos";
  readonly arch: string;
  readonly executableName: string;
  readonly sha256: string;
  readonly providers: readonly string[];
}

export interface NativeRunnerProviderOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly runnerPath?: string;
  readonly manifest?: NativeSandboxRunnerManifest;
  readonly adapterFactory?: (
    input: SandboxedSpawnSpec,
  ) => Promise<import("../exec/contracts.js").ManagedProcessAdapter>;
}

export function createNativeRunnerProvider(input: {
  readonly id: string;
  readonly platform: "windows" | "linux" | "macos";
  readonly enforcement: SandboxEnforcement;
  readonly options?: NativeRunnerProviderOptions;
}): ProcessSandboxProvider {
  const options = input.options ?? {};
  const provider: ProcessSandboxProvider = {
    id: input.id,
    kind: "RESTRICTED",
    enforcement: input.enforcement,
    create: async (spec) => {
      if (spec.tty) throw new RuntimeExecError("PTY_UNAVAILABLE");
      if (platformName(options.platform ?? process.platform) !== input.platform) {
        throw new RuntimeSandboxError("The platform Provider does not match this host.");
      }
      if (options.adapterFactory !== undefined) return options.adapterFactory(spec);
      const artifact = await verifyRunnerArtifact(
        input.id,
        input.platform,
        input.enforcement,
        options,
      );
      if (!artifact.available || options.runnerPath === undefined) {
        throw new RuntimeSandboxError("The required native sandbox runner is unavailable.");
      }
      return createNativeRunnerProcessAdapter({
        runnerPath: options.runnerPath,
        providerId: input.id,
        spec,
      });
    },
    probe: async () => {
      if (platformName(options.platform ?? process.platform) !== input.platform) {
        return { available: false, enforcement: "NONE", reasonCode: "UNSUPPORTED_PLATFORM" };
      }
      if (options.adapterFactory !== undefined) {
        return { available: true, enforcement: input.enforcement };
      }
      return verifyRunnerArtifact(input.id, input.platform, input.enforcement, options);
    },
  };
  return Object.freeze(provider);
}

async function verifyRunnerArtifact(
  providerId: string,
  platform: "windows" | "linux" | "macos",
  enforcement: SandboxEnforcement,
  options: NativeRunnerProviderOptions,
): Promise<SandboxProbeResult> {
  if (platformName(options.platform ?? process.platform) !== platform) {
    return { available: false, enforcement: "NONE", reasonCode: "UNSUPPORTED_PLATFORM" };
  }
  if (options.runnerPath === undefined || options.manifest === undefined) {
    return { available: false, enforcement: "NONE", reasonCode: "RUNNER_ARTIFACT_MISSING" };
  }
  if (
    options.manifest.product !== "caelush" ||
    options.manifest.schemaVersion !== 1 ||
    options.manifest.controlProtocolVersion !== 1 ||
    options.manifest.platform !== platform ||
    options.manifest.arch !== (options.arch ?? process.arch) ||
    options.manifest.executableName !== basename(options.runnerPath) ||
    !options.manifest.providers.includes(providerId) ||
    !/^[0-9a-f]{64}$/.test(options.manifest.sha256)
  ) {
    return { available: false, enforcement: "NONE", reasonCode: "RUNNER_MANIFEST_INVALID" };
  }
  try {
    await access(options.runnerPath, constants.X_OK);
    const digest = createHash("sha256")
      .update(await readFile(options.runnerPath))
      .digest("hex");
    if (digest !== options.manifest.sha256) {
      return { available: false, enforcement: "NONE", reasonCode: "RUNNER_HASH_MISMATCH" };
    }
  } catch {
    return { available: false, enforcement: "NONE", reasonCode: "RUNNER_ARTIFACT_MISSING" };
  }
  return { available: true, enforcement };
}

function platformName(platform: NodeJS.Platform): "windows" | "linux" | "macos" | "other" {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return "other";
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").slice(value.replaceAll("\\", "/").lastIndexOf("/") + 1);
}
