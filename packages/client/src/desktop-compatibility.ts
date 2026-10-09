import { DaemonInfoSchema, type DaemonCapabilities } from "@caelush/protocol";

export const DESKTOP_DAEMON_API_VERSION = "v1";
export const DESKTOP_DAEMON_PROTOCOL_VERSION = 1;

export const DESKTOP_HOST_CAPABILITIES = Object.freeze([
  "desktopHostAuthV1",
  "desktopProfileBindingV1",
  "desktopLocalProxyV1",
] as const);

export type DesktopHostCapability = (typeof DESKTOP_HOST_CAPABILITIES)[number];
export type DesktopDaemonCapability = keyof DaemonCapabilities;

/**
 * D0-B deliberately has no implemented Desktop security capabilities. A Daemon declaration alone
 * is never sufficient to enable a capability; the Desktop release must first implement and review
 * the corresponding host-side enforcement in a later round.
 */
export const IMPLEMENTED_DESKTOP_HOST_CAPABILITIES: readonly DesktopHostCapability[] =
  Object.freeze([]);

export type DesktopCompatibilityErrorCode =
  | "DAEMON_INFO_INVALID"
  | "HOST_IDENTITY_UNVERIFIED"
  | "DAEMON_API_INCOMPATIBLE"
  | "DAEMON_PROTOCOL_INCOMPATIBLE"
  | "DAEMON_PRODUCT_VERSION_INVALID"
  | "DAEMON_PRODUCT_VERSION_INCOMPATIBLE"
  | "DESKTOP_CAPABILITY_NOT_IMPLEMENTED"
  | "DAEMON_CAPABILITY_MISSING";

export interface DesktopCompatibilityRequirements {
  readonly productVersion: string;
  readonly apiVersion: string;
  readonly protocolVersion: number;
  readonly requiredCapabilities: readonly DesktopDaemonCapability[];
  readonly optionalCapabilities?: readonly DesktopDaemonCapability[];
  /** Set only by a trusted Main flow after process identity and Host Token checks. */
  readonly hostIdentityVerified: boolean;
}

export interface DesktopCompatibleResult {
  readonly status: "COMPATIBLE";
  readonly canEnterWorkspace: true;
  readonly availableOptionalCapabilities: readonly DesktopDaemonCapability[];
  readonly unavailableOptionalCapabilities: readonly DesktopDaemonCapability[];
}

export interface DesktopIncompatibleResult {
  readonly status: "INCOMPATIBLE";
  readonly canEnterWorkspace: false;
  readonly code: DesktopCompatibilityErrorCode;
  readonly safeReason: string;
  readonly missingCapabilities: readonly DesktopDaemonCapability[];
}

export type DesktopDaemonCompatibility = DesktopCompatibleResult | DesktopIncompatibleResult;

const desktopHostCapabilitySet = new Set<string>(DESKTOP_HOST_CAPABILITIES);
const implementedDesktopCapabilitySet = new Set<string>(IMPLEMENTED_DESKTOP_HOST_CAPABILITIES);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Evaluate API and Protocol discriminators, then validate the full DaemonInfo release/capability
 * contract. This function performs no process, network, Cloud, workspace, or Agent operation. It
 * is not a host authenticator: callers must supply `hostIdentityVerified` only after trusted
 * verification.
 */
export function evaluateDesktopDaemonCompatibility(
  daemonInfo: unknown,
  requirements: DesktopCompatibilityRequirements,
): DesktopDaemonCompatibility {
  if (isRecord(daemonInfo)) {
    if (
      typeof daemonInfo.apiVersion === "string" &&
      daemonInfo.apiVersion !== requirements.apiVersion
    ) {
      return incompatible(
        "DAEMON_API_INCOMPATIBLE",
        "The local Daemon API version is incompatible.",
      );
    }
    if (
      typeof daemonInfo.protocolVersion === "number" &&
      daemonInfo.protocolVersion !== requirements.protocolVersion
    ) {
      return incompatible(
        "DAEMON_PROTOCOL_INCOMPATIBLE",
        "The local Daemon protocol version is incompatible.",
      );
    }
  }
  const parsed = DaemonInfoSchema.safeParse(daemonInfo);
  if (!parsed.success) {
    return incompatible("DAEMON_INFO_INVALID", "The local Daemon information is invalid.");
  }
  if (requirements.hostIdentityVerified !== true) {
    return incompatible(
      "HOST_IDENTITY_UNVERIFIED",
      "The Desktop could not verify the Daemon process identity.",
    );
  }
  if (parsed.data.apiVersion !== requirements.apiVersion) {
    return incompatible("DAEMON_API_INCOMPATIBLE", "The local Daemon API version is incompatible.");
  }
  if (parsed.data.protocolVersion !== requirements.protocolVersion) {
    return incompatible(
      "DAEMON_PROTOCOL_INCOMPATIBLE",
      "The local Daemon protocol version is incompatible.",
    );
  }
  if (!isSemVer(requirements.productVersion) || !isSemVer(parsed.data.daemonVersion)) {
    return incompatible(
      "DAEMON_PRODUCT_VERSION_INVALID",
      "The Desktop or Daemon product version is invalid.",
    );
  }
  // D0-B supports only a single controlled Desktop/Daemon/Web release tuple. The exact string
  // match intentionally includes prerelease and build metadata; cross-release compatibility
  // requires explicit protocol tests and a later reviewed matrix.
  if (parsed.data.daemonVersion !== requirements.productVersion) {
    return incompatible(
      "DAEMON_PRODUCT_VERSION_INCOMPATIBLE",
      "The local Daemon does not belong to this Desktop release.",
    );
  }

  const unsupportedRequired = requirements.requiredCapabilities.filter(
    (capability) =>
      desktopHostCapabilitySet.has(capability) && !implementedDesktopCapabilitySet.has(capability),
  );
  if (unsupportedRequired.length > 0) {
    return incompatible(
      "DESKTOP_CAPABILITY_NOT_IMPLEMENTED",
      "This Desktop release does not implement a required Daemon security capability.",
      unsupportedRequired,
    );
  }

  const missingRequired = requirements.requiredCapabilities.filter(
    (capability) => parsed.data.capabilities[capability] !== true,
  );
  if (missingRequired.length > 0) {
    return incompatible(
      "DAEMON_CAPABILITY_MISSING",
      "The local Daemon does not provide a capability required by this Desktop release.",
      missingRequired,
    );
  }

  const optional = requirements.optionalCapabilities ?? [];
  const availableOptionalCapabilities = optional.filter(
    (capability) =>
      parsed.data.capabilities[capability] === true &&
      (!desktopHostCapabilitySet.has(capability) ||
        implementedDesktopCapabilitySet.has(capability)),
  );
  const unavailableOptionalCapabilities = optional.filter(
    (capability) => !availableOptionalCapabilities.includes(capability),
  );
  return {
    status: "COMPATIBLE",
    canEnterWorkspace: true,
    availableOptionalCapabilities,
    unavailableOptionalCapabilities,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSemVer(value: string): boolean {
  return value.length <= 256 && semverPattern.test(value);
}

function incompatible(
  code: DesktopCompatibilityErrorCode,
  safeReason: string,
  missingCapabilities: readonly DesktopDaemonCapability[] = [],
): DesktopIncompatibleResult {
  return {
    status: "INCOMPATIBLE",
    canEnterWorkspace: false,
    code,
    safeReason,
    missingCapabilities,
  };
}
