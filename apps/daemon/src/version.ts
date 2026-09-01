import { readFileSync } from "node:fs";

interface PackageMetadata {
  readonly version?: unknown;
}

function readPackageVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  const metadata = JSON.parse(readFileSync(packageUrl, "utf8")) as PackageMetadata;
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error("daemon package version is unavailable");
  }
  return metadata.version;
}

export const DAEMON_VERSION = readPackageVersion();
