export interface InstallRegistryValue {
  readonly scope?: unknown;
  readonly keyPath?: unknown;
  readonly InstallLocation?: unknown;
}

export interface UninstallRegistryValue {
  readonly scope?: unknown;
  readonly keyPath?: unknown;
  readonly DisplayName?: unknown;
  readonly DisplayVersion?: unknown;
  readonly UninstallString?: unknown;
}

export interface InstallRegistrySnapshot {
  readonly install?: InstallRegistryValue | null;
  readonly uninstall?: UninstallRegistryValue | null;
}

export declare function desktopInstallRegistryKey(): string;
export declare function desktopUninstallRegistryKey(): string;

export declare function isInstalledAgentEntryReady(state: unknown): boolean;

export declare function buildPersistentBrowserFixtureCookie(
  value: string,
  nowMs?: number,
): Readonly<{
  name: "caelush_d6_profile_fixture";
  value: string;
  url: "https://example.com/";
  secure: true;
  httpOnly: true;
  sameSite: "Lax";
  expires: number;
}>;

export declare function findCompletedInstalledSession<
  T extends { latestRun?: { status: string } },
>(response: { items: T[] }): T | null;

export declare function normalizeRegistryRegistrationSnapshot(
  snapshot: unknown,
): InstallRegistrySnapshot;

export declare function classifyD5TestMainSmokeResult(
  exitCode: number | null,
  output: string,
): "PASS" | "PROFILE_SWITCH_NOT_RUN_SECURITY_COMPONENT_UNAVAILABLE" | "FAIL";

export declare function assertInstallRegistration(
  snapshot: InstallRegistrySnapshot,
  expectedInstallRoot: string,
  expectedVersion?: string,
): Readonly<{ scope: "HKCU"; installRoot: string }>;

export declare function buildNsisInstallArguments(installRoot: string): Readonly<{
  args: readonly ["/S", "/currentuser", string];
  windowsVerbatimArguments: true;
}>;

export declare function buildNsisUninstallArguments(installRoot: string): Readonly<{
  args: readonly ["/S", "/currentuser", string];
  windowsVerbatimArguments: true;
}>;

export declare function createPersistentSnapshotRecord(
  rootId: string,
  root: string,
  filePath: string,
  fileHash: string,
): Readonly<{ rootId: string; relativePath: string; fileHash: string }>;

export declare function assertSuccessfulProcessExit(
  exitCode: number | null,
  processName: string,
): void;

export declare function assertSuccessfulShutdown(input: {
  readonly closeCompleted: boolean;
  readonly daemonExitCode: number | null;
  readonly persistenceVerified: boolean;
}): void;
