import type {
  SandboxedSpawnSpec,
  ProcessSandboxProvider,
  SandboxEnforcement,
} from "./contracts.js";
import { RuntimeExecError } from "../exec/errors.js";
import { RuntimeSandboxError } from "../runtime-errors.js";
import { createNativeRunnerProcessAdapter } from "./native-runner-adapter.js";
import {
  probeNativeSandboxRunner,
  verifyNativeSandboxRunnerArtifact,
  type NativeSandboxRunnerManifest,
} from "./native-runner-probe.js";

export type { NativeSandboxRunnerManifest } from "./native-runner-probe.js";

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
      const artifact = await verifyNativeSandboxRunnerArtifact(
        nativeRunnerProbeInput(input, options),
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
      return probeNativeSandboxRunner(nativeRunnerProbeInput(input, options));
    },
  };
  return Object.freeze(provider);
}

function nativeRunnerProbeInput(
  input: {
    readonly id: string;
    readonly platform: "windows" | "linux" | "macos";
    readonly enforcement: SandboxEnforcement;
  },
  options: NativeRunnerProviderOptions,
) {
  return {
    providerId: input.id,
    targetPlatform: input.platform,
    enforcement: input.enforcement,
    ...(options.platform === undefined ? {} : { hostPlatform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.runnerPath === undefined ? {} : { runnerPath: options.runnerPath }),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
  };
}

function platformName(platform: NodeJS.Platform): "windows" | "linux" | "macos" | "other" {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return "other";
}
