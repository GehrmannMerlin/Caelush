declare const __CAELUSH_BUILD_CONFIG__: string;

export interface DesktopBuildConfiguration {
  readonly production: boolean;
  readonly cloudOrigin: string;
  readonly offlinePublicKeys: Readonly<Record<string, string>>;
  readonly externalHttpsHosts: readonly string[];
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
