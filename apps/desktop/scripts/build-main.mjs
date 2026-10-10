import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production =
  process.env.NODE_ENV === "production" || process.env.CAELUSH_DESKTOP_CHANNEL === "stable";
const cloudOrigin = process.env.CAELUSH_CLOUD_ORIGIN ?? (production ? "" : "http://127.0.0.1:8000");
const allowedCloudHosts = parseList(process.env.CAELUSH_CLOUD_ALLOWED_HOSTS);
const offlinePublicKeys = parseKeyring(process.env.CAELUSH_OFFLINE_TRUSTED_KEYS_JSON);
const externalHttpsHosts = ["github.com", "www.caelush.com"];

validateConfiguration();
await mkdir(path.join(appRoot, "dist", "main"), { recursive: true });
await mkdir(path.join(appRoot, "dist", "preload"), { recursive: true });

const compiledConfiguration = {
  production,
  cloudOrigin,
  offlinePublicKeys,
  externalHttpsHosts,
};
const define = { __CAELUSH_BUILD_CONFIG__: JSON.stringify(JSON.stringify(compiledConfiguration)) };

await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  external: ["electron"],
  sourcemap: true,
  define,
});

await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/preload/api.cts"],
  outfile: "dist/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});

process.stdout.write(
  `Desktop Main built (${production ? "production" : "development"}; offline keys: ${String(Object.keys(offlinePublicKeys).length)}).\n`,
);

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
      !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
      typeof encoded !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(encoded)
    ) {
      throw new Error("The Desktop build trust keyring contains an invalid key entry.");
    }
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== encoded) {
      throw new Error("The Desktop build trust keyring contains an invalid Ed25519 key.");
    }
    result[keyId] = encoded;
  }
  return result;
}

function validateConfiguration() {
  if (!cloudOrigin) throw new Error("Production Desktop builds require CAELUSH_CLOUD_ORIGIN.");
  let origin;
  try {
    origin = new URL(cloudOrigin);
  } catch {
    throw new Error("CAELUSH_CLOUD_ORIGIN must be an absolute URL origin.");
  }
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("CAELUSH_CLOUD_ORIGIN must contain only an origin.");
  }
  if (production) {
    if (origin.protocol !== "https:")
      throw new Error("Production Desktop Cloud origin must use HTTPS.");
    if (!allowedCloudHosts.includes(origin.hostname.toLowerCase())) {
      throw new Error(
        "Production CAELUSH_CLOUD_ORIGIN hostname must appear in CAELUSH_CLOUD_ALLOWED_HOSTS.",
      );
    }
    if (Object.keys(offlinePublicKeys).length === 0) {
      throw new Error(
        "Production Desktop builds require at least one pinned Offline Grant public key.",
      );
    }
  } else if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")
  ) {
    throw new Error(
      "Development Cloud origin must use HTTPS or the explicit 127.0.0.1 loopback service.",
    );
  }
}
