export interface DesktopResourceFile {
  readonly path: string;
  readonly fileType: string;
  readonly size: number;
  readonly sha256: string;
  readonly runtimeIdentity: string;
}

export interface DesktopResourceManifest {
  readonly schemaVersion: 1;
  readonly product: "Caelush";
  readonly productVersion: string;
  readonly channel: "dev" | "beta" | "stable";
  readonly platform: "win32";
  readonly architecture: "x64";
  readonly electronVersion: string;
  readonly daemonVersion: string;
  readonly apiVersion: "v1";
  readonly protocolVersion: 1;
  readonly nodeVersion: string;
  readonly nodeExecutableSha256: string;
  readonly webAssetDigest: string;
  readonly desktopAssetDigest: string;
  readonly nativeModules: readonly {
    readonly name: string;
    readonly version: string;
    readonly platform: "win32";
    readonly architecture: "x64";
    readonly nodeAbi: string;
    readonly napiVersion: string;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
  }[];
  readonly sandboxRunner: {
    readonly path: string;
    readonly controlProtocolVersion: 1;
    readonly platform: "windows";
    readonly architecture: "x64";
    readonly sha256: string;
    readonly providers: readonly ["windows-acl-restricted-token"];
  };
  readonly requiredCapabilities: readonly string[];
  readonly resourceFiles: readonly DesktopResourceFile[];
  readonly resourceSetDigest: string;
}

export declare const DESKTOP_RESOURCE_MANIFEST_FILENAME: string;
export declare function addDesktopArchiveResource(
  manifestInput: unknown,
  archivePath: string,
): Promise<DesktopResourceManifest>;
export declare function validateDesktopResourceManifest(input: unknown): DesktopResourceManifest;
export declare function assertDesktopResourceManifestCompatible(
  manifest: unknown,
  expected: Partial<DesktopResourceManifest>,
): DesktopResourceManifest;
export declare function computeResourceSetDigest(
  files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[],
): string;
export declare function createDirectoryDigest(directoryPath: string): Promise<{
  readonly digest: string;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}>;
export declare function verifyDesktopResourceFiles(
  manifest: unknown,
  resourceRoot: string,
): Promise<{ readonly verifiedFiles: number; readonly resourceSetDigest: string }>;
export declare function verifyDesktopAssetDigest(
  expectedDigest: string,
  desktopAssetRoot: string,
): Promise<string>;
