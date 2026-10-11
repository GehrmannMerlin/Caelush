import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
const BUILD_PURPOSES = new Set(["development", "internal-test", "production"]);
const CHANNELS = new Set(["dev", "beta", "stable"]);
const INTERNAL_TEST_KEY_ID_PREFIX = "d6_test_";

export function resolveDesktopBuildConfiguration(environment) {
  const channel = environment.CAELUSH_DESKTOP_CHANNEL ?? "dev";
  if (!CHANNELS.has(channel)) {
    throw new Error("CAELUSH_DESKTOP_CHANNEL must be dev, beta, or stable.");
  }

  const requestedPurpose = environment.CAELUSH_DESKTOP_BUILD_PURPOSE;
  if (requestedPurpose !== undefined && !BUILD_PURPOSES.has(requestedPurpose)) {
    throw new Error(
      "CAELUSH_DESKTOP_BUILD_PURPOSE must be development, internal-test, or production.",
    );
  }
  const productionRequired = environment.NODE_ENV === "production" || channel === "stable";
  if (productionRequired && requestedPurpose === "development") {
    throw new Error("BUILD_PURPOSE_DOWNGRADE_FORBIDDEN");
  }
  if (channel === "stable" && requestedPurpose === "internal-test") {
    throw new Error("STABLE_INTERNAL_TEST_BUILD_FORBIDDEN");
  }

  const purpose = requestedPurpose ?? (productionRequired ? "production" : "development");
  const production = purpose !== "development";
  if (purpose === "internal-test" && channel !== "dev") {
    throw new Error("INTERNAL_TEST_CHANNEL_MUST_BE_DEV");
  }

  const cloudOrigin =
    environment.CAELUSH_CLOUD_ORIGIN ?? (purpose === "development" ? "http://127.0.0.1:8000" : "");
  const allowedCloudHosts = parseList(environment.CAELUSH_CLOUD_ALLOWED_HOSTS);
  const offlinePublicKeys = parseKeyring(environment.CAELUSH_OFFLINE_TRUSTED_KEYS_JSON);
  if (purpose === "production" && !environment.CAELUSH_CLOUD_ORIGIN) {
    throw new Error("PRODUCTION_CLOUD_ORIGIN_REQUIRED");
  }
  if (purpose === "internal-test" && !environment.CAELUSH_CLOUD_ORIGIN) {
    throw new Error("INTERNAL_TEST_LOOPBACK_REQUIRED");
  }
  const origin = parseCloudOrigin(cloudOrigin);

  if (purpose === "production") {
    if (origin.protocol !== "https:") throw new Error("PRODUCTION_HTTPS_REQUIRED");
    if (!allowedCloudHosts.includes(origin.hostname.toLowerCase())) {
      throw new Error("PRODUCTION_HOST_ALLOWLIST_REQUIRED");
    }
    if (Object.keys(offlinePublicKeys).length === 0) {
      throw new Error("PRODUCTION_TRUSTED_KEY_REQUIRED");
    }
    if (
      Object.keys(offlinePublicKeys).some((keyId) => keyId.startsWith(INTERNAL_TEST_KEY_ID_PREFIX))
    ) {
      throw new Error("PRODUCTION_INTERNAL_TEST_KEY_FORBIDDEN");
    }
  } else if (purpose === "internal-test") {
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") {
      throw new Error("INTERNAL_TEST_LOOPBACK_REQUIRED");
    }
    if (
      Object.keys(offlinePublicKeys).length === 0 ||
      Object.keys(offlinePublicKeys).some((keyId) => !keyId.startsWith(INTERNAL_TEST_KEY_ID_PREFIX))
    ) {
      throw new Error("INTERNAL_TEST_KEY_ID_REQUIRED");
    }
    if (allowedCloudHosts.some((host) => host !== "127.0.0.1" && host !== "localhost")) {
      throw new Error("INTERNAL_TEST_HOST_ALLOWLIST_INVALID");
    }
  } else if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")
  ) {
    throw new Error("DEVELOPMENT_CLOUD_ORIGIN_MUST_BE_HTTPS_OR_LOOPBACK");
  }

  const trustedUpdatePublicKeys = parseKeyring(environment.CAELUSH_UPDATE_TRUSTED_KEYS_JSON);
  const allowedUpdateReleaseHosts = parseList(environment.CAELUSH_UPDATE_RELEASE_HOSTS);
  const internalTestUpdateCa = environment.CAELUSH_UPDATE_TEST_CA_PEM ?? null;
  const updateKeys = Object.keys(trustedUpdatePublicKeys);
  if (
    Object.values(trustedUpdatePublicKeys).some((key) =>
      Object.values(offlinePublicKeys).includes(key),
    )
  ) {
    throw new Error("UPDATE_OFFLINE_KEY_REUSE_FORBIDDEN");
  }
  if (
    allowedUpdateReleaseHosts.some(
      (host) =>
        isIP(host) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host),
    )
  ) {
    throw new Error("UPDATE_HOST_ALLOWLIST_INVALID");
  }
  if (purpose === "production") {
    if (updateKeys.length === 0 || allowedUpdateReleaseHosts.length === 0)
      throw new Error("PRODUCTION_UPDATE_TRUST_REQUIRED");
    if (
      updateKeys.some((key) => /test/i.test(key)) ||
      internalTestUpdateCa ||
      allowedUpdateReleaseHosts.some(
        (host) => !host.includes(".") || /\.(test|invalid|localhost|local)$/.test(host),
      )
    ) {
      throw new Error("PRODUCTION_UPDATE_TEST_TRUST_FORBIDDEN");
    }
  } else if (purpose === "internal-test" && updateKeys.length > 0) {
    if (
      updateKeys.some((key) => !key.startsWith("d72_test_")) ||
      allowedUpdateReleaseHosts.some((host) => host !== "localhost") ||
      allowedUpdateReleaseHosts.length !== 1 ||
      !internalTestUpdateCa
    ) {
      throw new Error("INTERNAL_TEST_UPDATE_TRUST_INVALID");
    }
  } else if (internalTestUpdateCa) throw new Error("UPDATE_TEST_TLS_REQUIRES_INTERNAL_BUILD");
  if (internalTestUpdateCa) {
    if (
      internalTestUpdateCa.length > 16384 ||
      !new X509Certificate(internalTestUpdateCa).subject.includes("localhost")
    )
      throw new Error("INTERNAL_TEST_UPDATE_CA_INVALID");
  }
  return Object.freeze({
    purpose,
    production,
    channel,
    cloudOrigin,
    offlinePublicKeys,
    distributionTrustProfile: "PRIVATE_UNSIGNED",
    trustedUpdatePublicKeys,
    allowedUpdateReleaseHosts: Object.freeze(allowedUpdateReleaseHosts),
    updateChannel: channel,
    internalTestUpdateCa,
    externalHttpsHosts: Object.freeze(["github.com", "www.caelush.com"]),
  });
}

function parseCloudOrigin(cloudOrigin) {
  if (typeof cloudOrigin !== "string" || cloudOrigin.length === 0) {
    throw new Error("CLOUD_ORIGIN_REQUIRED");
  }
  let origin;
  try {
    origin = new URL(cloudOrigin);
  } catch {
    throw new Error("CAELUSH_CLOUD_ORIGIN_MUST_BE_ABSOLUTE");
  }
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("CAELUSH_CLOUD_ORIGIN_MUST_CONTAIN_ONLY_AN_ORIGIN");
  }
  return origin;
}

function parseList(value = "") {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function parseKeyring(source = "{}") {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(
      "CAELUSH_OFFLINE_TRUSTED_KEYS_JSON must be a JSON object of keyId to raw Ed25519 public key.",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CAELUSH_OFFLINE_TRUSTED_KEYS_JSON must be a JSON object.");
  }
  const result = {};
  for (const [keyId, encoded] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) ||
      typeof encoded !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(encoded)
    ) {
      throw new Error("The Desktop build trust keyring contains an invalid key entry.");
    }
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== encoded) {
      throw new Error("The Desktop build trust keyring contains an invalid Ed25519 key.");
    }
    result[keyId] = encoded;
  }
  return Object.freeze(result);
}
