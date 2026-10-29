import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopBuildConfiguration } from "./desktop-build-config.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "..", "..");
const REQUIRED_CONFIG_FIELDS = [
  "cloudOrigin",
  "cloudAllowedHosts",
  "offlineTrustedKeys",
  "updateTrustedKeys",
  "updateReleaseHosts",
  "outputRoot",
];
const OFFICIAL_CLOUD_ORIGIN = "https://api.caelush.com.cn";
const OFFICIAL_CLOUD_HOSTS = Object.freeze(["api.caelush.com.cn"]);
const OFFICIAL_RELEASE_HOSTS = Object.freeze(["releases.caelush.com.cn"]);
const SAFE_INHERITED_CAELUSH_FIELDS = new Set(["CAELUSH_NODE_24_PATH"]);

/**
 * Read and validate the external, public-only configuration for a stable Windows release.
 * Private signing material is deliberately not part of the accepted schema.
 */
export async function loadDesktopReleaseConfiguration(configPath, inheritedEnvironment = {}) {
  if (typeof configPath !== "string" || configPath.trim().length === 0) {
    throw new Error("RELEASE_CONFIG_PATH_REQUIRED");
  }

  let config;
  try {
    config = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
  } catch {
    throw new Error("RELEASE_CONFIG_READ_FAILED");
  }
  validateConfigShape(config);

  if (config.cloudOrigin !== OFFICIAL_CLOUD_ORIGIN) {
    throw new Error("RELEASE_CLOUD_ORIGIN_INVALID");
  }
  const cloudAllowedHosts = normalizeHosts(config.cloudAllowedHosts, "RELEASE_CLOUD_HOSTS_INVALID");
  const updateReleaseHosts = normalizeHosts(
    config.updateReleaseHosts,
    "RELEASE_UPDATE_HOSTS_INVALID",
  );
  if (!sameValues(cloudAllowedHosts, OFFICIAL_CLOUD_HOSTS)) {
    throw new Error("RELEASE_CLOUD_HOSTS_INVALID");
  }
  if (!sameValues(updateReleaseHosts, OFFICIAL_RELEASE_HOSTS)) {
    throw new Error("RELEASE_UPDATE_HOSTS_INVALID");
  }

  const offlineTrustedKeys = normalizeKeyring(config.offlineTrustedKeys);
  const updateTrustedKeys = normalizeKeyring(config.updateTrustedKeys);
  const outputRoot = validateOutputRoot(config.outputRoot);
  const environment = makeReleaseEnvironment(inheritedEnvironment, {
    cloudOrigin: config.cloudOrigin,
    cloudAllowedHosts,
    offlineTrustedKeys,
    updateTrustedKeys,
    updateReleaseHosts,
  });

  // Reuse the same production trust checks as the Electron Main build.
  resolveDesktopBuildConfiguration(environment);

  const publicConfiguration = {
    cloudOrigin: config.cloudOrigin,
    cloudAllowedHosts,
    offlineTrustedKeys,
    updateTrustedKeys,
    updateReleaseHosts,
    outputRoot,
  };
  const configurationFingerprint = createHash("sha256")
    .update(stableJson(publicConfiguration))
    .digest("hex");

  return Object.freeze({
    environment: Object.freeze(environment),
    outputRoot,
    configurationFingerprint,
  });
}

function validateConfigShape(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("RELEASE_CONFIG_SCHEMA_INVALID");
  }
  const keys = Object.keys(config).sort();
  if (!sameValues(keys, [...REQUIRED_CONFIG_FIELDS].sort())) {
    throw new Error("RELEASE_CONFIG_SCHEMA_INVALID");
  }
  if (
    typeof config.cloudOrigin !== "string" ||
    typeof config.outputRoot !== "string" ||
    !Array.isArray(config.cloudAllowedHosts) ||
    !Array.isArray(config.updateReleaseHosts) ||
    !isRecord(config.offlineTrustedKeys) ||
    !isRecord(config.updateTrustedKeys)
  ) {
    throw new Error("RELEASE_CONFIG_SCHEMA_INVALID");
  }
}

function normalizeHosts(hosts, errorCode) {
  const normalized = hosts.map((host) => {
    if (typeof host !== "string" || host.trim().length === 0 || host.includes(",")) {
      throw new Error(errorCode);
    }
    return host.trim().toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(errorCode);
  return normalized.sort();
}

function normalizeKeyring(keyring) {
  const entries = Object.entries(keyring).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([keyId, key]) => keyId.trim() !== keyId || typeof key !== "string")) {
    throw new Error("RELEASE_CONFIG_SCHEMA_INVALID");
  }
  return Object.fromEntries(entries);
}

