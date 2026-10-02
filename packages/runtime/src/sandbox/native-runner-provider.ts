import type {
  SandboxedSpawnSpec,
  ProcessSandboxProvider,
  SandboxEnforcement,
} from "./contracts.js";
import type { ManagedProcessAdapter } from "../exec/contracts.js";
import { RuntimeExecError } from "../exec/errors.js";
import { RuntimeSandboxError } from "../runtime-errors.js";
import {
  createNativeRunnerProcessAdapter,
  modeForPolicy,
  withNativeRunnerCleanup,
} from "./native-runner-adapter.js";
import {
  createNativeWorkspaceSandboxController,
  type NativeWorkspaceSandboxController,
} from "./native-workspace-controller.js";
import type { PrivateRunTemp } from "./private-temp.js";
import {
  probeNativeSandboxRunner,
  verifyNativeSandboxRunnerArtifact,
} from "./native-runner-probe.js";
import type { SandboxRunnerManifest } from "./runner-artifact.js";

export type { SandboxRunnerManifest as NativeSandboxRunnerManifest } from "./runner-artifact.js";

export interface NativeRunnerProviderOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly runnerPath?: string;
  readonly manifestPath?: string;
  readonly manifest?: SandboxRunnerManifest;
  readonly readyTimeoutMs?: number;
  readonly privateTempBaseDirectory?: string;
  readonly workspaceController?: NativeWorkspaceSandboxController;
  readonly adapterFactory?: (
    input: SandboxedSpawnSpec,
    privateRunTemp?: PrivateRunTemp,
  ) => Promise<ManagedProcessAdapter>;
}

export function createNativeRunnerProvider(input: {
  readonly id: string;
  readonly platform: "windows" | "linux" | "macos";
  readonly enforcement: SandboxEnforcement;
  readonly options?: NativeRunnerProviderOptions;
}): ProcessSandboxProvider {
  const options = input.options ?? {};
  const workspaceController =
    options.workspaceController ??
    (options.adapterFactory === undefined && input.platform === "windows"
      ? createNativeWorkspaceSandboxController({
          providerId: input.id,
          ...(options.runnerPath === undefined ? {} : { runnerPath: options.runnerPath }),
          ...(options.readyTimeoutMs === undefined
            ? {}
            : { readyTimeoutMs: options.readyTimeoutMs }),
          ...(options.privateTempBaseDirectory === undefined
            ? {}
            : { privateTempBaseDirectory: options.privateTempBaseDirectory }),
        })
      : undefined);
  const provider: ProcessSandboxProvider = {
    id: input.id,
    kind: "RESTRICTED",
    enforcement: input.enforcement,
    create: async (spec) => {
      if (spec.tty) throw new RuntimeExecError("PTY_UNAVAILABLE");
      if (platformName(options.platform ?? process.platform) !== input.platform) {
        throw new RuntimeSandboxError("The platform Provider does not match this host.");
      }
      const mode = modeForPolicy(spec.policy);
      if (options.adapterFactory === undefined) {
        const artifact = await verifyNativeSandboxRunnerArtifact(
          nativeRunnerProbeInput(input, options),
        );
        if (!artifact.available || options.runnerPath === undefined) {
          throw new RuntimeSandboxError("The required native sandbox runner is unavailable.");
        }
      }
      const privateRunTemp =
        input.platform === "windows" &&
        mode === "workspace-write" &&
        workspaceController !== undefined
          ? await workspaceController.createRunTemp(spec.policy.runId)
          : undefined;
      try {
        const adapter =
          options.adapterFactory === undefined
            ? await createNativeRunnerProcessAdapter({
                runnerPath: options.runnerPath!,
                providerId: input.id,
                spec,
                ...(options.readyTimeoutMs === undefined
                  ? {}
                  : { readyTimeoutMs: options.readyTimeoutMs }),
                ...(privateRunTemp === undefined ? {} : { privateRunTemp }),
              })
            : await options.adapterFactory(spec, privateRunTemp);
        if (privateRunTemp === undefined || workspaceController === undefined) return adapter;
        return withNativeRunnerCleanup(adapter, () =>
          workspaceController.cleanupRunTemp(privateRunTemp),
        );
      } catch (error) {
        if (privateRunTemp !== undefined && workspaceController !== undefined) {
          await workspaceController.cleanupRunTemp(privateRunTemp).catch(() => undefined);
        }
        throw error;
      }
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
    ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
  };
}

function platformName(platform: NodeJS.Platform): "windows" | "linux" | "macos" | "other" {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return "other";
}
