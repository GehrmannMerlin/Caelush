export const SUPPORTED_PLATFORM_MATRIX = Object.freeze([
  { platform: "win32", arch: "x64", label: "Windows x64" },
  { platform: "linux", arch: "x64", label: "Linux x64" },
  { platform: "darwin", arch: "arm64", label: "macOS arm64" },
  { platform: "darwin", arch: "x64", label: "macOS x64" },
] as const);

export type SupportedPlatform = (typeof SUPPORTED_PLATFORM_MATRIX)[number];

export function nodeVersionInRange(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return false;
  return Number(match[1]) === 24;
}

export function isSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return SUPPORTED_PLATFORM_MATRIX.some(
    (entry) => entry.platform === platform && entry.arch === arch,
  );
}

export function currentPlatformLabel(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return (
    SUPPORTED_PLATFORM_MATRIX.find((entry) => entry.platform === platform && entry.arch === arch)
      ?.label ?? `${platform} ${arch} (unsupported)`
  );
}