function makeReleaseEnvironment(inherited, config) {
  const intended = {
    NODE_ENV: "production",
    CAELUSH_DESKTOP_BUILD_PURPOSE: "production",
    CAELUSH_DESKTOP_CHANNEL: "stable",
    CAELUSH_CLOUD_ORIGIN: config.cloudOrigin,
    CAELUSH_CLOUD_ALLOWED_HOSTS: config.cloudAllowedHosts.join(","),
    CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: stableJson(config.offlineTrustedKeys),
    CAELUSH_UPDATE_TRUSTED_KEYS_JSON: stableJson(config.updateTrustedKeys),
    CAELUSH_UPDATE_RELEASE_HOSTS: config.updateReleaseHosts.join(","),
    CAELUSH_DESKTOP_INCLUDE_SOURCEMAPS: "false",
  };

  if (String(inherited.CAELUSH_DESKTOP_INCLUDE_SOURCEMAPS ?? "").toLowerCase() === "true") {
    throw new Error("RELEASE_SOURCEMAPS_FORBIDDEN");
  }
  if (inherited.CAELUSH_UPDATE_TEST_CA_PEM) {
    throw new Error("RELEASE_ENV_CONFLICT:CAELUSH_UPDATE_TEST_CA_PEM");
  }
  for (const key of [
    "CAELUSH_DESKTOP_OUTPUT_ROOT",
    "CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT",
    "CAELUSH_DESKTOP_REUSE_RESOURCES_FROM",
  ]) {
    if (inherited[key] !== undefined && inherited[key] !== "") {
      throw new Error(`RELEASE_ENV_CONFLICT:${key}`);
    }
  }
  for (const [key, expected] of Object.entries(intended)) {
    if (inherited[key] === undefined) continue;
    if (key === "CAELUSH_OFFLINE_TRUSTED_KEYS_JSON" || key === "CAELUSH_UPDATE_TRUSTED_KEYS_JSON") {
      if (!keyringsEqual(inherited[key], expected)) throw new Error(`RELEASE_ENV_CONFLICT:${key}`);
    } else if (key === "CAELUSH_CLOUD_ALLOWED_HOSTS" || key === "CAELUSH_UPDATE_RELEASE_HOSTS") {
      if (!sameValues(splitHosts(inherited[key]), splitHosts(expected))) {
        throw new Error(`RELEASE_ENV_CONFLICT:${key}`);
      }
    } else if (inherited[key] !== expected) {
      throw new Error(`RELEASE_ENV_CONFLICT:${key}`);
    }
  }

  const environment = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => {
      if (!key.startsWith("CAELUSH_")) return true;
      if (Object.hasOwn(intended, key)) return false;
      return SAFE_INHERITED_CAELUSH_FIELDS.has(key);
    }),
  );
  Object.assign(environment, intended);
  return environment;
}

function keyringsEqual(left, right) {
  try {
    return stableJson(JSON.parse(left)) === stableJson(JSON.parse(right));
  } catch {
    return false;
  }
}

function splitHosts(value) {
  return typeof value === "string"
    ? [
        ...new Set(
          value
            .split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        ),
      ].sort()
    : [];
}

function validateOutputRoot(value) {
  const outputRoot = path.win32.resolve(value);
  const driveRoot = path.win32.parse(outputRoot).root;
  if (
    !path.win32.isAbsolute(value) ||
    driveRoot.toLowerCase() !== "d:\\" ||
    outputRoot.toLowerCase() === driveRoot.toLowerCase() ||
    isPathInside(outputRoot, REPOSITORY_ROOT) ||
    isPathInside(outputRoot, resolvePrimaryCheckoutRoot())
  ) {
    throw new Error("RELEASE_OUTPUT_ROOT_INVALID");
  }
  return outputRoot;
}

function resolvePrimaryCheckoutRoot() {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim().length === 0) {
    return REPOSITORY_ROOT;
  }
  const commonDirectory = path.win32.resolve(REPOSITORY_ROOT, result.stdout.trim());
  return path.win32.dirname(commonDirectory);
}

function isPathInside(candidate, parent) {
  const relative = path.win32.relative(path.win32.resolve(parent), path.win32.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.win32.sep}`) &&
      !path.win32.isAbsolute(relative))
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

async function rejectReparsePointsInExistingPath(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("RELEASE_OUTPUT_ROOT_INVALID");
      }
      if (path.dirname(current) === current) return;
      current = path.dirname(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (path.dirname(current) === current) return;
      current = path.dirname(current);
    }
  }
}

// Exported for the release entry point so it can validate the output root before creating a build.
export async function assertDesktopReleaseOutputRootSafe(outputRoot) {
  validateOutputRoot(outputRoot);
  await rejectReparsePointsInExistingPath(outputRoot);
}
