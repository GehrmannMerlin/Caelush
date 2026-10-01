import type { ProcessSandboxProvider } from "./contracts.js";
import {
  createNativeRunnerProvider,
  type NativeRunnerProviderOptions,
} from "./native-runner-provider.js";

export type WindowsAclRestrictedTokenProviderOptions = NativeRunnerProviderOptions;

export function createWindowsAclRestrictedTokenProvider(
  options: WindowsAclRestrictedTokenProviderOptions = {},
): ProcessSandboxProvider {
  return createNativeRunnerProvider({
    id: "windows-acl-restricted-token",
    platform: "windows",
    // Windows ACL capability SIDs plus a restricted token are intentionally reported PARTIAL:
    // hard-link/reparse edge cases require the higher-level target revalidation as well.
    enforcement: "PARTIAL",
    options,
  });
}

export class WindowsAclRestrictedTokenProvider {
  static create(options: WindowsAclRestrictedTokenProviderOptions = {}): ProcessSandboxProvider {
    return createWindowsAclRestrictedTokenProvider(options);
  }
}
