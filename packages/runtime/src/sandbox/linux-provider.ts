import type { ProcessSandboxProvider } from "./contracts.js";
import {
  createNativeRunnerProvider,
  type NativeRunnerProviderOptions,
} from "./native-runner-provider.js";

export type LinuxSandboxProviderOptions = NativeRunnerProviderOptions;

export function createLinuxLandlockProvider(
  options: LinuxSandboxProviderOptions = {},
): ProcessSandboxProvider {
  return createNativeRunnerProvider({
    id: "linux-landlock",
    platform: "linux",
    enforcement: "HARD",
    options,
  });
}

export function createLinuxBubblewrapProvider(
  options: LinuxSandboxProviderOptions = {},
): ProcessSandboxProvider {
  return createNativeRunnerProvider({
    id: "linux-bubblewrap",
    platform: "linux",
    enforcement: "HARD",
    options,
  });
}

export class LinuxLandlockProvider {
  static create(options: LinuxSandboxProviderOptions = {}): ProcessSandboxProvider {
    return createLinuxLandlockProvider(options);
  }
}

export class LinuxBubblewrapProvider {
  static create(options: LinuxSandboxProviderOptions = {}): ProcessSandboxProvider {
    return createLinuxBubblewrapProvider(options);
  }
}
