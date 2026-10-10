import path from "node:path";
import type { DesktopHostRequestBinding } from "./transport/local-request-guard.js";

export interface DesktopDaemonHostBinding extends DesktopHostRequestBinding {
  readonly profileId: string;
  readonly generationId: string;
  readonly profileRootDirectory: string;
}

export const DESKTOP_HOST_CAPABILITY_NAMES = Object.freeze([
  "desktopHostAuthV1",
  "desktopProfileBindingV1",
  "desktopLocalProxyV1",
] as const);

const profileIdPattern = /^u_[0-9a-f]{64}$/u;
const hostTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export function assertDesktopDaemonHostBinding(input: {
  readonly binding: DesktopDaemonHostBinding;
  readonly databasePath: string;
  readonly configuredHome: string | undefined;
  readonly host: string;
  readonly port: number;
}): void {
  const { binding } = input;
  const home = input.configuredHome;
  if (
    !profileIdPattern.test(binding.profileId) ||
    !/^[0-9a-f-]{36}$/iu.test(binding.generationId) ||
    !hostTokenPattern.test(binding.hostToken) ||
    home === undefined ||
    input.host !== "127.0.0.1" ||
    input.port !== 0 ||
    !sameWindowsPath(home, binding.profileRootDirectory) ||
    !sameWindowsPath(input.databasePath, path.join(binding.profileRootDirectory, "caelush.db"))
  ) {
    throw new Error("Desktop Daemon bootstrap binding is invalid.");
  }

  const tokenBytes = Buffer.from(binding.hostToken, "base64url");
  if (tokenBytes.byteLength !== 32 || tokenBytes.toString("base64url") !== binding.hostToken) {
    throw new Error("Desktop Daemon bootstrap binding is invalid.");
  }
}

export function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path.win32
      .resolve(value)
      .replace(/[\\/]+$/u, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}
