import { createPublicKey } from "node:crypto";
import type { UpdateTrust } from "./cloud/update-policy.js";
declare const __CAELUSH_BUILD_CONFIG__: string;

export interface DesktopBuildConfiguration {
  readonly purpose: "development" | "internal-test" | "production";
  readonly production: boolean;
  readonly channel: "dev" | "beta" | "stable";
  readonly cloudOrigin: string;
  readonly offlinePublicKeys: Readonly<Record<string, string>>;
  readonly externalHttpsHosts: readonly string[];
  readonly distributionTrustProfile: "PRIVATE_UNSIGNED";
  readonly trustedUpdatePublicKeys: Readonly<Record<string, string>>;
  readonly allowedUpdateReleaseHosts: readonly string[];
  readonly updateChannel: "dev" | "beta" | "stable";
  readonly internalTestUpdateCa: string | null;
}

export const BUILD_CONFIGURATION = Object.freeze(
  JSON.parse(__CAELUSH_BUILD_CONFIG__) as DesktopBuildConfiguration,
);

export function trustedOfflineKeys(): Readonly<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [keyId, encoded] of Object.entries(BUILD_CONFIGURATION.offlinePublicKeys)) {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) continue;
    result[keyId] = decoded;
  }
  return Object.freeze(result);
}

export function trustedUpdateConfiguration(): UpdateTrust {
  const publicKeys: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, encoded] of Object.entries(BUILD_CONFIGURATION.trustedUpdatePublicKeys)) {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(encoded, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    publicKeys[id] = key.export({ format: "pem", type: "spki" }).toString();
  }
  return Object.freeze({
    publicKeys: Object.freeze(publicKeys),
    allowedReleaseHosts: BUILD_CONFIGURATION.allowedUpdateReleaseHosts,
    channel: BUILD_CONFIGURATION.updateChannel,
    ...(BUILD_CONFIGURATION.purpose === "internal-test" && BUILD_CONFIGURATION.internalTestUpdateCa
      ? {
          internalTestCa: BUILD_CONFIGURATION.internalTestUpdateCa,
          internalTestLoopback: true,
        }
      : {}),
  });
}
