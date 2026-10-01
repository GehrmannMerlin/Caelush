import type { ProcessSandboxProvider } from "./contracts.js";
import {
  createNativeRunnerProvider,
  type NativeRunnerProviderOptions,
} from "./native-runner-provider.js";

export type MacSeatbeltProviderOptions = NativeRunnerProviderOptions;

export function createMacSeatbeltProvider(
  options: MacSeatbeltProviderOptions = {},
): ProcessSandboxProvider {
  return createNativeRunnerProvider({
    id: "macos-seatbelt",
    platform: "macos",
    enforcement: "HARD",
    options,
  });
}

export class MacSeatbeltProvider {
  static create(options: MacSeatbeltProviderOptions = {}): ProcessSandboxProvider {
    return createMacSeatbeltProvider(options);
  }
}
